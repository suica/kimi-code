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
