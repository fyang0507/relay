// Filesystem watcher + JSONL tail reader.
// See relay.md §Architecture and §Startup and backfill behavior.
//
// Two layers:
//  1. Directory watchers: one chokidar watcher per source glob, emits
//     'fileDiscovered' for each file matching the glob (existing and new).
//  2. File tailers: per tracked file, stream newline-terminated JSON lines
//     from a starting byte offset, emitting 'line' events with offsets the
//     core dispatcher can persist as the new durable state.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { JsonlEntry, SourceConfig } from './types.js';

export interface LineEvent {
  filePath: string;
  sourceName: string;
  lineStartOffset: number;
  lineEndOffset: number;
  parsed: JsonlEntry | null;
  raw: string;
}

interface TailState {
  sourceName: string;
  offset: number;     // next byte to read
  lastSize: number;   // last-known file size
  pending: string;    // partial trailing data awaiting a newline
  reading: boolean;   // guard against re-entrant reads on overlapping 'change' events
  changedWhileReading: boolean;
  stopped: boolean;
}

// Expand a leading `~` to the user's home directory.
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Split a glob into (baseDir, globPart). baseDir is the longest leading path
// with no glob metacharacters; globPart is the remainder (may be empty).
function splitGlob(glob: string): { baseDir: string; pattern: string } {
  const expanded = expandHome(glob);
  const parts = expanded.split(path.sep);
  const baseParts: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    if (/[*?[\]{}]/.test(parts[i])) break;
    baseParts.push(parts[i]);
  }
  const baseDir = baseParts.join(path.sep) || path.sep;
  const pattern = parts.slice(i).join(path.sep);
  return { baseDir, pattern };
}

// Convert a glob pattern (supporting *, ?, **) into an anchored RegExp. Empty
// pattern matches everything (used when the glob has no meta part).
function globToRegex(pattern: string): RegExp {
  if (pattern === '') return /^.*$/;
  const sepClass = `[^${path.sep === '\\' ? '\\\\' : path.sep}]`;
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pattern[i] === path.sep) i++;
    } else if (c === '*') {
      re += `${sepClass}*`;
      i++;
    } else if (c === '?') {
      re += sepClass;
      i++;
    } else if ('.+^$(){}|\\/'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

// Public event map (documented here for maintainers; EventEmitter is untyped).
//   'fileDiscovered' (filePath: string, sourceName: string)
//   'line'           (event: LineEvent)
//   'truncated'      (filePath: string)
//   'error'          (err: Error)
export class RelayWatcher extends EventEmitter {
  private sources: SourceConfig[];
  private dirWatchers: FSWatcher[] = [];
  private fileWatchers = new Map<string, FSWatcher>();
  private tails = new Map<string, TailState>();
  private started = false;
  private stopped = false;

  constructor(sources: SourceConfig[]) {
    super();
    this.sources = sources;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const source of this.sources) {
      const { baseDir, pattern } = splitGlob(source.pathGlob);
      const regex = globToRegex(pattern);

      // Ensure the base directory exists; chokidar silently no-ops on a missing
      // path, but we still want a deterministic watcher lifecycle.
      try {
        await fsp.mkdir(baseDir, { recursive: true });
      } catch (err) {
        this.emit('error', err as Error);
      }

      const watcher = chokidar.watch(baseDir, {
        ignoreInitial: false,
        persistent: true,
        depth: pattern.includes('**') ? undefined : pattern.split(path.sep).length - 1,
      });

      watcher.on('add', (filePath: string) => {
        const rel = path.relative(baseDir, filePath);
        if (!regex.test(rel)) return;
        this.emit('fileDiscovered', filePath, source.name);
      });

      watcher.on('error', (err: unknown) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });

      this.dirWatchers.push(watcher);
    }
  }

  trackFile(filePath: string, startOffset: number, sourceName: string): void {
    if (this.tails.has(filePath)) return; // already tracking

    const state: TailState = {
      sourceName,
      offset: startOffset,
      lastSize: startOffset,
      pending: '',
      reading: false,
      changedWhileReading: false,
      stopped: false,
    };
    this.tails.set(filePath, state);

    // Kick off the initial catch-up read, then rely on 'change' events.
    void this.drain(filePath);

    const watcher = chokidar.watch(filePath, {
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on('change', () => {
      void this.drain(filePath);
    });
    watcher.on('error', (err: unknown) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
    this.fileWatchers.set(filePath, watcher);
  }

  untrackFile(filePath: string): void {
    const state = this.tails.get(filePath);
    if (state) state.stopped = true;
    this.tails.delete(filePath);
    const watcher = this.fileWatchers.get(filePath);
    if (watcher) {
      this.fileWatchers.delete(filePath);
      void watcher.close();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const closers: Promise<void>[] = [];
    for (const w of this.dirWatchers) closers.push(w.close());
    for (const w of this.fileWatchers.values()) closers.push(w.close());
    this.dirWatchers = [];
    this.fileWatchers.clear();
    for (const state of this.tails.values()) state.stopped = true;
    this.tails.clear();
    await Promise.all(closers);
  }

  // Read any newly-appended bytes for a tracked file and emit line events.
  // Guards against concurrent reads — if a change arrives while a read is in
  // flight, we schedule another pass at the end.
  private async drain(filePath: string): Promise<void> {
    const state = this.tails.get(filePath);
    if (!state || state.stopped) return;
    if (state.reading) {
      state.changedWhileReading = true;
      return;
    }
    state.reading = true;
    try {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch (err) {
        // File not yet present or already gone — nothing to do.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          this.emit('error', err as Error);
        }
        return;
      }

      if (stat.size < state.lastSize) {
        // Truncation / rotation — V2 territory. Warn and stop tailing.
        state.stopped = true;
        this.tails.delete(filePath);
        const watcher = this.fileWatchers.get(filePath);
        if (watcher) {
          this.fileWatchers.delete(filePath);
          void watcher.close();
        }
        this.emit('truncated', filePath);
        return;
      }

      if (stat.size === state.offset) {
        state.lastSize = stat.size;
        return;
      }

      const fh = await fsp.open(filePath, 'r');
      try {
        const toRead = stat.size - state.offset;
        const buf = Buffer.alloc(toRead);
        let readTotal = 0;
        while (readTotal < toRead) {
          const { bytesRead } = await fh.read(
            buf,
            readTotal,
            toRead - readTotal,
            state.offset + readTotal,
          );
          if (bytesRead === 0) break;
          readTotal += bytesRead;
        }
        const chunk = buf.subarray(0, readTotal).toString('utf8');
        this.processChunk(filePath, state, chunk, readTotal);
      } finally {
        await fh.close();
      }

      state.lastSize = stat.size;
    } finally {
      state.reading = false;
      if (state.changedWhileReading && !state.stopped) {
        state.changedWhileReading = false;
        void this.drain(filePath);
      }
    }
  }

  // Walk through newly-read bytes splitting on '\n'. `pending` holds any
  // unterminated trailing data from the previous read. We emit one 'line' event
  // per newline-terminated line and preserve byte offsets into the underlying
  // file so the dispatcher can checkpoint lineEndOffset after a successful
  // deliver.
  private processChunk(
    filePath: string,
    state: TailState,
    chunk: string,
    bytesRead: number,
  ): void {
    // byteOffsetAtChunkStart: the file offset of `chunk[0]` (== state.offset
    // before any consumption). We track remaining bytes; `pending` contributes
    // some bytes at the front.
    const pendingByteLen = Buffer.byteLength(state.pending, 'utf8');
    let combined = state.pending + chunk;
    // The file offset at which `combined[0]` begins:
    const combinedStartOffset = state.offset - pendingByteLen;

    let searchIdx = 0;
    let consumedBytes = 0; // bytes of `combined` consumed into emitted lines
    while (true) {
      const nlIdx = combined.indexOf('\n', searchIdx);
      if (nlIdx === -1) break;
      // Line is combined[consumedBytes .. nlIdx] inclusive of the '\n'.
      const raw = combined.slice(consumedBytes, nlIdx); // without trailing '\n'
      const lineBytesWithoutNl = Buffer.byteLength(raw, 'utf8');
      const lineStartOffset =
        combinedStartOffset + Buffer.byteLength(combined.slice(0, consumedBytes), 'utf8');
      const lineEndOffset = lineStartOffset + lineBytesWithoutNl + 1; // +1 for '\n'

      let parsed: JsonlEntry | null = null;
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') parsed = obj as JsonlEntry;
      } catch {
        parsed = null;
      }

      const event: LineEvent = {
        filePath,
        sourceName: state.sourceName,
        lineStartOffset,
        lineEndOffset,
        parsed,
        raw,
      };
      this.emit('line', event);

      consumedBytes = nlIdx + 1; // advance past '\n'
      searchIdx = consumedBytes;
    }

    // Whatever is after `consumedBytes` in `combined` is unterminated; stash
    // it as pending, and advance state.offset to after everything we read.
    state.pending = combined.slice(consumedBytes);
    state.offset = state.offset + bytesRead;
  }
}

export default RelayWatcher;
