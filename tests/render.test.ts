// Tests for src/render.ts. Covers default rendering, field projection
// (`deliverFields`) and per-field truncation (`deliverFieldMaxChars`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderLine } from '../src/render.ts';
import type { JsonlEntry } from '../src/types.ts';

function parsedEntry(obj: Record<string, unknown>): JsonlEntry {
  return obj as JsonlEntry;
}

test('default render: header + pretty-JSON of the full payload', () => {
  const parsed = parsedEntry({
    type: 'tool_call',
    tool: 'bash',
    args: { cmd: 'ls' },
  });
  const out = renderLine(parsed, JSON.stringify(parsed), 'type');
  assert.match(out, /^\[tool_call\]\n\{/);
  assert.ok(out.includes('"tool": "bash"'));
  assert.ok(out.includes('"args"'));
});

test('missing/non-string tier-key value renders as (no-type)', () => {
  const parsed = parsedEntry({ payload: 'x' });
  const out = renderLine(parsed, '{}', 'type');
  assert.match(out, /^\[\(no-type\)\]\n/);
});

test('deliverFields: projects to listed keys only, drops others', () => {
  const parsed = parsedEntry({
    type: 'tool_call',
    tool: 'bash',
    args: { cmd: 'ls' },
    trace_id: 'abc',
    internal_state: { retries: 0 },
    notes: 'listing',
  });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['tool', 'args', 'notes'],
  });
  assert.ok(out.startsWith('[tool_call]\n'));
  const bodyStart = out.indexOf('\n') + 1;
  const body = JSON.parse(out.slice(bodyStart)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['tool', 'args', 'notes']);
  assert.equal(body.tool, 'bash');
  assert.deepEqual(body.args, { cmd: 'ls' });
  assert.equal(body.notes, 'listing');
});

test('deliverFields: missing keys are silently absent', () => {
  const parsed = parsedEntry({ type: 'heartbeat' });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['tool', 'notes'],
  });
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.deepEqual(body, {});
});

test('deliverFields: preserves tier-key header even when not in the filter', () => {
  const parsed = parsedEntry({ type: 'tool_call', tool: 'bash' });
  const out = renderLine(parsed, '', 'type', { deliverFields: ['tool'] });
  assert.match(out, /^\[tool_call\]\n/);
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['tool']);
});

test('deliverFields: output order follows the filter list', () => {
  const parsed = parsedEntry({
    type: 't',
    notes: 'n',
    tool: 'x',
    args: { k: 1 },
  });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['tool', 'args', 'notes'],
  });
  // We key off the order in pretty-printed JSON string (insertion order).
  const bodyStr = out.slice(out.indexOf('\n') + 1);
  const iTool = bodyStr.indexOf('"tool"');
  const iArgs = bodyStr.indexOf('"args"');
  const iNotes = bodyStr.indexOf('"notes"');
  assert.ok(iTool < iArgs && iArgs < iNotes, `expected tool < args < notes, got ${iTool}/${iArgs}/${iNotes}`);
});

test('deliverFieldMaxChars: truncates long string values with ellipsis', () => {
  const parsed = parsedEntry({ type: 't', notes: 'x'.repeat(200) });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['notes'],
    deliverFieldMaxChars: 50,
  });
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.equal(typeof body.notes, 'string');
  assert.equal((body.notes as string).length, 50);
  assert.ok((body.notes as string).endsWith('...'));
  assert.ok((body.notes as string).startsWith('xxx'));
});

test('deliverFieldMaxChars: leaves short string values intact', () => {
  const parsed = parsedEntry({ type: 't', notes: 'short' });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['notes'],
    deliverFieldMaxChars: 50,
  });
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.equal(body.notes, 'short');
});

test('deliverFieldMaxChars: non-string value under budget renders as nested JSON', () => {
  const parsed = parsedEntry({ type: 't', args: { cmd: 'ls', flag: true } });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['args'],
    deliverFieldMaxChars: 200,
  });
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.deepEqual(body.args, { cmd: 'ls', flag: true });
});

test('deliverFieldMaxChars: non-string value over budget becomes a truncated string', () => {
  const big = { cmd: 'x'.repeat(500) };
  const parsed = parsedEntry({ type: 't', args: big });
  const cap = 50;
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['args'],
    deliverFieldMaxChars: cap,
  });
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.equal(typeof body.args, 'string');
  assert.equal((body.args as string).length, cap);
  assert.ok((body.args as string).endsWith('...'));
});

test('deliverFieldMaxChars: per-field budget is independent — no field starves another', () => {
  const parsed = parsedEntry({
    type: 't',
    big: 'B'.repeat(10_000),
    small: 'hi',
  });
  const out = renderLine(parsed, '', 'type', {
    deliverFields: ['big', 'small'],
    deliverFieldMaxChars: 100,
  });
  const body = JSON.parse(out.slice(out.indexOf('\n') + 1)) as Record<string, unknown>;
  assert.equal((body.big as string).length, 100);
  assert.ok((body.big as string).endsWith('...'));
  // `small` is short and untouched — the oversize `big` did not eat its budget.
  assert.equal(body.small, 'hi');
});

test('without options: behaviour is unchanged (full payload in body)', () => {
  const parsed = parsedEntry({
    type: 'tool_call',
    tool: 'bash',
    trace_id: 'abc',
  });
  const out = renderLine(parsed, '', 'type');
  assert.ok(out.includes('"trace_id"'));
  assert.ok(out.includes('"tool"'));
});
