/**
 * Reverse-RPC broker: emits ordered `Event`s coming out of `KimiCore` to the
 * outside world (daemon → WS clients in P1.x; tests can use a no-op impl in W3).
 *
 * The broker is the receive-end of the in-process RPC bridge: when an agent
 * step emits an event, `HarnessBridge`'s `BridgeClientAPI.emitEvent(event)`
 * forwards it to `IEventBus.publish(event)`. Concrete impls land in W5/Chain N.
 *
 * Decorator name `'eventBus'` is the diagnostic string surfaced in
 * `CyclicDependencyError.path` and `'No service registered for identifier ...'`
 * messages.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';

export interface IEventBus {
  readonly _serviceBrand: undefined;

  /**
   * Publish a fully-formed `Event` to all subscribers. Synchronous; the bridge
   * does not await delivery — fan-out is the broker's concern.
   */
  publish(event: Event): void;

  /**
   * Subscribe to all published events. The handler is called synchronously
   * AFTER WS fan-out on each `publish(event)` call.
   *
   * Returns a detach function. Pass it to `Disposable._register({ dispose:
   * detach })` so the subscription is torn down when the owner disposes.
   *
   * This replaces the old `addObserver(IPromptLifecycleObserver)` surface
   * (Phase C retirement) with a general pub-sub API that does not require a
   * separate observer interface.
   */
  subscribe(handler: (event: Event) => void): () => void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventBus = createDecorator<IEventBus>('eventBus');
