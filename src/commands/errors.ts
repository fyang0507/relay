// Thin error type so command modules can signal "abort with this exit code
// and print these stderr lines" without ever calling process.exit directly.
// The cli.ts router catches CliError, prints via printError, and exits.
//
// We intentionally keep this as a class (not a tuple) so `instanceof` works
// across module boundaries; commander's own errors fall through to a
// generic exit-1 path in cli.ts.

export class CliError extends Error {
  readonly exitCode: number;
  readonly lines: string[];
  constructor(lines: string[], exitCode = 1) {
    super(lines[0] ?? 'cli error');
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.lines = lines;
  }
}

// Standard "daemon not running" stderr block. Every command that talks to
// the daemon renders the same message so users learn the fix from any
// entrypoint.
export function daemonNotRunningLines(socketPath: string): string[] {
  return [
    'Error: relay daemon is not running.',
    '  Start it with: relay init',
    `  Socket expected at: ${socketPath}`,
  ];
}
