// Unit tests for src/plist.ts. We don't parse the output with a real XML
// parser — a few targeted string checks are enough to catch regressions in
// the plist shape and the escape table.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlist, type PlistSpec } from '../src/plist.ts';

const baseSpec: PlistSpec = {
  label: 'com.fyang0507.relay',
  daemonPath: '/usr/local/bin/node',
  args: ['/Users/me/relay/dist/daemon.js'],
  workingDirectory: '/Users/me/relay',
  stdoutLog: '/Users/me/.relay/daemon.out.log',
  stderrLog: '/Users/me/.relay/daemon.err.log',
};

test('buildPlist produces a well-formed Apple plist document', () => {
  const out = buildPlist(baseSpec);
  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(
    out,
    /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/,
  );
  assert.match(out, /<plist version="1\.0">/);
  assert.match(out, /<dict>/);
  assert.match(out, /<\/dict>/);
  assert.match(out, /<\/plist>/);
});

test('buildPlist includes all required keys', () => {
  const out = buildPlist(baseSpec);
  for (const key of [
    'Label',
    'ProgramArguments',
    'WorkingDirectory',
    'RunAtLoad',
    'KeepAlive',
    'StandardOutPath',
    'StandardErrorPath',
  ]) {
    assert.ok(out.includes(`<key>${key}</key>`), `missing <key>${key}</key>`);
  }
  // Boolean toggles use the self-closing <true/> tag.
  assert.match(
    out,
    /<key>RunAtLoad<\/key>\s*<true\/>/,
    'RunAtLoad should be <true/>',
  );
  assert.match(
    out,
    /<key>KeepAlive<\/key>\s*<true\/>/,
    'KeepAlive should be <true/>',
  );
});

test('buildPlist escapes XML special characters in values', () => {
  const out = buildPlist({
    ...baseSpec,
    label: 'com.example.weird&label',
    workingDirectory: '/tmp/<angle>',
    environment: {
      FOO: 'has " and \' and <> and &',
    },
  });
  // Raw special chars should not appear inside any <string> payload we
  // generated from user input.
  assert.ok(out.includes('com.example.weird&amp;label'));
  assert.ok(out.includes('/tmp/&lt;angle&gt;'));
  assert.ok(out.includes('&quot;'));
  assert.ok(out.includes('&apos;'));
  // And conversely: no raw `&` followed by anything other than an entity
  // reference in the section we care about.
  const lines = out.split('\n');
  for (const line of lines) {
    // Skip the XML declaration, doctype, and plist root — those legitimately
    // contain `<`, `>`, quotes, etc. as part of the XML syntax itself.
    if (
      line.startsWith('<?xml') ||
      line.startsWith('<!DOCTYPE') ||
      line.startsWith('<plist ')
    ) {
      continue;
    }
    // Every `&` inside content must be the start of one of our entities.
    const bareAmp = /&(?!amp;|lt;|gt;|quot;|apos;)/;
    assert.ok(!bareAmp.test(line), `unescaped & in line: ${line}`);
  }
});

test('buildPlist ProgramArguments lists daemonPath first then args in order', () => {
  const out = buildPlist({
    ...baseSpec,
    daemonPath: '/usr/bin/node',
    args: ['/a/daemon.js', '--flag', 'value'],
  });
  // Grab the ProgramArguments array block.
  const match = out.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  assert.ok(match, 'ProgramArguments array missing');
  const body = match![1];
  const strings = [...body.matchAll(/<string>([^<]*)<\/string>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(strings, [
    '/usr/bin/node',
    '/a/daemon.js',
    '--flag',
    'value',
  ]);
});

test('buildPlist omits EnvironmentVariables when not provided', () => {
  const out = buildPlist(baseSpec);
  assert.ok(!out.includes('EnvironmentVariables'));
});

test('buildPlist emits EnvironmentVariables dict when provided', () => {
  const out = buildPlist({
    ...baseSpec,
    environment: { FOO: 'bar', BAZ: 'qux' },
  });
  assert.ok(out.includes('<key>EnvironmentVariables</key>'));
  assert.ok(out.includes('<key>FOO</key>'));
  assert.ok(out.includes('<string>bar</string>'));
  assert.ok(out.includes('<key>BAZ</key>'));
  assert.ok(out.includes('<string>qux</string>'));
});

test('buildPlist is deterministic (same input yields same output)', () => {
  const a = buildPlist({
    ...baseSpec,
    environment: { Z: '1', A: '2', M: '3' },
  });
  const b = buildPlist({
    ...baseSpec,
    environment: { A: '2', M: '3', Z: '1' },
  });
  assert.equal(a, b, 'environment ordering should not affect output');
});
