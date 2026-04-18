// Persistent state store. See relay.md §Startup and backfill behavior.
//
// Single JSON file at ~/.relay/state.json. Tracks:
//   - per-source-file offset and mapped destination
//   - per-provider generic key/value bag (e.g. telegram update_id cursor)
//
// Writes are debounced (~500ms) and serialized through an internal queue; each
// save is an atomic write (tmp → fsync → rename). Single-process daemon — no
// cross-process file lock in V1.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { Destination } from './providers/types.js';

// Persisted per-source-file state. See relay.md §Startup and backfill behavior.
export interface SourceState {
  sourceName: string;
  offset: number;
  destination: Destination;
  destinationKey: string;
  disabled?: boolean;
  disabledReason?: string;
}

// On-disk shape. `version` lets us migrate in future.
export interface RelayStateShape {
  version: 1;
  sources: Record<string, SourceState>;
  providers: Record<string, Record<string, unknown>>;
}

const DEFAULT_STATE_PATH = path.join(os.homedir(), '.relay', 'state.json');
const AUTOSAVE_DEBOUNCE_MS = 500;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function freshState(): RelayStateShape {
  return { version: 1, sources: {}, providers: {} };
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
      const parsed = JSON.parse(raw) as Partial<RelayStateShape>;
      data = {
        version: 1,
        sources: parsed.sources ?? {},
        providers: parsed.providers ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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

  findSourceByDestinationKey(
    key: string,
  ): { filePath: string; state: SourceState } | undefined {
    for (const [filePath, state] of Object.entries(this.data.sources)) {
      if (state.destinationKey === key) return { filePath, state };
    }
    return undefined;
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
