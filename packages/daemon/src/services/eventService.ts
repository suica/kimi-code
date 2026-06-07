/**
 * `EventService` (daemon-side `IEventService` impl, W5.2 / P0.16, extended
 * W7.2 with pub-sub API) — WS-broadcasting event service.
 *
 * Replaces the W4 stub (queue + `_drainForTest`) entirely. `publish(event)`
 * now:
 *   1. Extracts `session_id` from the agent-core `Event` (which carries
 *      `sessionId` camelCase per `agent-core/src/rpc/events.ts:320`).
 *   2. Increments the per-session `seq` counter (monotonic, starts at 1).
 *   3. Appends `{seq, envelope}` to the per-session ring buffer (capacity
 *      enforced in W5.3 at 1000; W5.2 keeps the buffer unbounded as a
 *      transitional step).
 *   4. Fans out to every WS connection subscribed via `ISessionClientsService`.
 *   5. **Phase C**: invokes any `subscribe(handler)` callbacks synchronously
 *      after fan-out. Handlers may call `this.publish(...)` to synthesize
 *      derived events (re-entrance terminates because synthesized events don't
 *      match the synthesis predicates in PromptService's private handler). This
 *      is the mechanism that synthesizes `prompt.completed` / `prompt.aborted`
 *      from `turn.ended` (agent-core's event union has no prompt-lifecycle
 *      types; see W7 §critical discovery point #2).
 *
 * Events without a `sessionId` (none are expected today — every agent-core
 * Event extends `AgentEvent & { agentId, sessionId }`) are dropped with a
 * warn log. We don't broadcast globally to avoid silent fan-out leaks.
 *
 * **Ring buffer state is per-session**: `Map<sessionId, SessionState>` so
 * different sessions count independently. WS.md §6: each session has its own
 * `nextSeq` starting at 1.
 *
 * **`getBufferedSince(sid, lastSeq)`** is the replay primitive consumed by
 * `WsConnection` (W5.3) for `client_hello.last_seq_by_session`. W5.2 ships
 * the API but no cap enforcement; W5.3 enforces the 1000-event cap and
 * tracks `oldestSeq` for the `resync_required` decision.
 *
 * **Anti-corruption**: Event payload comes from `@moonshot-ai/protocol`'s
 * re-export of agent-core, NOT from the SDK package directly.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';
import { IEventReplayService, IEventService } from '@moonshot-ai/services';

import type { ILogger } from './logger.js';
import type { ISessionClientsService } from './session-clients.js';

import { buildEventEnvelope, type EventEnvelope } from '../ws/protocol.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IEventService = IEventService; // keep `implements` retained
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _replayAnchor: typeof IEventReplayService = IEventReplayService;

interface BufferEntry {
  seq: number;
  envelope: EventEnvelope<Event>;
}

interface SessionState {
  /** Highest `seq` dispatched. Starts at 0; first event gets `seq=1`. */
  seq: number;
  /** Append-only ring buffer; W5.3 caps at `maxBufferSize`. */
  buffer: BufferEntry[];
  /** Lowest `seq` still in `buffer`. W5.3 increments when evicting. */
  oldestSeq: number;
}

export interface BufferedSinceResult {
  events: BufferEntry[];
  /**
   * True iff `lastSeq + 1 < oldestSeq` (the client's gap is older than what
   * the buffer retains). The connection should send a `resync_required`
   * frame for this session and NOT replay events.
   */
  resyncRequired: boolean;
  /** Highest dispatched `seq` for the session (0 if no events yet). */
  currentSeq: number;
}

export interface EventServiceOptions {
  /** Ring buffer cap per session. W5.2 ignores this; W5.3 enforces it. */
  maxBufferSize?: number;
}

/** Default ring buffer cap (WS.md §3.1, §6). */
export const DEFAULT_MAX_BUFFER_SIZE = 1000;

export class EventService
  extends Disposable
  implements IEventService, IEventReplayService
{
  readonly _serviceBrand: undefined;

  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxBufferSize: number;
  private readonly _subscribers = new Set<(e: Event) => void>();

  constructor(
    private readonly logger: ILogger,
    private readonly sessionClients: ISessionClientsService,
    options: EventServiceOptions = {},
  ) {
    super();
    this._maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  /**
   * Phase C — subscribe to all published events. The handler is called
   * synchronously AFTER WS fan-out; it may call `this.publish(...)` to
   * synthesize derived events (re-entrance terminates naturally because
   * synthesized `prompt.*` events don't match the `turn.*` predicates).
   *
   * Returns an idempotent detach function; pass it to
   * `Disposable._register({ dispose: detach })` so it tears down with the
   * owning service.
   */
  subscribe(handler: (event: Event) => void): () => void {
    this._subscribers.add(handler);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this._subscribers.delete(handler);
    };
  }

  publish(event: Event): void {
    if (this._isDisposed) return;
    const sid = extractSessionId(event);
    const evType = (event as { type?: string }).type ?? '<no-type>';
    if (!sid) {
      this.logger.warn(
        { eventType: evType, eventKeys: Object.keys(event as object) },
        '[DBG eventService.publish] event has no session_id; dropping',
      );
      return;
    }
    const state = this._getOrCreateSession(sid);
    state.seq += 1;
    const envelope = buildEventEnvelope(state.seq, sid, event);
    state.buffer.push({ seq: state.seq, envelope });

    // Ring buffer cap (W5.3 behavior; W5.2 still ships the same enforcement
    // because the API needs to be self-consistent even before
    // `getBufferedSince` returns `resyncRequired=true`).
    while (state.buffer.length > this._maxBufferSize) {
      const evicted = state.buffer.shift();
      if (evicted) state.oldestSeq = evicted.seq + 1;
    }

    // Fan-out to subscribers. `getConnections` returns an iterable view; we
    // capture into an array to avoid mutating-iterator hazards if a send()
    // synchronously triggers a forgetConnection (e.g. socket error → close).
    const targets = Array.from(this.sessionClients.getConnections(sid));
    this.logger.info(
      { eventType: evType, sessionId: sid, seq: state.seq, targetCount: targets.length },
      '[DBG eventService.publish] fan-out',
    );
    for (const conn of targets) {
      conn.send(envelope);
    }

    // Phase C — call pub-sub subscribers AFTER fan-out. Each handler may call
    // `this.publish(...)` to synthesize derived events. Re-entrance terminates
    // naturally: synthesized `prompt.*` events don't match the `turn.*`
    // predicates in PromptService's handler, so no infinite loop. Errors in
    // one handler don't block the others (logged and swallowed).
    if (this._subscribers.size > 0) {
      for (const handler of Array.from(this._subscribers)) {
        try {
          handler(event);
        } catch (err) {
          this.logger.warn(
            { err: String(err) },
            'eventService subscriber threw; ignoring',
          );
        }
      }
    }
  }

  /**
   * Fetch buffered events with `seq > lastSeq` for `sid`.
   *
   * Result interpretation (per WS.md §6):
   *   - `currentSeq == 0` (session has no events yet) → empty replay,
   *     `resyncRequired=false`.
   *   - `lastSeq >= currentSeq` → client is caught up, empty replay,
   *     `resyncRequired=false`.
   *   - `lastSeq + 1 < oldestSeq` → buffer evicted past the client's
   *     position → `resyncRequired=true`, empty events.
   *   - otherwise → events with `seq > lastSeq`, in order.
   *
   * Sessions never seen by `publish` return `currentSeq=0, events=[],
   * resyncRequired=false` — there's nothing to resync FROM, the session
   * just hasn't emitted yet.
   */
  getBufferedSince(sid: string, lastSeq: number): BufferedSinceResult {
    const state = this._sessions.get(sid);
    if (!state) {
      return { events: [], resyncRequired: false, currentSeq: 0 };
    }
    if (lastSeq >= state.seq) {
      return { events: [], resyncRequired: false, currentSeq: state.seq };
    }
    if (lastSeq + 1 < state.oldestSeq) {
      return { events: [], resyncRequired: true, currentSeq: state.seq };
    }
    const events = state.buffer.filter((e) => e.seq > lastSeq);
    return { events, resyncRequired: false, currentSeq: state.seq };
  }

  /**
   * Highest dispatched `seq` for the session (0 if never published).
   * Public companion to `_currentSeqForTest` — used by the WS abort handler
   * to populate `at_seq` in the idempotent-abort ack (W7.3).
   */
  currentSeq(sid: string): number {
    return this._sessions.get(sid)?.seq ?? 0;
  }

  /** Test helper — current seq for a session (0 if never published). */
  _currentSeqForTest(sid: string): number {
    return this._sessions.get(sid)?.seq ?? 0;
  }

  /** Test helper — buffer length for a session (0 if never published). */
  _bufferLengthForTest(sid: string): number {
    return this._sessions.get(sid)?.buffer.length ?? 0;
  }

  /** Test helper — oldestSeq tracked for a session (0 if never published). */
  _oldestSeqForTest(sid: string): number {
    return this._sessions.get(sid)?.oldestSeq ?? 0;
  }

  private _getOrCreateSession(sid: string): SessionState {
    let state = this._sessions.get(sid);
    if (!state) {
      state = { seq: 0, buffer: [], oldestSeq: 1 };
      this._sessions.set(sid, state);
    }
    return state;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._subscribers.clear();
    this._sessions.clear();
    super.dispose();
  }
}

/**
 * Pull a session id off an Event. agent-core's Event union is `AgentEvent &
 * { agentId, sessionId }` (camelCase) per
 * `packages/agent-core/src/rpc/events.ts:320`. WS wire format is
 * `session_id` (snake_case) — the toWire mapping (WS.md §7.5) is a Phase 2
 * concern; for Stage 1 the inbound side is the agent-core camelCase shape.
 *
 * We accept both `sessionId` and `session_id` defensively so tests can pass
 * either spelling, and so future wire-mapped events still extract correctly.
 */
function extractSessionId(event: Event): string | undefined {
  const camel = (event as { sessionId?: unknown }).sessionId;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = (event as { session_id?: unknown }).session_id;
  if (typeof snake === 'string' && snake.length > 0) return snake;
  return undefined;
}

