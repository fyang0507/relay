// Formatting helpers for the relay CLI. Every user-visible command output
// is produced through `printKv` / `printList` / `printError` so we get a
// consistent `key: value` surface without colors, emoji, or unicode boxes.
// The design goal is "machine-parseable first": each line is a single key,
// a colon, whitespace padding, and the value — scriptable with `awk '{print
// $2}'` or equivalent.
//
// - `printKv(pairs)`      → stdout block, colons aligned by longest key.
// - `printList(title, items)` → stdout, one title line then each item as an
//   indented kv block separated by blank lines.
// - `printError(lines)`   → stderr, one line per array entry, no decoration.
//
// CLI command modules in ./commands/*.ts must not call `console.log` / write
// to stdout directly; all presentation goes through here.

// Align `k:` colons by padding the key to the longest width + 1 space after
// the colon. The minimum gap after the colon is 1 space so very long keys
// still read cleanly.
function alignKv(pairs: Array<[string, string]>, indent = 0): string[] {
  if (pairs.length === 0) return [];
  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  const pad = ' '.repeat(indent);
  return pairs.map(([k, v]) => {
    const colon = `${k}:`;
    const gap = ' '.repeat(Math.max(1, maxKey + 2 - k.length));
    return `${pad}${colon}${gap}${v}`;
  });
}

// Write a key:value block to stdout with a trailing newline.
export function printKv(pairs: Array<[string, string]>): void {
  const lines = alignKv(pairs);
  if (lines.length === 0) return;
  process.stdout.write(lines.join('\n') + '\n');
}

// Write a titled list of kv blocks to stdout. Items are separated by a
// blank line. The title is emitted on its own line followed by each item
// indented two spaces. An empty `items` array prints only the title.
export function printList(
  title: string,
  items: Array<Array<[string, string]>>,
): void {
  const out: string[] = [title];
  items.forEach((item, idx) => {
    if (idx > 0) out.push('');
    out.push(...alignKv(item, 2));
  });
  process.stdout.write(out.join('\n') + '\n');
}

// Write one or more lines to stderr. No color, no prefix, no trailing
// blank line beyond a single newline on the last entry.
export function printError(lines: string[]): void {
  if (lines.length === 0) return;
  process.stderr.write(lines.join('\n') + '\n');
}
