/**
 * `PromptService` (Chain 4 / P1.4, W7.2) unit tests.
 *
 * Hermetic: a fake `ICoreProcessService` returns canned session list + records
 * the `prompt` / `cancel` payloads. A stub `IEventService` collects published
 * events into an array we can inspect and drives synthesis via
 * `bus.publish(turn.*)` → PromptService's private subscriber.
 *
 * Coverage:
 *   - submit(sid, body) returns {prompt_id, user_message_id}
 *   - submit registers an active prompt → busy detection on second submit
 *   - submit translates protocol content → kosong content (text + image_url)
 *   - submit on unknown sid → SessionNotFoundError
 *   - submit on a session with an active completed/aborted prompt succeeds
 *   - bus.publish of `turn.started` captures turnId (via PromptService subscriber)
 *   - bus.publish of `turn.ended` (top-level, completed) synthesizes prompt.completed
 *   - bus.publish of `turn.ended` with reason=cancelled synthesizes prompt.aborted
 *   - bus.publish of nested turn.ended ignored (non-top-level)
 *   - bus.publish on events for an unknown session is a no-op
 *   - abort() rejects PromptNotFoundError when no active prompt
 *   - abort() returns {aborted: true} + publishes prompt.aborted
 *   - second abort() → PromptAlreadyCompletedError (40903)
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  CoreRPC,
  Event,
  SessionSummary,
} from '@moonshot-ai/agent-core';

import {
  type IAuthSummaryService,
  type IEventService,
  type ICoreProcessService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  PromptService,
  SessionBusyError,
  SessionNotFoundError,
} from '../src';

const SID = 'sess_01PT';
const SESSION_CREATED_AT = 1_700_000_000_000;

function mkSummary(id = SID): SessionSummary {
  return {
    id,
    workDir: '/tmp/ws',
    sessionDir: `/tmp/sessions/${id}`,
    createdAt: SESSION_CREATED_AT,
    updatedAt: SESSION_CREATED_AT,
  };
}

interface RpcRecord {
  promptCalls: unknown[];
  cancelCalls: unknown[];
}

function makeBridge(
  sessions: SessionSummary[] = [mkSummary()],
): { bridge: ICoreProcessService; record: RpcRecord } {
  const record: RpcRecord = { promptCalls: [], cancelCalls: [] };
  const rpc: Partial<CoreRPC> = {
    listSessions: vi.fn().mockImplementation(async () => sessions),
    prompt: vi.fn().mockImplementation(async (payload) => {
      record.promptCalls.push(payload);
    }),
    cancel: vi.fn().mockImplementation(async (payload) => {
      record.cancelCalls.push(payload);
    }),
  };
  const bridge: ICoreProcessService = {
    rpc: rpc as CoreRPC,
    ready: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    _serviceBrand: undefined,
  };
  return { bridge, record };
}

function makeBus(): { bus: IEventService; events: Event[]; triggerSubscribers: (e: Event) => void } {
  const events: Event[] = [];
  const subscribers = new Set<(e: Event) => void>();
  const bus: IEventService = {
    publish: (e: Event) => {
      events.push(e);
      // Drive any subscribers (mirrors EventService publish → subscriber call).
      for (const h of Array.from(subscribers)) h(e);
    },
    subscribe: (handler: (e: Event) => void) => {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    _serviceBrand: undefined,
  };
  // Helper to push an event into the bus WITHOUT recording it in `events`
  // (i.e. simulate agent-core emitting a raw event that the bus fans out).
  function triggerSubscribers(e: Event): void {
    for (const h of Array.from(subscribers)) h(e);
  }
  return { bus, events, triggerSubscribers };
}

/**
 * Stub `IAuthSummaryService` for hermetic prompt-service tests. Default
 * `ensureReady()` resolves; tests that need to exercise the readiness gate
 * can pass `{ ensureReadyError }` and assert the error surfaces.
 */
function makeAuth(opts: { ensureReadyError?: Error } = {}): IAuthSummaryService {
  return {
    get: vi.fn().mockResolvedValue({
      ready: true,
      providers_count: 1,
      default_model: 'kimi-k2',
      managed_provider: null,
    }),
    ensureReady: vi.fn().mockImplementation(async () => {
      if (opts.ensureReadyError) throw opts.ensureReadyError;
    }),
    _serviceBrand: undefined,
  };
}

describe('PromptService.submit (W7.2)', () => {
  it('returns ULID-shaped prompt_id + user_message_id derived from it', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    const result = await impl.submit(SID, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(result.prompt_id).toMatch(/^prompt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.user_message_id).toMatch(/^msg_sess_01PT_pending_prompt_/);
  });

  it('translates text + image content to kosong ContentParts', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await impl.submit(SID, {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', source: { kind: 'url', url: 'https://a.png' } },
      ],
    });
    expect(record.promptCalls).toHaveLength(1);
    const payload = record.promptCalls[0] as {
      sessionId: string;
      agentId: string;
      input: Array<Record<string, unknown>>;
    };
    expect(payload.sessionId).toBe(SID);
    expect(payload.agentId).toBe('main');
    expect(payload.input).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', imageUrl: { url: 'https://a.png' } },
    ]);
  });

  it('throws SessionBusyError when a non-terminal prompt is already active', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'one' }] });
    await expect(
      impl.submit(SID, { content: [{ type: 'text', text: 'two' }] }),
    ).rejects.toBeInstanceOf(SessionBusyError);
  });

  it('throws SessionNotFoundError on unknown session id', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await expect(
      impl.submit('sess_missing', { content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('clears active state if bridge.prompt() rejects', async () => {
    const sessions = [mkSummary()];
    const promptMock = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const rpc: Partial<CoreRPC> = {
      listSessions: vi.fn().mockResolvedValue(sessions),
      prompt: promptMock,
      cancel: vi.fn().mockImplementation(async () => undefined),
    };
    const bridge: ICoreProcessService = {
      rpc: rpc as CoreRPC,
      ready: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      _serviceBrand: undefined,
    };
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await expect(
      impl.submit(SID, { content: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrowError(/boom/);
    // A second submit must succeed (state was cleared).
    await impl.submit(SID, { content: [{ type: 'text', text: 'x' }] });
  });
});

describe('PromptService lifecycle synthesis (via IEventService.subscribe)', () => {
  it('captures turnId on the first turn.started after submit', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 42,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._activeForTest(SID)?.turnId).toBe(42);
  });

  it('ignores subsequent turn.started events (treated as nested turns)', async () => {
    const { bridge } = makeBridge();
    const { bus, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 42,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    triggerSubscribers({
      type: 'turn.started',
      turnId: 99,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._activeForTest(SID)?.turnId).toBe(42);
  });

  it('synthesizes prompt.completed on top-level turn.ended (reason=completed)', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    // Clear submit-related events; we want to inspect the synthesis result.
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    // The bus.publish was called with the synth event.
    expect(events).toHaveLength(1);
    const synth = events[0] as unknown as {
      type: string;
      promptId: string;
      reason: string;
    };
    expect(synth.type).toBe('prompt.completed');
    expect(synth.promptId).toBe(submit.prompt_id);
    expect(synth.reason).toBe('completed');
    // Active state cleared.
    expect(impl._activeForTest(SID)).toBeUndefined();
  });

  it('fires onPromptCompleted handler before bus.publish', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    const handlerArgs: unknown[] = [];
    const handlerCalledBeforePublish: boolean[] = [];
    impl.onPromptCompleted((e) => {
      handlerArgs.push(e);
      // At handler call time, bus.publish hasn't been called for this synth yet.
      handlerCalledBeforePublish.push(events.filter(ev => (ev as unknown as { type?: string }).type === 'prompt.completed').length === 0);
    });
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(handlerArgs).toHaveLength(1);
    expect((handlerArgs[0] as { promptId: string }).promptId).toBe(submit.prompt_id);
    expect(handlerCalledBeforePublish[0]).toBe(true);
  });

  it('synthesizes prompt.aborted on top-level turn.ended (reason=cancelled)', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 8,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 8,
      reason: 'cancelled',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('ignores nested turn.ended (different turnId) so prompt stays active', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 99,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toEqual([]);
    expect(impl._activeForTest(SID)?.completed).toBe(false);
  });

  it('is a no-op for events on a session with no active prompt', async () => {
    const { bridge } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    triggerSubscribers({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(events).toEqual([]);
  });
});

describe('PromptService.abort (W7.3)', () => {
  it('throws PromptNotFoundError when no active prompt for the session', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    await expect(impl.abort(SID, 'prompt_xyz')).rejects.toBeInstanceOf(
      PromptNotFoundError,
    );
  });

  it('returns {aborted: true} and publishes prompt.aborted', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events, triggerSubscribers } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, {
      content: [{ type: 'text', text: 'hi' }],
    });
    triggerSubscribers({
      type: 'turn.started',
      turnId: 5,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    events.length = 0;
    const result = await impl.abort(SID, submit.prompt_id);
    expect(result.aborted).toBe(true);
    // bridge.rpc.cancel called with the captured turnId.
    expect(record.cancelCalls).toHaveLength(1);
    expect(record.cancelCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
      turnId: 5,
    });
    // prompt.aborted published.
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('throws PromptAlreadyCompletedError on the second abort', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptService(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, {
      content: [{ type: 'text', text: 'hi' }],
    });
    await impl.abort(SID, submit.prompt_id);
    await expect(impl.abort(SID, submit.prompt_id)).rejects.toBeInstanceOf(
      PromptAlreadyCompletedError,
    );
  });
});
