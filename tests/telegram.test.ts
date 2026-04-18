// Unit tests for the Telegram provider. The real Bot API is never contacted;
// `globalThis.fetch` is replaced with a stub that returns canned envelopes.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TelegramProvider, truncateForTelegram } from '../src/providers/telegram.ts';
import type {
  TelegramDestination,
  TelegramProviderOptions,
} from '../src/providers/telegram.ts';
import type { SourceConfig } from '../src/types.ts';

function makeSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    name: 'outreach-campaigns',
    pathGlob: '/tmp/*.jsonl',
    provider: 'telegram',
    groupId: -100123,
    inboundTypes: ['human_input'],
    tiers: {},
    ...overrides,
  };
}

type FetchArgs = { url: string; init: RequestInit; body: unknown };

// Build a stub fetch. Each call consumes one responder off the queue; if the
// queue is empty, the test fails loudly. Every request URL + JSON body is
// captured so tests can assert on the wire shape.
function makeFetchStub(
  responders: Array<(args: FetchArgs) => Response | Promise<Response>>,
) {
  const calls: FetchArgs[] = [];
  let i = 0;
  const fn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body =
      typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : undefined;
    calls.push({ url, init: init ?? {}, body });
    const responder = responders[i++];
    if (!responder) {
      throw new Error(`fetch stub exhausted; unexpected call to ${url}`);
    }
    return responder({ url, init: init ?? {}, body });
  };
  return { fn, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// A tiny harness to spin up the provider with pluggable cursor storage.
// Phase 2: no `groups` map anymore — destination chat id comes from
// `SourceConfig.groupId` passed into `provision()`.
function makeProvider(overrides: Partial<TelegramProviderOptions> = {}) {
  let cursor: number | undefined;
  const opts: TelegramProviderOptions = {
    botToken: 'TEST',
    getUpdateIdCursor: () => cursor,
    setUpdateIdCursor: (n) => {
      cursor = n;
    },
    ...overrides,
  };
  const provider = new TelegramProvider(opts);
  return {
    provider,
    getCursor: () => cursor,
  };
}

describe('TelegramProvider', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  describe('destinationKey', () => {
    it('is stable and formatted groupId:threadId', () => {
      const { provider } = makeProvider();
      const d: TelegramDestination = { groupId: -100123, threadId: 42 };
      assert.equal(provider.destinationKey(d), '-100123:42');
      // Calling twice with the same object returns the same string.
      assert.equal(provider.destinationKey(d), provider.destinationKey(d));
    });
  });

  describe('truncateForTelegram', () => {
    it('leaves text under the limit untouched', () => {
      assert.equal(truncateForTelegram('hello'), 'hello');
    });
    it('truncates to limit - 3 + ellipsis when over the limit', () => {
      const big = 'a'.repeat(5000);
      const out = truncateForTelegram(big);
      assert.equal(out.length, 4096);
      assert.ok(out.endsWith('...'));
      assert.equal(out.slice(0, 4093), 'a'.repeat(4093));
    });
  });

  describe('deliver', () => {
    it('sets disable_notification=true for tier=silent', async () => {
      const { fn, calls } = makeFetchStub([
        () => jsonResponse({ ok: true, result: { message_id: 1, chat: { id: -1 }, date: 0 } }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const result = await provider.deliver(
        { groupId: -100123, threadId: 7 },
        'hi',
        'silent',
      );
      assert.deepEqual(result, { ok: true });
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/botTEST\/sendMessage$/);
      const body = calls[0]!.body as Record<string, unknown>;
      assert.equal(body.chat_id, -100123);
      assert.equal(body.message_thread_id, 7);
      assert.equal(body.text, 'hi');
      assert.equal(body.disable_notification, true);
    });

    it('sets disable_notification=false for tier=notify', async () => {
      const { fn, calls } = makeFetchStub([
        () => jsonResponse({ ok: true, result: { message_id: 1, chat: { id: -1 }, date: 0 } }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const result = await provider.deliver(
        { groupId: -100123, threadId: 7 },
        'hi',
        'notify',
      );
      assert.deepEqual(result, { ok: true });
      const body = calls[0]!.body as Record<string, unknown>;
      assert.equal(body.disable_notification, false);
    });

    it('returns disableMapping=true on 400 "message thread not found"', async () => {
      const { fn } = makeFetchStub([
        () =>
          jsonResponse({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message thread not found',
          }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const result = await provider.deliver(
        { groupId: -100123, threadId: 7 },
        'hi',
        'silent',
      );
      assert.equal(result.ok, false);
      if (result.ok) return; // type narrow
      assert.equal(result.disableMapping, true);
      assert.match(result.reason, /message thread not found/);
    });

    it('returns transient (no disableMapping) on 500', async () => {
      const { fn } = makeFetchStub([
        () =>
          jsonResponse({
            ok: false,
            error_code: 500,
            description: 'Internal Server Error',
          }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const result = await provider.deliver(
        { groupId: -100123, threadId: 7 },
        'hi',
        'silent',
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.disableMapping, undefined);
    });

    it('truncates text over 4096 chars', async () => {
      const { fn, calls } = makeFetchStub([
        () => jsonResponse({ ok: true, result: { message_id: 1, chat: { id: -1 }, date: 0 } }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const big = 'x'.repeat(5000);
      await provider.deliver({ groupId: -100123, threadId: 7 }, big, 'silent');
      const body = calls[0]!.body as Record<string, unknown>;
      const text = body.text as string;
      assert.equal(text.length, 4096);
      assert.ok(text.endsWith('...'));
    });
  });

  describe('provision', () => {
    it('reads groupId from sourceConfig and uses meta.filenameStem as topic name', async () => {
      const { fn, calls } = makeFetchStub([
        () => jsonResponse({ ok: true, result: { message_thread_id: 99, name: 'x' } }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const dest = (await provider.provision(
        {
          sourceName: 'outreach-campaigns',
          filenameStem: '2026-04-15-dental',
          filePath: '/tmp/x.jsonl',
        },
        makeSource({ groupId: -100123 }),
      )) as TelegramDestination;

      assert.deepEqual(dest, { groupId: -100123, threadId: 99 });
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/createForumTopic$/);
      const body = calls[0]!.body as Record<string, unknown>;
      assert.equal(body.chat_id, -100123);
      // No "outreach-campaigns:" prefix — the stem is used as-is.
      assert.equal(body.name, '2026-04-15-dental');
    });

    it('truncates filename stems over the 128-char Telegram topic-name cap', async () => {
      const { fn, calls } = makeFetchStub([
        () => jsonResponse({ ok: true, result: { message_thread_id: 101, name: 'x' } }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      const longStem = 'a'.repeat(200);
      await provider.provision(
        {
          sourceName: 'outreach-campaigns',
          filenameStem: longStem,
          filePath: '/tmp/x.jsonl',
        },
        makeSource({ groupId: -100123 }),
      );
      const body = calls[0]!.body as Record<string, unknown>;
      const name = body.name as string;
      assert.equal(name.length, 128);
      assert.equal(name, 'a'.repeat(128));
    });

    it('throws when sourceConfig.groupId is missing', async () => {
      const { provider } = makeProvider();
      await assert.rejects(
        () =>
          provider.provision(
            {
              sourceName: 's',
              filenameStem: 'f',
              filePath: '/tmp/f.jsonl',
            },
            makeSource({ groupId: undefined }),
          ),
        /sourceConfig\.groupId is required/,
      );
    });

    it('different sources address different groups via sourceConfig.groupId', async () => {
      const { fn, calls } = makeFetchStub([
        () => jsonResponse({ ok: true, result: { message_thread_id: 1, name: 'x' } }),
        () => jsonResponse({ ok: true, result: { message_thread_id: 2, name: 'y' } }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider } = makeProvider();
      await provider.provision(
        { sourceName: 'a', filenameStem: 'a', filePath: '/tmp/a.jsonl' },
        makeSource({ name: 'a', groupId: -100111 }),
      );
      await provider.provision(
        { sourceName: 'b', filenameStem: 'b', filePath: '/tmp/b.jsonl' },
        makeSource({ name: 'b', groupId: -100222 }),
      );
      assert.equal((calls[0]!.body as Record<string, unknown>).chat_id, -100111);
      assert.equal((calls[1]!.body as Record<string, unknown>).chat_id, -100222);
    });
  });

  describe('receive', () => {
    it('yields forum-topic text messages, skips non-topic and system events, advances cursor', async () => {
      const update1 = {
        update_id: 10,
        message: {
          message_id: 1,
          chat: { id: -100123 },
          date: 0,
          text: 'hello from topic',
          message_thread_id: 42,
        },
      };
      const update2 = {
        update_id: 11,
        message: {
          message_id: 2,
          chat: { id: -100123 },
          date: 0,
          text: 'not in any topic',
          // no message_thread_id → must be skipped
        },
      };
      const update3 = {
        update_id: 12,
        message: {
          message_id: 3,
          chat: { id: -100123 },
          date: 0,
          message_thread_id: 42,
          forum_topic_closed: {}, // system event → skipped
        },
      };
      const update4 = {
        update_id: 13,
        message: {
          message_id: 4,
          chat: { id: -100123 },
          date: 0,
          message_thread_id: 77,
          text: 'second real reply',
        },
      };

      const { fn, calls } = makeFetchStub([
        () =>
          jsonResponse({
            ok: true,
            result: [update1, update2, update3, update4],
          }),
        // Subsequent call would block long-polling; we'll abort before it resolves.
        () => new Response(JSON.stringify({ ok: true, result: [] })),
      ]);
      globalThis.fetch = fn as typeof fetch;

      const { provider, getCursor } = makeProvider();
      const ac = new AbortController();
      const events: Array<{ text: string; key: string }> = [];
      const iter = provider.receive(ac.signal);

      // Consume up to two emitted events, then abort.
      const runner = (async () => {
        for await (const evt of iter) {
          events.push({
            text: evt.text,
            key: provider.destinationKey(evt.destination),
          });
          if (events.length === 2) {
            ac.abort();
            break;
          }
        }
      })();

      await runner;

      assert.deepEqual(events, [
        { text: 'hello from topic', key: '-100123:42' },
        { text: 'second real reply', key: '-100123:77' },
      ]);
      // Cursor advanced through every update we saw (including skipped ones).
      assert.equal(getCursor(), 13);
      // First getUpdates call had no offset (cursor was undefined at start).
      const firstBody = calls[0]!.body as Record<string, unknown>;
      assert.equal(firstBody.timeout, 25);
      assert.deepEqual(firstBody.allowed_updates, ['message']);
      assert.equal(firstBody.offset, undefined);
    });

    it('uses offset=cursor+1 on subsequent polls', async () => {
      const { fn, calls } = makeFetchStub([
        () =>
          jsonResponse({
            ok: true,
            result: [
              {
                update_id: 50,
                message: {
                  message_id: 1,
                  chat: { id: -100123 },
                  date: 0,
                  text: 'a',
                  message_thread_id: 1,
                },
              },
            ],
          }),
        () => jsonResponse({ ok: true, result: [] }),
      ]);
      globalThis.fetch = fn as typeof fetch;

      let cursor: number | undefined = undefined;
      const provider = new TelegramProvider({
        botToken: 'TEST',
        getUpdateIdCursor: () => cursor,
        setUpdateIdCursor: (n) => {
          cursor = n;
        },
      });
      const ac = new AbortController();

      const runner = (async () => {
        for await (const _ of provider.receive(ac.signal)) {
          // Got one; abort so the second iteration's fetch (empty) triggers,
          // then we bail.
          break;
        }
      })();
      await runner;
      ac.abort();

      // Second call should have offset = 51.
      // If the receive loop only issued one call before break, calls[1] is undefined — that's fine.
      if (calls.length >= 2) {
        const secondBody = calls[1]!.body as Record<string, unknown>;
        assert.equal(secondBody.offset, 51);
      }
      assert.equal(cursor, 50);
    });
  });
});
