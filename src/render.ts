// Line-rendering helper. Produces the text body passed to `provider.deliver`.
//
// Default template:
//     [<keyValue>]
//     <pretty JSON of the parsed payload>
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
// Field filtering: when `deliverFields` is set, the payload is projected to
// those top-level keys (in the listed order) before stringifying. Missing
// keys are silently absent. The header is derived from the raw entry and is
// unaffected — operators do not have to re-list the tier-key in the filter
// to keep the header.
//
// Per-field truncation: when `deliverFieldMaxChars` is set (only valid
// alongside `deliverFields`, enforced at config load), each projected field
// is individually capped:
//   - string values over the cap: truncated to cap-3 chars + '...'
//   - non-string values whose JSON.stringify exceeds the cap: replaced with
//     the truncated stringified form (ending in '...'). The value becomes a
//     string in the rendered JSON rather than a partial object.
// This prevents one large field from starving the rest of the message, which
// is what happens with a single message-level cap.
//
// If the pretty form still exceeds a soft character cap (headroom under the
// typical 4096-char messaging-platform limit — providers may truncate
// further), we fall back to a single-line JSON, then hard-truncate with an
// ellipsis.
//
// See relay.md §Data contract.

import type { JsonlEntry } from './types.js';

// Soft cap chosen to leave ~600 chars headroom under Telegram's 4096-char
// text limit. Acts as the final backstop even when per-field truncation is
// active (in case header + N fields × field-cap somehow overflows).
const SOFT_CAP = 3500;

export interface RenderOptions {
  deliverFields?: string[];
  deliverFieldMaxChars?: number;
}

export function renderLine(
  parsed: JsonlEntry,
  raw: string,
  keyField: string,
  options: RenderOptions = {},
): string {
  const rawKey = (parsed as Record<string, unknown>)[keyField];
  const keyValue = typeof rawKey === 'string' ? rawKey : '(no-type)';
  const header = `[${keyValue}]`;

  const body = projectAndTruncate(
    parsed,
    options.deliverFields,
    options.deliverFieldMaxChars,
  );

  const pretty = safeStringify(body, 2);
  const prettyLine = `${header}\n${pretty}`;
  if (prettyLine.length <= SOFT_CAP) return prettyLine;

  // Fallback 1: single-line JSON.
  const single = safeStringify(body, 0);
  const singleLine = `${header}\n${single}`;
  if (singleLine.length <= SOFT_CAP) return singleLine;

  // Fallback 2: hard truncate to the cap. Leave 3 chars for the ellipsis
  // so the produced body is always at most SOFT_CAP chars.
  const truncatedBody = single.slice(0, SOFT_CAP - header.length - 1 - 3);
  void raw; // intentionally unused; retained in signature for future templates
  return `${header}\n${truncatedBody}...`;
}

// Project the parsed payload down to `deliverFields` (when set) and apply
// per-field truncation (when `maxChars` is set). Returns a plain object
// suitable for JSON.stringify.
function projectAndTruncate(
  parsed: JsonlEntry,
  deliverFields: string[] | undefined,
  maxChars: number | undefined,
): unknown {
  if (deliverFields === undefined) return parsed;

  const src = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of deliverFields) {
    if (!Object.prototype.hasOwnProperty.call(src, field)) continue;
    const value = src[field];
    out[field] = maxChars === undefined ? value : capFieldValue(value, maxChars);
  }
  return out;
}

// Per-field cap. Strings are truncated directly; non-strings are probed via
// JSON.stringify and replaced with the truncated stringified form if over
// budget (bounded, predictable, and preserves the field key so operators can
// still see *which* field was too big).
function capFieldValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value;
    return value.slice(0, Math.max(0, maxChars - 3)) + '...';
  }
  const probe = safeStringify(value, 0);
  if (probe.length <= maxChars) return value;
  return probe.slice(0, Math.max(0, maxChars - 3)) + '...';
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
