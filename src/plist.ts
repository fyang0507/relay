// Pure plist builder for launchd LaunchAgents. See relay.md §Architecture
// (Phase 3): on macOS the relay daemon is kept alive by launchd rather than
// a custom supervisor. This module is string-in / string-out so the file
// I/O layer in `commands/lifecycle.ts` stays thin and we can unit-test the
// XML shape without touching disk.
//
// The resulting document is the standard Apple plist format: XML with the
// Apple DOCTYPE, a `<plist version="1.0">` root, and a single `<dict>` child.
// launchctl(1) is picky about the DOCTYPE and the encoding declaration, so we
// emit them verbatim.

export interface PlistSpec {
  // Launchd label (also the filename stem under ~/Library/LaunchAgents).
  // Example: 'com.fyang0507.relay'.
  label: string;
  // Absolute path to the program that should be invoked. For node-based
  // agents this is typically the node binary itself, with `args` containing
  // the path to the script.
  daemonPath: string;
  // Arguments passed to `daemonPath`. Joined with `daemonPath` as the
  // ProgramArguments array in the resulting plist.
  args: string[];
  // Working directory for the spawned process. Used so the daemon can find
  // `.env` and package.json via its usual repo-root resolution.
  workingDirectory: string;
  // Absolute path for launchd to redirect stdout to.
  stdoutLog: string;
  // Absolute path for launchd to redirect stderr to.
  stderrLog: string;
  // Optional environment variables. Keys/values are XML-escaped before
  // emitting.
  environment?: Record<string, string>;
}

// Escape the five XML entities that can appear in text content or attribute
// values. We don't distinguish the two here — encoding all five is always
// safe and keeps the escaping trivial to reason about.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stringTag(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

export function buildPlist(spec: PlistSpec): string {
  const programArguments = [spec.daemonPath, ...spec.args];

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  lines.push('<plist version="1.0">');
  lines.push('<dict>');

  lines.push('  <key>Label</key>');
  lines.push(`  ${stringTag(spec.label)}`);

  lines.push('  <key>ProgramArguments</key>');
  lines.push('  <array>');
  for (const arg of programArguments) {
    lines.push(`    ${stringTag(arg)}`);
  }
  lines.push('  </array>');

  lines.push('  <key>WorkingDirectory</key>');
  lines.push(`  ${stringTag(spec.workingDirectory)}`);

  lines.push('  <key>RunAtLoad</key>');
  lines.push('  <true/>');

  lines.push('  <key>KeepAlive</key>');
  lines.push('  <true/>');

  lines.push('  <key>StandardOutPath</key>');
  lines.push(`  ${stringTag(spec.stdoutLog)}`);

  lines.push('  <key>StandardErrorPath</key>');
  lines.push(`  ${stringTag(spec.stderrLog)}`);

  if (spec.environment && Object.keys(spec.environment).length > 0) {
    lines.push('  <key>EnvironmentVariables</key>');
    lines.push('  <dict>');
    // Sort keys for deterministic output — important for the idempotency
    // check in `install()` which compares the rendered plist byte-for-byte.
    const keys = Object.keys(spec.environment).sort();
    for (const k of keys) {
      const v = spec.environment[k] ?? '';
      lines.push(`    <key>${escapeXml(k)}</key>`);
      lines.push(`    ${stringTag(v)}`);
    }
    lines.push('  </dict>');
  }

  lines.push('</dict>');
  lines.push('</plist>');
  lines.push(''); // trailing newline

  return lines.join('\n');
}
