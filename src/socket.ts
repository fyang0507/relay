// Unix-domain-socket RPC server. See relay.md §Architecture (Phase 1b): the
// long-running daemon hosts a tiny JSON protocol so the CLI (P4) — and,
// during this phase, a direct `RelayClient` — can issue `list`, `add`,
// `remove`, and `health` commands without touching the daemon's in-memory
// state directly.
//
// Protocol: newline-delimited JSON, one request + one response per
// connection. The client opens, writes `{cmd, ...}\n`, reads until `\n`,
// parses, and closes. We chose one-shot connections (no multiplexing) to
// keep the server trivial — connection setup on a unix socket is effectively
// free and the CLI is low-volume.
//
// Socket file: `~/.relay/sock`, mode 0o600 (user-only). We `fs.unlink` any
// stale socket before binding so a daemon that crashed mid-run can restart
// cleanly. Parent directory is created with `fs.mkdir(..., recursive: true)`.
//
// Error shape: `{ok: false, error: <human msg>, code?: <short code>}`. Known
// codes: `bad_request` (malformed JSON), `unknown_cmd`, `not_found` (remove
// on unknown id), `config_invalid` (add on bad config), `internal`
// (uncaught handler error). Success shape: `{ok: true, ...data}`.

import net from 'node:net';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { Relay, ListedSource } from './runtime.ts';
import { SourceNameConflictError } from './runtime.ts';
import type { RelayState } from './state.ts';
import { loadConfig } from './config.ts';

// ---- protocol types -----------------------------------------------------

export interface RpcRequest {
  cmd: string;
  [k: string]: unknown;
}

export interface RpcErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

export interface ListResponse {
  ok: true;
  sources: ListedSource[];
}

export interface AddDryRunEntry {
  name: string;
  provider: string;
  groupId?: number;
  pathGlob: string;
}

export interface AddDryRunResponse {
  ok: true;
  dryRun: true;
  wouldAdd: AddDryRunEntry[];
  warnings: string[];
}

export interface AddEntry {
  id: string;
  name: string;
}

export interface AddResponse {
  ok: true;
  added: AddEntry[];
  existing: AddEntry[];
  warnings: string[];
}

export interface RemoveDryRunPayload {
  id: string;
  configPath: string;
  sourceName: string;
  filesTracked: number;
}

export interface RemoveDryRunResponse {
  ok: true;
  dryRun: true;
  wouldRemove: RemoveDryRunPayload;
}

export interface RemoveResponse {
  ok: true;
  removed: { id: string; configPath: string; sourceName: string };
}

export interface HealthResponse {
  ok: true;
  version: string;
  sourcesTracked: number;
  uptimeSeconds: number;
}

export type RpcResponse =
  | ListResponse
  | AddDryRunResponse
  | AddResponse
  | RemoveDryRunResponse
  | RemoveResponse
  | HealthResponse
  | RpcErrorResponse;

// ---- server -------------------------------------------------------------

export interface SocketServerOptions {
  socketPath: string;
  relay: Relay;
  state: RelayState;
  startedAt: number;
  version: string;
}

export class SocketServer {
  private readonly socketPath: string;
  private readonly relay: Relay;
  private readonly state: RelayState;
  private readonly startedAt: number;
  private readonly version: string;

  private server: net.Server | null = null;
  private started = false;
  private stopped = false;

  constructor(opts: SocketServerOptions) {
    this.socketPath = opts.socketPath;
    this.relay = opts.relay;
    this.state = opts.state;
    this.startedAt = opts.startedAt;
    this.version = opts.version;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Ensure parent dir exists (e.g. ~/.relay/).
    const parent = path.dirname(this.socketPath);
    await fsp.mkdir(parent, { recursive: true });

    // Remove stale socket from a prior crash. ENOENT is fine — nothing to clean.
    try {
      await fsp.unlink(this.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    // Bind + wait for 'listening'.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });

    // Lock the socket down to user-only. chmod after bind so there's no
    // race between mode-less creation and first connect.
    try {
      await fsp.chmod(this.socketPath, 0o600);
    } catch (err) {
      // Non-fatal: log and continue. The socket is still functional.
      console.warn(
        `[socket] failed to chmod 0600 on ${this.socketPath}: ${(err as Error).message}`,
      );
    }

    this.server = server;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    // Remove the socket file. Swallow ENOENT — some test paths may have
    // already cleaned it up.
    try {
      await fsp.unlink(this.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[socket] failed to unlink ${this.socketPath}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ---- per-connection wiring --------------------------------------------

  private handleConnection(socket: net.Socket): void {
    let buf = '';
    let handled = false;

    const writeAndClose = (payload: RpcResponse) => {
      if (handled) return;
      handled = true;
      try {
        socket.write(JSON.stringify(payload) + '\n', () => {
          socket.end();
        });
      } catch {
        // Client may have already closed — nothing to do.
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      // We deliberately ignore anything after the first newline — one
      // request per connection.
      let req: RpcRequest;
      try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('request must be a JSON object');
        }
        req = parsed as RpcRequest;
      } catch {
        writeAndClose({ ok: false, error: 'malformed JSON', code: 'bad_request' });
        return;
      }
      // Dispatch asynchronously; catch uncaught errors as `internal`.
      this.dispatch(req)
        .then((resp) => writeAndClose(resp))
        .catch((err: Error) => {
          writeAndClose({
            ok: false,
            error: err.message || 'internal error',
            code: 'internal',
          });
        });
    });
    socket.on('error', () => {
      // Client hung up mid-write or similar. We don't have a meaningful way
      // to reply; just ensure the socket is dead.
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  }

  // ---- command dispatch --------------------------------------------------

  private async dispatch(req: RpcRequest): Promise<RpcResponse> {
    const cmd = typeof req.cmd === 'string' ? req.cmd : '';
    switch (cmd) {
      case 'list':
        return this.handleList();
      case 'add':
        return this.handleAdd(req);
      case 'remove':
        return this.handleRemove(req);
      case 'health':
        return this.handleHealth();
      default:
        return {
          ok: false,
          error: `unknown command: ${cmd || '<missing>'}`,
          code: 'unknown_cmd',
        };
    }
  }

  private handleList(): ListResponse {
    return { ok: true, sources: this.relay.listSources() };
  }

  private async handleAdd(req: RpcRequest): Promise<RpcResponse> {
    const configPath = req.configPath;
    const dryRun = req.dryRun === true;
    if (typeof configPath !== 'string' || configPath.length === 0) {
      return {
        ok: false,
        error: 'add: configPath must be a non-empty string',
        code: 'bad_request',
      };
    }
    if (!path.isAbsolute(configPath)) {
      return {
        ok: false,
        error: `add: configPath must be absolute (got "${configPath}"); the daemon may not share the caller's cwd`,
        code: 'bad_request',
      };
    }

    // Confirm the file exists and is readable before handing to the loader —
    // loadConfig's error for ENOENT is clear enough, but doing the stat here
    // lets us return a crisper error shape.
    try {
      await fsp.access(configPath);
    } catch (err) {
      return {
        ok: false,
        error: `add: cannot read config at ${configPath}: ${(err as Error).message}`,
        code: 'config_invalid',
      };
    }

    let result;
    try {
      result = await loadConfig(configPath);
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        code: 'config_invalid',
      };
    }

    if (dryRun) {
      // Wire shape for dry-run entries stays flat (provider + optional
      // groupId) so existing CLI/script consumers don't have to care that
      // the config schema moved provider-specific fields into a nested
      // block. We flatten on the server side here.
      const wouldAdd: AddDryRunEntry[] = result.config.sources.map((s) => {
        const entry: AddDryRunEntry = {
          name: s.name,
          provider: s.provider.type,
          pathGlob: s.pathGlob,
        };
        if (s.provider.type === 'telegram') {
          entry.groupId = s.provider.groupId;
        }
        return entry;
      });
      return {
        ok: true,
        dryRun: true,
        wouldAdd,
        warnings: result.warnings,
      };
    }

    // Snapshot which (configPath, name) pairs are already present BEFORE
    // we call addSource — addSource returns the existing id on idempotent
    // hits, which means we can't distinguish "added just now" from
    // "already there" by the return value alone.
    const before = new Set<string>();
    for (const e of this.state.listRegistry()) {
      if (e.configPath === configPath) before.add(e.sourceConfig.name);
    }

    const added: AddEntry[] = [];
    const existing: AddEntry[] = [];
    for (const source of result.config.sources) {
      let id: string;
      try {
        id = await this.relay.addSource(source, configPath);
      } catch (err) {
        if (err instanceof SourceNameConflictError) {
          // Name collisions are fail-fast at the registration boundary —
          // earlier sources in this same config will have registered, which
          // matches the existing `config_invalid` partial-write behavior.
          return {
            ok: false,
            error: err.message,
            code: 'name_conflict',
          };
        }
        throw err;
      }
      const pair = { id, name: source.name };
      if (before.has(source.name)) {
        existing.push(pair);
      } else {
        added.push(pair);
      }
    }
    return { ok: true, added, existing, warnings: result.warnings };
  }

  private async handleRemove(req: RpcRequest): Promise<RpcResponse> {
    const id = req.id;
    const dryRun = req.dryRun === true;
    if (typeof id !== 'string' || id.length === 0) {
      return {
        ok: false,
        error: 'remove: id must be a non-empty string',
        code: 'bad_request',
      };
    }

    const entry = this.state.getRegistry(id);
    if (!entry) {
      return {
        ok: false,
        error: `no relay with id ${id}`,
        code: 'not_found',
      };
    }

    if (dryRun) {
      const tracked = this.state.listSourcesByRelayId(id);
      return {
        ok: true,
        dryRun: true,
        wouldRemove: {
          id: entry.id,
          configPath: entry.configPath,
          sourceName: entry.sourceConfig.name,
          filesTracked: tracked.length,
        },
      };
    }

    await this.relay.removeSource(id);
    return {
      ok: true,
      removed: {
        id: entry.id,
        configPath: entry.configPath,
        sourceName: entry.sourceConfig.name,
      },
    };
  }

  private handleHealth(): HealthResponse {
    const sourcesTracked = this.relay.listSources().length;
    const uptimeSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    return {
      ok: true,
      version: this.version,
      sourcesTracked,
      uptimeSeconds,
    };
  }
}
