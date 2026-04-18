// Client-side library for the relay daemon's unix-socket RPC. Each method
// opens a fresh connection, writes a single newline-terminated JSON
// request, reads the single-line response, and closes. See src/socket.ts
// for the server side and relay.md §Architecture (Phase 1b).
//
// Errors:
//   - Daemon not running (ENOENT / ECONNREFUSED at connect time) →
//     throws DaemonNotRunningError so a CLI can render actionable help.
//   - `{ok: false}` response → throws a plain Error with `.code` attached
//     so callers can branch on `err.code === 'not_found'` etc.
//   - Per-request timeout (default 5s) → throws Error with code `'timeout'`.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type {
  AddDryRunEntry,
  AddEntry,
  RemoveDryRunPayload,
} from './socket.ts';
import type { ListedSource } from './runtime.ts';

// Re-export result shapes so client consumers don't reach into
// ./socket.ts (which also pulls in server-only imports like loadConfig).
export type {
  AddDryRunEntry,
  AddEntry,
  RemoveDryRunPayload,
  ListedSource,
};

export type AddResult =
  | { ok: true; added: AddEntry[]; existing: AddEntry[]; warnings: string[] }
  | {
      ok: true;
      dryRun: true;
      wouldAdd: AddDryRunEntry[];
      warnings: string[];
    };

export type RemoveResult =
  | { ok: true; removed: { id: string; configPath: string; sourceName: string } }
  | { ok: true; dryRun: true; wouldRemove: RemoveDryRunPayload };

export interface HealthResult {
  ok: true;
  version: string;
  sourcesTracked: number;
  uptimeSeconds: number;
}

export class DaemonNotRunningError extends Error {
  readonly code = 'not_running' as const;
  constructor(socketPath: string) {
    super(
      `relay daemon not running (socket at ${socketPath} is unavailable)`,
    );
    this.name = 'DaemonNotRunningError';
  }
}

// Internal: error thrown when the server returns {ok: false}. Exposed
// through its `.code` property on a plain Error so tests can assert on
// either the class or the code without importing anything special.
function makeRpcError(message: string, code?: string): Error {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

export interface RelayClientOptions {
  timeoutMs?: number;
}

export class RelayClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath?: string, opts: RelayClientOptions = {}) {
    this.socketPath =
      socketPath ?? path.join(os.homedir(), '.relay', 'sock');
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async list(): Promise<ListedSource[]> {
    const resp = await this.request({ cmd: 'list' });
    return (resp as unknown as { sources: ListedSource[] }).sources;
  }

  async add(opts: {
    configPath: string;
    dryRun?: boolean;
  }): Promise<AddResult> {
    const req: Record<string, unknown> = {
      cmd: 'add',
      configPath: opts.configPath,
    };
    if (opts.dryRun !== undefined) req.dryRun = opts.dryRun;
    const resp = await this.request(req);
    return resp as unknown as AddResult;
  }

  async remove(opts: {
    id: string;
    dryRun?: boolean;
  }): Promise<RemoveResult> {
    const req: Record<string, unknown> = { cmd: 'remove', id: opts.id };
    if (opts.dryRun !== undefined) req.dryRun = opts.dryRun;
    const resp = await this.request(req);
    return resp as unknown as RemoveResult;
  }

  async health(): Promise<HealthResult> {
    const resp = await this.request({ cmd: 'health' });
    return resp as unknown as HealthResult;
  }

  // ---- internals -------------------------------------------------------

  // Open a connection, send the request, read one line back, close.
  private request(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buf = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(makeRpcError(
          `relay client: request timed out after ${this.timeoutMs}ms`,
          'timeout',
        )));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      socket.setEncoding('utf8');

      socket.once('connect', () => {
        try {
          socket.write(JSON.stringify(req) + '\n');
        } catch (err) {
          clearTimeout(timer);
          settle(() => reject(err as Error));
        }
      });

      socket.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        clearTimeout(timer);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          settle(() =>
            reject(
              makeRpcError(
                'relay client: server sent malformed JSON',
                'bad_response',
              ),
            ),
          );
          return;
        }
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          settle(() =>
            reject(
              makeRpcError(
                'relay client: server response was not a JSON object',
                'bad_response',
              ),
            ),
          );
          return;
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.ok === false) {
          const msg =
            typeof obj.error === 'string' ? obj.error : 'unknown server error';
          const code = typeof obj.code === 'string' ? obj.code : undefined;
          settle(() => reject(makeRpcError(msg, code)));
          return;
        }
        settle(() => resolve(obj));
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          settle(() => reject(new DaemonNotRunningError(this.socketPath)));
          return;
        }
        settle(() => reject(err));
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (settled) return;
        // Server closed without a response.
        settle(() =>
          reject(
            makeRpcError(
              'relay client: connection closed before response',
              'closed',
            ),
          ),
        );
      });
    });
  }
}
