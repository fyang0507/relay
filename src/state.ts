// Persistent state store. See relay.md §Startup and backfill behavior.
//
// Single JSON file at ~/.relay/state.json. Tracks:
//   - per-source-file offset and mapped destination (keyed by filePath)
//   - per-provider generic key/value bag (e.g. telegram update_id cursor)
//   - registry: runtime-registered source configs keyed by `rl_xxx` id
//
// Writes are debounced (~500ms) and serialized through an internal queue; each
// save is an atomic write (tmp → fsync → rename). Single-process daemon — no
// cross-process file lock in V1.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

import type { Destination } from './providers/types.js';
import type { SourceConfig } from './types.js';

// Persisted per-source-file state. See relay.md §Startup and backfill behavior.
// `relayId` links this tracked file back to the registry entry that owns it
// (v2 schema). Removing a registry entry cascades to all sources[filePath]
// entries whose `relayId` matches.
export interface SourceState {
  sourceName: string;
  relayId: string;
  offset: number;
  destination: Destination;
  destinationKey: string;
  disabled?: boolean;
  disabledReason?: string;
}

// Registry entry: one per runtime-registered source. Keyed by `rl_xxx` id in
// the state file's top-level `registry` section.
export interface RegistryEntry {
  id: string;                  // same as the map key
  configPath: string;          // absolute path of the YAML config this was loaded from
  sourceConfig: SourceConfig;  // fully resolved + validated
  addedAt: string;             // ISO 8601 UTC
}

// On-disk shape (schema v3). `version` lets us reject stale state files.
// v3 bump (#6): the registry stores `RegistryEntry.sourceConfig`, whose
// shape changed (provider settings moved to a nested `provider:` block).
// We reject v1/v2 state with a clear message and require operators to
// clear `~/.relay/state.json` and re-register.
export interface RelayStateShape {
  version: 3;
  sources: Record<string, SourceState>;
  providers: Record<string, Record<string, unknown>>;
  registry: Record<string, RegistryEntry>;
}

const DEFAULT_STATE_PATH = path.join(os.homedir(), '.relay', 'state.json');
const AUTOSAVE_DEBOUNCE_MS = 500;
const RELAY_ID_MAX_RETRIES = 10;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function freshState(): RelayStateShape {
  return { version: 3, sources: {}, providers: {}, registry: {} };
}

export class RelayState {
  private readonly filePath: string;
  private data: RelayStateShape;

  // Debounce timer for autosave.
  private saveTimer: NodeJS.Timeout | null = null;
  // Serialize writes so concurrent save() calls never interleave.
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, data: RelayStateShape) {
    this.filePath = filePath;
    this.data = data;
  }

  static async load(filePath?: string): Promise<RelayState> {
    const resolved = expandHome(filePath ?? DEFAULT_STATE_PATH);
    let data: RelayStateShape;
    try {
      const raw = await fs.readFile(resolved, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RelayStateShape> & {
        version?: number;
      };
      // Reject any state file that isn't v3. No auto-migration — operators
      // must clear the file and re-register sources.
      if (parsed.version !== 3) {
        throw new Error(
          `State file at ${resolved} is v${parsed.version ?? '<unknown>'}; this relay requires v3. Remove the file and re-register sources (schema v3 moves provider settings under a nested \`provider:\` block; see relay.md §Configuration schema).`,
        );
      }
      data = {
        version: 3,
        sources: parsed.sources ?? {},
        providers: parsed.providers ?? {},
        registry: parsed.registry ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Fresh state. Treated as v3 from the start.
        data = freshState();
      } else {
        throw err;
      }
    }
    return new RelayState(resolved, data);
  }

  getSource(filePath: string): SourceState | undefined {
    return this.data.sources[filePath];
  }

  setSource(filePath: string, s: SourceState): void {
    this.data.sources[filePath] = s;
    this.scheduleSave();
  }

  // Remove a single source-file entry. Returns true if anything was removed.
  removeSource(filePath: string): boolean {
    if (!(filePath in this.data.sources)) return false;
    delete this.data.sources[filePath];
    this.scheduleSave();
    return true;
  }

  findSourceByDestinationKey(
    key: string,
  ): { filePath: string; state: SourceState } | undefined {
    for (const [filePath, state] of Object.entries(this.data.sources)) {
      if (state.destinationKey === key) return { filePath, state };
    }
    return undefined;
  }

  // Return [filePath, state] pairs for every tracked source file belonging to
  // a given registry id. Used by `removeRegistry` and the runtime cleanup path.
  listSourcesByRelayId(relayId: string): Array<{ filePath: string; state: SourceState }> {
    const out: Array<{ filePath: string; state: SourceState }> = [];
    for (const [filePath, state] of Object.entries(this.data.sources)) {
      if (state.relayId === relayId) out.push({ filePath, state });
    }
    return out;
  }

  getProviderState(providerName: string): Record<string, unknown> {
    let bag = this.data.providers[providerName];
    if (!bag) {
      bag = {};
      this.data.providers[providerName] = bag;
    }
    // Wrap in a Proxy so in-place writes trigger an autosave without requiring
    // callers to call a setter.
    return new Proxy(bag, {
      set: (target, prop, value) => {
        (target as Record<string, unknown>)[prop as string] = value;
        this.scheduleSave();
        return true;
      },
      deleteProperty: (target, prop) => {
        delete (target as Record<string, unknown>)[prop as string];
        this.scheduleSave();
        return true;
      },
    });
  }

  disableSource(filePath: string, reason: string): void {
    const s = this.data.sources[filePath];
    if (!s) return;
    s.disabled = true;
    s.disabledReason = reason;
    this.scheduleSave();
  }

  // ---- registry (schema v2) -----------------------------------------------

  addRegistry(entry: RegistryEntry): void {
    this.data.registry[entry.id] = entry;
    this.scheduleSave();
  }

  // Remove a registry entry. Cascades: also drops every sources[filePath]
  // whose `relayId === id`. Returns the removed entry, or undefined if none.
  removeRegistry(id: string): RegistryEntry | undefined {
    const existing = this.data.registry[id];
    if (!existing) return undefined;
    delete this.data.registry[id];
    // Cascade.
    for (const [filePath, state] of Object.entries(this.data.sources)) {
      if (state.relayId === id) {
        delete this.data.sources[filePath];
      }
    }
    this.scheduleSave();
    return existing;
  }

  listRegistry(): RegistryEntry[] {
    return Object.values(this.data.registry).map((e) => ({ ...e }));
  }

  getRegistry(id: string): RegistryEntry | undefined {
    const e = this.data.registry[id];
    return e ? { ...e } : undefined;
  }

  // Generate a fresh `rl_xxxxxx` id. 6 lowercase hex chars from 3 random bytes.
  // Retries on collision with live registry entries up to 10 attempts.
  generateRelayId(): string {
    for (let i = 0; i < RELAY_ID_MAX_RETRIES; i++) {
      const id = `rl_${randomBytes(3).toString('hex')}`;
      if (!(id in this.data.registry)) return id;
    }
    throw new Error(
      `generateRelayId: could not find a non-colliding id after ${RELAY_ID_MAX_RETRIES} attempts`,
    );
  }

  // Debounced autosave. Successive writes within the window coalesce.
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Fire and forget — errors surface via flush() which awaits the chain.
      void this.save();
    }, AUTOSAVE_DEBOUNCE_MS);
    // Don't keep the event loop alive solely for the autosave timer.
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  // Flush pending autosave (if any) and wait for all queued writes to finish.
  // Call on graceful shutdown.
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
    } else {
      await this.saveChain;
    }
  }

  // Public atomic save. Serializes through saveChain so concurrent callers
  // each see their own snapshot written in order.
  save(): Promise<void> {
    const next = this.saveChain.then(() => this.writeAtomic());
    // Swallow errors on the chain itself so one failure doesn't poison
    // subsequent saves; the returned promise still rejects for this caller.
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  private async writeAtomic(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    // Snapshot the shape at the moment of write.
    const payload = JSON.stringify(this.data, null, 2);
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, this.filePath);
  }

  // Exposed for tests.
  _snapshot(): RelayStateShape {
    return JSON.parse(JSON.stringify(this.data)) as RelayStateShape;
  }
}
