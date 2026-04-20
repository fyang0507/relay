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

// Per-file destination mapping that outlived its registry entry. Produced by
// `removeRegistry` instead of a hard delete of the matching `sources[filePath]`
// entries, so a later `relay add` against the same files can rehydrate the
// existing destination (e.g. Telegram forum topic) instead of provisioning a
// fresh one and orphaning the old. See GH #14. Keyed by `filePath` in the
// top-level `orphaned` section.
//
// `providerType` is captured at archive time so rehydration only matches when
// the re-registered source uses the same provider — a stdout-source replacing
// a telegram-source (or vice versa) is a genuine config change and should
// provision fresh rather than recycling an address that belongs to a
// different platform.
export interface OrphanEntry {
  filePath: string;
  sourceName: string;
  providerType: string;
  destination: Destination;
  destinationKey: string;
  offset: number;
  archivedAt: string;
}

// On-disk shape (schema v4). `version` lets us reject stale state files.
// v3 → v4 (GH #14): additive — adds the `orphaned` section. v3 state files
// are upgraded seamlessly on load (missing `orphaned` becomes `{}`); no
// operator action required. v1/v2 are still rejected loudly because their
// registry / sourceConfig shapes differ.
export interface RelayStateShape {
  version: 4;
  sources: Record<string, SourceState>;
  providers: Record<string, Record<string, unknown>>;
  registry: Record<string, RegistryEntry>;
  orphaned: Record<string, OrphanEntry>;
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
  return { version: 4, sources: {}, providers: {}, registry: {}, orphaned: {} };
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
      // `version` on disk may be 3 (legacy, auto-upgraded) or 4 (current).
      // We type it loosely so the narrow v4 type on RelayStateShape doesn't
      // reject the legacy branch at compile time.
      const parsed = JSON.parse(raw) as {
        version?: number;
        sources?: RelayStateShape['sources'];
        providers?: RelayStateShape['providers'];
        registry?: RelayStateShape['registry'];
        orphaned?: RelayStateShape['orphaned'];
      };
      // v4 is current. v3 is upgraded seamlessly (GH #14 added `orphaned`
      // additively; no registry reshape). v1 and v2 are rejected loudly —
      // their registry / sourceConfig shapes are incompatible.
      if (parsed.version !== 3 && parsed.version !== 4) {
        throw new Error(
          `State file at ${resolved} is v${parsed.version ?? '<unknown>'}; this relay requires v4 (v3 is auto-upgraded). Remove the file and re-register sources (schema v3 moved provider settings under a nested \`provider:\` block; v4 added a per-file destination archive — see relay.md §Configuration schema).`,
        );
      }
      data = {
        version: 4,
        sources: parsed.sources ?? {},
        providers: parsed.providers ?? {},
        registry: parsed.registry ?? {},
        orphaned: parsed.orphaned ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Fresh state. Treated as v4 from the start.
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

  // Remove a registry entry. Cascades: moves every sources[filePath] whose
  // `relayId === id` into the `orphaned` archive (keyed by filePath) instead
  // of dropping it outright, so a later `relay add` against the same files
  // can rehydrate the provisioned destination rather than duplicating it
  // (GH #14). Returns the removed entry, or undefined if none.
  //
  // We key the archive by filePath alone (a path uniquely identifies a file
  // on disk) and stamp the providerType from the registry entry being
  // removed so rehydration can require a matching provider. If a prior
  // orphan exists for the same filePath (e.g. a rapid remove/re-add/remove
  // cycle against the same file) we overwrite it — the most recent
  // destination is the one still live on the messaging platform.
  removeRegistry(id: string): RegistryEntry | undefined {
    const existing = this.data.registry[id];
    if (!existing) return undefined;
    const providerType = existing.sourceConfig.provider.type;
    delete this.data.registry[id];
    // Cascade: archive instead of delete.
    const archivedAt = new Date().toISOString();
    for (const [filePath, src] of Object.entries(this.data.sources)) {
      if (src.relayId !== id) continue;
      // Archive unless disabled — a disabled mapping means the provider
      // already rejected the destination (topic deleted, thread gone), so
      // there is nothing useful to rehydrate. Drop it.
      if (!src.disabled) {
        this.data.orphaned[filePath] = {
          filePath,
          sourceName: src.sourceName,
          providerType,
          destination: src.destination,
          destinationKey: src.destinationKey,
          offset: src.offset,
          archivedAt,
        };
      }
      delete this.data.sources[filePath];
    }
    this.scheduleSave();
    return existing;
  }

  // ---- orphan archive (v4, GH #14) ----------------------------------------

  listOrphaned(): OrphanEntry[] {
    return Object.values(this.data.orphaned).map((o) => ({ ...o }));
  }

  getOrphan(filePath: string): OrphanEntry | undefined {
    const o = this.data.orphaned[filePath];
    return o ? { ...o } : undefined;
  }

  // Atomic rehydrate: if an archived destination for `filePath` matches the
  // incoming `sourceName` AND `providerType`, remove it from the archive and
  // return it so the caller can resume tailing without re-provisioning.
  // A mismatch leaves the orphan in place — a future matching re-register
  // can still pick it up.
  takeOrphan(
    filePath: string,
    sourceName: string,
    providerType: string,
  ): OrphanEntry | undefined {
    const o = this.data.orphaned[filePath];
    if (!o) return undefined;
    if (o.sourceName !== sourceName) return undefined;
    if (o.providerType !== providerType) return undefined;
    delete this.data.orphaned[filePath];
    this.scheduleSave();
    return { ...o };
  }

  // Drop an archived mapping unconditionally. Exposed so operators (and a
  // future `relay prune` command) can force a clean slate without editing
  // state.json by hand.
  clearOrphan(filePath: string): boolean {
    if (!(filePath in this.data.orphaned)) return false;
    delete this.data.orphaned[filePath];
    this.scheduleSave();
    return true;
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
