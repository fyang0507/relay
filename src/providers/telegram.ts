// Telegram provider. Implements the four-primitive Provider contract against
// the Bot API over HTTPS using Node's built-in fetch. No SDK dependency.
//
// See relay.md §Provider contract and §Viewer-side reconciliation.

import type { SourceConfig, SourceMetadata, Tier } from '../types.js';
import type {
  Destination,
  DeliverResult,
  InboundEvent,
  Provider,
} from './types.js';
import type {
  TgApiResponse,
  TgForumTopic,
  TgMessage,
  TgUpdate,
} from './telegramTypes.js';

// Telegram's hard text cap per message. We truncate above this with an ellipsis.
const TELEGRAM_TEXT_LIMIT = 4096;

// Telegram's hard cap on forum topic names (Bot API docs: 1-128 chars).
// We truncate silently above this so a long filename stem can't fail provisioning.
const TELEGRAM_TOPIC_NAME_LIMIT = 128;

// Long-poll window (seconds) for getUpdates. Below 30 to leave headroom under
// the typical 60s socket read timeout; above the default 0 so we actually
// benefit from long-polling.
const LONG_POLL_TIMEOUT_SECONDS = 25;

// Cap for backoff on transient network/5xx errors in the receive loop.
const MAX_BACKOFF_MS = 30_000;

// Concrete shape of a Telegram destination. `groupId` is the numeric chat id
// (supergroup, negative); `threadId` is the forum `message_thread_id`.
export interface TelegramDestination extends Record<string, unknown> {
  groupId: number;
  threadId: number;
}

// Constructor dependencies. The update_id cursor is read/written via callbacks
// so state persistence stays in `state.ts` and this class stays side-effect-free
// w.r.t. disk I/O.
//
// Phase 2: no `groups` name→id map anymore — credentials and config are
// now fully separated.
//
// Phase 3 (#6): the per-source chat id lives on the nested
// `SourceConfig.provider.groupId` (discriminated union variant
// `{ type: 'telegram', groupId }`). `provision` narrows by discriminant
// and reads the field from there.
export interface TelegramProviderOptions {
  botToken: string;
  getUpdateIdCursor: () => number | undefined;
  setUpdateIdCursor: (n: number) => void;
}

// Substrings that, on a 400 from sendMessage, mean "the topic is gone; don't
// retry and disable the mapping per relay.md §Viewer-side reconciliation."
const TOPIC_GONE_MARKERS = [
  'message thread not found',
  'topic_deleted',
  'TOPIC_DELETED',
  'chat not found',
];

function isTopicGone(description: string): boolean {
  const lower = description.toLowerCase();
  return TOPIC_GONE_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

// Truncate to the Telegram per-message cap. We keep 3 chars for the ellipsis
// so the posted text always fits under the limit.
export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  return text.slice(0, TELEGRAM_TEXT_LIMIT - 3) + '...';
}

// Small sleep utility that resolves early if the signal aborts.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class TelegramProvider implements Provider {
  public readonly name = 'telegram';

  private readonly botToken: string;
  private readonly getUpdateIdCursor: () => number | undefined;
  private readonly setUpdateIdCursor: (n: number) => void;

  // Tracks any in-flight fetch so `close()` can cancel it. Reset per call.
  private readonly inflight = new Set<AbortController>();
  // Set once close() is invoked so the receive loop can exit gracefully even
  // if the caller's signal is not aborted (e.g. daemon shutdown).
  private closed = false;

  constructor(opts: TelegramProviderOptions) {
    this.botToken = opts.botToken;
    this.getUpdateIdCursor = opts.getUpdateIdCursor;
    this.setUpdateIdCursor = opts.setUpdateIdCursor;
  }

  destinationKey(d: Destination): string {
    const td = d as TelegramDestination;
    return `${td.groupId}:${td.threadId}`;
  }

  // Phase 2: `provision` now takes the full `SourceConfig` as a second arg,
  // which carries the per-source `groupId` (raw chat id). We pass the whole
  // config instead of copying the one field onto `SourceMetadata` because
  // (a) the caller already has the config in hand, so there's no new
  // plumbing, and (b) this leaves the door open for future providers to
  // read additional source-scoped fields at provision time without another
  // round of type surgery.
  //
  // Phase 3 (#6): the per-source `groupId` now lives on the nested
  // `provider` block (discriminated union). We narrow by `provider.type`
  // and pull the field from there.
  async provision(
    meta: SourceMetadata,
    sourceConfig: SourceConfig,
  ): Promise<Destination> {
    if (sourceConfig.provider.type !== 'telegram') {
      throw new Error(
        `telegram.provision: expected provider.type "telegram", got "${sourceConfig.provider.type}" (source=${meta.sourceName})`,
      );
    }
    const groupId = sourceConfig.provider.groupId;
    // Topic name is always the file's stem. Developers who want a custom
    // title rename the file. We deliberately do NOT prepend `sourceName`:
    // developers dedicate one group per task type, so a collision is a
    // config mistake rather than a runtime concern. Truncate to Telegram's
    // 128-char hard cap so a long filename can't fail provisioning.
    const topicName = meta.filenameStem.slice(0, TELEGRAM_TOPIC_NAME_LIMIT);
    const result = await this.callApi<TgForumTopic>('createForumTopic', {
      chat_id: groupId,
      name: topicName,
    });
    if (!result.ok) {
      throw new Error(
        `telegram.provision: createForumTopic failed: ${result.error_code} ${result.description}`,
      );
    }
    const dest: TelegramDestination = {
      groupId,
      threadId: result.result.message_thread_id,
    };
    return dest;
  }

  async deliver(
    destination: Destination,
    text: string,
    tier: Tier,
  ): Promise<DeliverResult> {
    const td = destination as TelegramDestination;
    const payload = {
      chat_id: td.groupId,
      message_thread_id: td.threadId,
      text: truncateForTelegram(text),
      disable_notification: tier === 'silent',
    };

    let response = await this.callApi<TgMessage>('sendMessage', payload);

    // Honor a single retry_after on 429 (rate limit).
    if (!response.ok && response.error_code === 429) {
      const retryAfter = response.parameters?.retry_after ?? 1;
      await sleep(Math.min(retryAfter, 30) * 1000);
      response = await this.callApi<TgMessage>('sendMessage', payload);
    }

    if (response.ok) return { ok: true };

    // 400 with a "topic gone" description → permanent; disable the mapping.
    if (response.error_code === 400 && isTopicGone(response.description)) {
      return {
        ok: false,
        reason: `telegram: ${response.description}`,
        disableMapping: true,
      };
    }
    // Any other non-ok response is transient from the mapping's perspective.
    return {
      ok: false,
      reason: `telegram: ${response.error_code} ${response.description}`,
    };
  }

  // Long-poll getUpdates and yield only messages posted inside a known forum
  // topic (i.e. messages with `message_thread_id` and a `text`). System events
  // like forum_topic_created/closed are skipped. The update_id cursor is
  // advanced through `setUpdateIdCursor` after every update we see, so even
  // filtered-out updates aren't reprocessed on restart.
  async *receive(signal: AbortSignal): AsyncIterable<InboundEvent> {
    let backoff = 1000;

    while (!signal.aborted && !this.closed) {
      const cursor = this.getUpdateIdCursor();
      const offset = cursor === undefined ? undefined : cursor + 1;
      let updates: TgUpdate[];
      try {
        const resp = await this.callApi<TgUpdate[]>(
          'getUpdates',
          {
            ...(offset !== undefined ? { offset } : {}),
            timeout: LONG_POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message'],
          },
          // Use the caller's signal for getUpdates so `close()`/abort cancels
          // the long-poll promptly.
          { signal, timeoutMs: (LONG_POLL_TIMEOUT_SECONDS + 5) * 1000 },
        );
        if (!resp.ok) {
          // Transient API error — back off, do not advance cursor.
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }
        updates = resp.result;
        backoff = 1000;
      } catch (err) {
        if (signal.aborted || this.closed) return;
        // Network / aborted fetch / parse failure → back off and retry.
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }

      for (const update of updates) {
        if (signal.aborted || this.closed) return;
        // Always advance cursor so skipped updates aren't seen again.
        this.setUpdateIdCursor(update.update_id);

        const msg = update.message;
        if (!msg) continue;
        if (msg.message_thread_id === undefined) continue;
        // Skip topic-system events.
        if (
          msg.forum_topic_created ||
          msg.forum_topic_closed ||
          msg.forum_topic_reopened ||
          msg.forum_topic_edited
        ) {
          continue;
        }
        // Skip empty / non-text messages — relay's inbound contract is text.
        if (!msg.text) continue;

        const destination: TelegramDestination = {
          groupId: msg.chat.id,
          threadId: msg.message_thread_id,
        };
        yield { destination, text: msg.text, raw: msg };
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const ac of this.inflight) {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
    this.inflight.clear();
  }

  // --- internal plumbing ----------------------------------------------------

  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<TgApiResponse<T>> {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const ac = new AbortController();
    this.inflight.add(ac);

    // Forward the external signal to our internal controller so close() or the
    // caller's abort both cancel the in-flight fetch.
    const external = opts?.signal;
    const onExternalAbort = () => ac.abort();
    if (external) {
      if (external.aborted) ac.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Optional hard timeout so long-polls that hang get recycled.
    let timer: NodeJS.Timeout | null = null;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => ac.abort(), opts.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const json = (await res.json()) as TgApiResponse<T>;
      return json;
    } finally {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
      this.inflight.delete(ac);
    }
  }
}
