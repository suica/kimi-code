/**
 * `IEventService` — pub-sub bus that fans out ordered `Event`s coming out of
 * `KimiCore` to the outside world (daemon → WS clients in P1.x; tests can use
 * a no-op impl).
 *
 * The service sits on the receive-end of the in-process RPC adapter: when an
 * agent step emits an event, `CoreProcessService`'s `BridgeClientAPI.emitEvent`
 * forwards it to `IEventService.publish(event)`. The concrete impl ships in
 * the daemon package.
 *
 * Decorator name `'eventService'` is the diagnostic string surfaced in
 * `CyclicDependencyError.path` and `'No service registered for identifier ...'`
 * messages.
 *
 * Role: pub-sub bus — see `packages/services/AGENTS.md`. Per-domain typed
 * `onDidXxx: Event<T>` accessors layer on top of this central stream
 * (e.g. `PromptService.onDidComplete`, `SessionService.onDidCreate`).
 *
 * `IEventReplayService` (below) is a daemon-local companion contract that
 * exposes the WS ring-buffer replay surface (`getBufferedSince`,
 * `currentSeq`). It's split from `IEventService` so consumers like
 * `WSGateway` can take a typed `@IEventReplayService` dependency instead of
 * importing the concrete daemon `EventService` class — that frees us to
 * replace the impl without changing call sites and lets non-WS consumers
 * stay on the lean `IEventService` shape. Production wires both decorators
 * to the same `EventService` singleton (`start.ts`).
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';

export interface IEventService {
  readonly _serviceBrand: undefined;

  /**
   * Publish a fully-formed `Event` to all subscribers. Synchronous; the
   * adapter does not await delivery — fan-out is the service's concern.
   */
  publish(event: Event): void;

  /**
   * Subscribe to all published events. The handler is called synchronously
   * AFTER WS fan-out on each `publish(event)` call.
   *
   * Returns a detach function. Pass it to `Disposable._register({ dispose:
   * detach })` so the subscription is torn down when the owner disposes.
   */
  subscribe(handler: (event: Event) => void): () => void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventService = createDecorator<IEventService>('eventService');

/**
 * Daemon-local replay surface: ring-buffer lookup keyed by `(sessionId,
 * lastSeq)` and a per-session `currentSeq` accessor. Consumed by `WSGateway`
 * / `WsConnection` for `client_hello.last_seq_by_session` replay (WS.md §6)
 * and by the WS abort ack to populate `at_seq` on idempotent calls (W7.3).
 *
 * `getBufferedSince` result interpretation:
 *   - `currentSeq == 0`           → session has no events yet; empty replay.
 *   - `lastSeq >= currentSeq`     → client is caught up.
 *   - `lastSeq + 1 < oldestSeq`   → buffer evicted past client; resyncRequired.
 *   - otherwise                   → events with `seq > lastSeq`, in order.
 *
 * Split from `IEventService` so `WSGateway` can depend on the contract
 * directly via `@IEventReplayService` instead of `import { EventService }
 * from '../services/eventService.js'`. In production both decorators alias
 * to the same `EventService` singleton (`start.ts`); in tests a stub can
 * implement just this contract.
 */
/**
 * Structural envelope shape returned by `IEventReplayService.getBufferedSince`.
 * Mirrors the daemon's wire `EventEnvelope<Event>` (see
 * `packages/daemon/src/ws/protocol.ts`) so the daemon-local
 * `BufferReplaySource` consumer (`WsConnection`) accepts an
 * `IEventReplayService`-typed source without a cast. Declared inline here
 * (not imported from daemon) because `@moonshot-ai/services` must not depend
 * on `@moonshot-ai/daemon`.
 */
export interface EventReplayEnvelope {
  type: string;
  seq: number;
  session_id: string;
  timestamp: string;
  payload: Event;
}

export interface IEventReplayService {
  readonly _serviceBrand: undefined;

  /**
   * Fetch buffered events with `seq > lastSeq` for `sessionId`.
   */
  getBufferedSince(
    sessionId: string,
    lastSeq: number,
  ): {
    events: Array<{ seq: number; envelope: EventReplayEnvelope }>;
    resyncRequired: boolean;
    currentSeq: number;
  };

  /**
   * Highest dispatched `seq` for the session (0 if never published).
   * Used by the WS abort ack to populate `at_seq` on idempotent calls.
   */
  currentSeq(sessionId: string): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventReplayService =
  createDecorator<IEventReplayService>('eventReplayService');
