// Line-rendering helper. Produces the text body passed to `provider.deliver`.
//
// V1 renders every entry with a single default template:
//     [<keyValue>]
//     <pretty JSON of the full parsed payload>
//
// `keyField` selects which property of the parsed entry to use as the header
// label — `"type"` by default, but configurable per-source via `tier_key` so
// consumers can pick their own discriminator (e.g. `event_type`). When the
// field is missing or non-string we fall back to `'(no-type)'`.
//
// Note: timestamps are intentionally omitted from the header. The Telegram
// client stamps messages itself, and re-rendering the timestamp in-line only
// wastes characters. The append-to-file inbound path still writes a
// `timestamp` so consumer agents can detect what's new on resume.
//
// If the pretty form exceeds a soft character cap (headroom under the
// typical 4096-char messaging-platform limit — providers may truncate
// further), we fall back to a single-line JSON, then hard-truncate with
// an ellipsis. Per-type templates are V2 scope (see relay.md §Deferred).
//
// Input is the parsed JSONL entry; `raw` is the original line text and is
// the ultimate fallback when `parsed` somehow lacks a type field (the
// dispatcher never calls us with `parsed === null`).
//
// See relay.md §Data contract.

import type { JsonlEntry } from './types.js';

// Soft cap chosen to leave ~600 chars headroom under Telegram's 4096-char
// text limit. Providers may still truncate on their own.
const SOFT_CAP = 3500;

export function renderLine(
  parsed: JsonlEntry,
  raw: string,
  keyField: string,
): string {
  const rawKey = (parsed as Record<string, unknown>)[keyField];
  const keyValue = typeof rawKey === 'string' ? rawKey : '(no-type)';
  const header = `[${keyValue}]`;

  const pretty = safeStringify(parsed, 2);
  const prettyLine = `${header}\n${pretty}`;
  if (prettyLine.length <= SOFT_CAP) return prettyLine;

  // Fallback 1: single-line JSON.
  const single = safeStringify(parsed, 0);
  const singleLine = `${header}\n${single}`;
  if (singleLine.length <= SOFT_CAP) return singleLine;

  // Fallback 2: hard truncate to the cap. Leave 3 chars for the ellipsis
  // so the produced body is always at most SOFT_CAP chars.
  const truncatedBody = single.slice(0, SOFT_CAP - header.length - 1 - 3);
  void raw; // intentionally unused; retained in signature for future templates
  return `${header}\n${truncatedBody}...`;
}

// JSON.stringify can throw on circular references. The watcher already
// parsed `parsed` from JSON so this should never happen — but we still
// want to avoid crashing the dispatcher loop on an adversarial payload.
function safeStringify(value: unknown, indent: number): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}
