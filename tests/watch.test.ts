// Tests for RelayWatcher. See src/watch.ts and relay.md §Architecture.
//
// Covers directory discovery (both pre-existing and newly-added files), line
// tailing from a byte offset, append handling, malformed-JSON resilience, and
// the V2-boundary truncation signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayWatcher, type LineEvent } from '../src/watch.ts';
import type { SourceConfig } from '../src/types.ts';

// Chokidar file events can lag on macOS; these delays give fs.watch time to
// propagate before assertions. Keep them in the 100-250ms range per project
// guidance.
const SETTLE_MS = 200;

async function makeTmpDir(label: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `relay-watch-${label}-`));
  return dir;
}

function makeSource(dir: string, name = 'test-src'): SourceConfig {
  return {
    name,
    pathGlob: path.join(dir, '*.jsonl'),
    provider: 'dryrun',
    group: 'grp',
    inboundTypes: [],
    tiers: {},
  };
}

test('discovers pre-existing file in glob on start', async (t) => {
  const dir = await makeTmpDir('pre');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'a.jsonl');
  await fsp.writeFile(filePath, '');

  const watcher = new RelayWatcher([makeSource(dir)]);
  const discovered: string[] = [];
  watcher.on('fileDiscovered', (fp: string) => discovered.push(fp));

  await watcher.start();
  await delay(SETTLE_MS);

  assert.deepEqual(discovered, [filePath]);
  await watcher.stop();
});

test('discovers new file added after start', async (t) => {
  const dir = await makeTmpDir('new');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const watcher = new RelayWatcher([makeSource(dir)]);
  const discovered: string[] = [];
  watcher.on('fileDiscovered', (fp: string) => discovered.push(fp));

  await watcher.start();
  await delay(SETTLE_MS);

  const newFile = path.join(dir, 'b.jsonl');
  await fsp.writeFile(newFile, '');
  await delay(SETTLE_MS);

  assert.ok(discovered.includes(newFile), `expected ${newFile} in ${JSON.stringify(discovered)}`);
  await watcher.stop();
});

test('ignores non-matching files in watch dir', async (t) => {
  const dir = await makeTmpDir('filter');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await fsp.writeFile(path.join(dir, 'note.txt'), 'hello');
  await fsp.writeFile(path.join(dir, 'c.jsonl'), '');

  const watcher = new RelayWatcher([makeSource(dir)]);
  const discovered: string[] = [];
  watcher.on('fileDiscovered', (fp: string) => discovered.push(fp));

  await watcher.start();
  await delay(SETTLE_MS);

  assert.deepEqual(discovered, [path.join(dir, 'c.jsonl')]);
  await watcher.stop();
});

test('tails two pre-existing lines from offset 0', async (t) => {
  const dir = await makeTmpDir('tail2');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'log.jsonl');
  const l1 = JSON.stringify({ type: 'call.placed', timestamp: 't1', id: 1 });
  const l2 = JSON.stringify({ type: 'call.completed', timestamp: 't2', id: 2 });
  await fsp.writeFile(filePath, l1 + '\n' + l2 + '\n');

  const watcher = new RelayWatcher([makeSource(dir)]);
  const lines: LineEvent[] = [];
  watcher.on('line', (ev: LineEvent) => lines.push(ev));

  await watcher.start();
  watcher.trackFile(filePath, 0, 'test-src');
  await delay(SETTLE_MS);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].parsed?.type, 'call.placed');
  assert.equal(lines[0].lineStartOffset, 0);
  assert.equal(lines[0].lineEndOffset, Buffer.byteLength(l1 + '\n'));
  assert.equal(lines[1].parsed?.type, 'call.completed');
  assert.equal(lines[1].lineStartOffset, Buffer.byteLength(l1 + '\n'));
  assert.equal(lines[1].lineEndOffset, Buffer.byteLength(l1 + '\n' + l2 + '\n'));
  assert.equal(lines[1].sourceName, 'test-src');

  await watcher.stop();
});

test('emits line event for appended line after tracking', async (t) => {
  const dir = await makeTmpDir('append');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'log.jsonl');
  const l1 = JSON.stringify({ type: 'a', timestamp: 't1' });
  const l2 = JSON.stringify({ type: 'b', timestamp: 't2' });
  await fsp.writeFile(filePath, l1 + '\n' + l2 + '\n');

  const watcher = new RelayWatcher([makeSource(dir)]);
  const lines: LineEvent[] = [];
  watcher.on('line', (ev: LineEvent) => lines.push(ev));

  await watcher.start();
  watcher.trackFile(filePath, 0, 'test-src');
  await delay(SETTLE_MS);
  assert.equal(lines.length, 2);

  const l3 = JSON.stringify({ type: 'c', timestamp: 't3' });
  await fsp.appendFile(filePath, l3 + '\n');
  await delay(SETTLE_MS);

  assert.equal(lines.length, 3);
  assert.equal(lines[2].parsed?.type, 'c');
  assert.equal(lines[2].raw, l3);

  await watcher.stop();
});

test('malformed JSON yields parsed: null but still emits line', async (t) => {
  const dir = await makeTmpDir('badjson');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'log.jsonl');
  const good = JSON.stringify({ type: 'ok', timestamp: 't1' });
  const bad = '{not valid json';
  await fsp.writeFile(filePath, good + '\n' + bad + '\n');

  const watcher = new RelayWatcher([makeSource(dir)]);
  const lines: LineEvent[] = [];
  const errors: Error[] = [];
  watcher.on('line', (ev: LineEvent) => lines.push(ev));
  watcher.on('error', (err: Error) => errors.push(err));

  await watcher.start();
  watcher.trackFile(filePath, 0, 'test-src');
  await delay(SETTLE_MS);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].parsed?.type, 'ok');
  assert.equal(lines[1].parsed, null);
  assert.equal(lines[1].raw, bad);
  assert.equal(errors.length, 0);

  await watcher.stop();
});

test('truncation emits truncated event and halts tailing', async (t) => {
  const dir = await makeTmpDir('trunc');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'log.jsonl');
  const l1 = JSON.stringify({ type: 'a', timestamp: 't1' });
  const l2 = JSON.stringify({ type: 'b', timestamp: 't2' });
  await fsp.writeFile(filePath, l1 + '\n' + l2 + '\n');

  const watcher = new RelayWatcher([makeSource(dir)]);
  const lines: LineEvent[] = [];
  const truncated: string[] = [];
  watcher.on('line', (ev: LineEvent) => lines.push(ev));
  watcher.on('truncated', (fp: string) => truncated.push(fp));

  await watcher.start();
  watcher.trackFile(filePath, 0, 'test-src');
  await delay(SETTLE_MS);
  assert.equal(lines.length, 2);

  // Shrink the file. truncate() to 0 bytes.
  await fsp.truncate(filePath, 0);
  await delay(SETTLE_MS);

  assert.deepEqual(truncated, [filePath]);

  // After truncation-halt, further appends must not emit new 'line' events.
  const priorLineCount = lines.length;
  const l3 = JSON.stringify({ type: 'c', timestamp: 't3' });
  await fsp.appendFile(filePath, l3 + '\n');
  await delay(SETTLE_MS);
  assert.equal(lines.length, priorLineCount);

  await watcher.stop();
});
