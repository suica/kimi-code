/**
 * `PromptService` — implementation of `IPromptService`.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type {
  Event,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IAuthSummaryService } from '../authSummary/authSummary';
import { IEventService } from '../event/event';
import { SessionNotFoundError } from '../session/session';
import {
  IPromptService,
  SessionBusyError,
  PromptNotFoundError,
  PromptAlreadyCompletedError,
  type PromptAbortResult,
  type SyntheticPromptCompletedEvent,
  type SyntheticPromptAbortedEvent,
} from './prompt';

const MAIN_AGENT_ID = 'main';

/**
 * Per-session "active prompt" state. Cleared on completion/abort.
 *
 * `turnId === null` when the prompt has been submitted but the first
 * `turn.started` hasn't arrived yet (the RPC pair queues calls before
 * `ready()` so the gap is small but non-zero in practice).
 *
 * `terminal === true` is set when `turn.ended` arrives — we keep the record
 * around so abort-on-already-completed surfaces as 40903, not 40402.
 */
interface PromptState {
  promptId: string;
  turnId: number | null;
  /** Set on `turn.ended` for the top-level turn (reason='completed'|'failed'). */
  completed: boolean;
  /** Set on `turn.ended` with reason='cancelled' or after a successful abort RPC. */
  aborted: boolean;
}

/**
 * Type guard for `turn.started` agent-core events.
 */
function isTurnStarted(e: Event): e is Event & { type: 'turn.started'; turnId: number } {
  return (e as { type?: string }).type === 'turn.started';
}

/**
 * Type guard for `turn.ended` agent-core events.
 */
function isTurnEnded(e: Event): e is Event & {
  type: 'turn.ended';
  turnId: number;
  reason: 'completed' | 'cancelled' | 'failed';
} {
  return (e as { type?: string }).type === 'turn.ended';
}

export class PromptService
  extends Disposable
  implements IPromptService
{
  readonly _serviceBrand: undefined;

  /** Active prompt per session. Cleared on completion / abort emission. */
  private readonly _active = new Map<string, PromptState>();

  /** Typed handlers for `prompt.completed` synthetic events. */
  private readonly _completedHandlers = new Set<(e: SyntheticPromptCompletedEvent) => void>();
  /** Typed handlers for `prompt.aborted` synthetic events. */
  private readonly _abortedHandlers = new Set<(e: SyntheticPromptAbortedEvent) => void>();

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IAuthSummaryService private readonly auth: IAuthSummaryService,
  ) {
    super();
    // Phase C: self-subscribe to the event stream for lifecycle synthesis.
    // The detach handle travels through Disposable so it tears down when
    // PromptService disposes (which happens BEFORE the event service disposes
    // per start.ts wiring order). Re-entrance is safe: synthesised `prompt.*`
    // events don't match the `turn.*` predicates below.
    const detach = this.eventService.subscribe(this._handleBusEvent.bind(this));
    this._register({ dispose: detach });
  }

  // --- IPromptService --------------------------------------------------------

  async submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    await this._requireSession(sid);

    // P2.1 D1 — readiness gate. Throws AuthProvisioningRequired /
    // AuthTokenMissing / AuthModelNotResolved before we mint a prompt_id and
    // hand off to agent-core. Daemon route layer maps to 40110/40111/40113.
    await this.auth.ensureReady();

    const existing = this._active.get(sid);
    if (existing !== undefined && !existing.completed && !existing.aborted) {
      throw new SessionBusyError(sid, existing.promptId);
    }

    const promptId = `prompt_${ulid()}`;
    const userMessageId = `msg_${sid}_pending_${promptId}`;

    this._active.set(sid, {
      promptId,
      turnId: null,
      completed: false,
      aborted: false,
    });

    // Translate protocol MessageContent → agent-core ContentPart. Only text /
    // image content survive the kosong-shape boundary; tool_use / tool_result
    // / thinking originate from the model, not from client submission.
    const input = body.content
      .map((part) => {
        switch (part.type) {
          case 'text':
            return { type: 'text' as const, text: part.text };
          case 'image':
            if (part.source.kind === 'url') {
              return {
                type: 'image_url' as const,
                imageUrl: { url: part.source.url },
              };
            }
            return undefined;
          // Other content kinds (file / tool_use / tool_result / thinking) are
          // not accepted from client submissions in this stage.
          default:
            return undefined;
        }
      })
      .filter((part): part is NonNullable<typeof part> => part !== undefined);

    // Fire-and-forget. agent-core streams events via the SDK side of the
    // RPC pair which lands on `BridgeClientAPI.emitEvent → IEventService.publish`.
    // The submit RPC returns synchronously (PromptPayload → void); errors
    // would manifest as later `error` events, not as a rejection here.
    try {
      // eslint-disable-next-line no-console
      console.error(
        `[DBG prompt-service.submit] sid=${sid} promptId=${promptId} agent=${MAIN_AGENT_ID} parts=${input.length} -> core.rpc.prompt(...)`,
      );
      await this.core.rpc.prompt({
        sessionId: sid,
        agentId: MAIN_AGENT_ID,
        input,
      });
      // eslint-disable-next-line no-console
      console.error(
        `[DBG prompt-service.submit] sid=${sid} promptId=${promptId} core.rpc.prompt(...) resolved`,
      );
    } catch (err) {
      // Clear our active-prompt state so the next submit succeeds; surface
      // the error to the route layer.
      this._active.delete(sid);
      // eslint-disable-next-line no-console
      console.error(
        `[DBG prompt-service.submit] sid=${sid} promptId=${promptId} core.rpc.prompt(...) threw: ${(err as Error)?.message ?? err}`,
      );
      throw err;
    }

    return { prompt_id: promptId, user_message_id: userMessageId };
  }

  async abort(sid: string, pid: string): Promise<PromptAbortResult> {
    await this._requireSession(sid);
    const state = this._active.get(sid);
    if (state === undefined || state.promptId !== pid) {
      throw new PromptNotFoundError(sid, pid);
    }
    if (state.completed || state.aborted) {
      throw new PromptAlreadyCompletedError(sid, pid);
    }
    // Mark aborted optimistically — _handleBusEvent will not re-synthesize.
    state.aborted = true;
    try {
      const cancelArgs: { sessionId: string; agentId: string; turnId?: number } = {
        sessionId: sid,
        agentId: MAIN_AGENT_ID,
      };
      if (state.turnId !== null) cancelArgs.turnId = state.turnId;
      await this.core.rpc.cancel(cancelArgs);
    } catch (err) {
      // Roll back the optimistic flag so the route surfaces a real error;
      // the caller will see a 50001 (internal) via the global error handler.
      state.aborted = false;
      throw err;
    }
    // Synthesize the prompt.aborted event immediately. agent-core may also
    // emit a turn.ended(cancelled) later; _handleBusEvent suppresses a second
    // synthesis since `state.aborted === true`.
    const ev: SyntheticPromptAbortedEvent = {
      type: 'prompt.aborted',
      agentId: MAIN_AGENT_ID,
      sessionId: sid,
      promptId: pid,
      abortedAt: new Date().toISOString(),
    };
    // Fire typed handlers BEFORE publishing the event.
    for (const h of this._abortedHandlers) h(ev);
    this.eventService.publish(ev as unknown as Event);
    return { aborted: true };
  }

  // --- IPromptService typed event listeners ----------------------------------

  onPromptCompleted(handler: (e: SyntheticPromptCompletedEvent) => void): () => void {
    this._completedHandlers.add(handler);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this._completedHandlers.delete(handler);
    };
  }

  onPromptAborted(handler: (e: SyntheticPromptAbortedEvent) => void): () => void {
    this._abortedHandlers.add(handler);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this._abortedHandlers.delete(handler);
    };
  }

  // --- Phase C: private event handler (replaces IPromptLifecycleObserver) --

  private _handleBusEvent(event: Event): void {
    const sid = (event as { sessionId?: string }).sessionId;
    if (sid === undefined || sid === '') return;
    const state = this._active.get(sid);
    if (state === undefined) return;

    if (isTurnStarted(event)) {
      // Capture the FIRST turn.started after submit as the "top-level" turn.
      // Subsequent nested turns (e.g. subagent) carry different turnId values
      // and are NOT promoted to the prompt's top-level.
      if (state.turnId === null) {
        state.turnId = event.turnId;
      }
      return;
    }

    if (isTurnEnded(event)) {
      // Only fire on the top-level turn end. Nested turn.ended events fly
      // through without prompt-level synthesis.
      if (state.turnId === null || event.turnId !== state.turnId) return;

      // If we already synthesized via abort RPC, don't double-emit. Mark
      // completed to prevent stale lookups, but emit nothing.
      if (state.aborted) {
        this._active.delete(sid);
        return;
      }

      const reason = event.reason;
      if (reason === 'cancelled') {
        // The model produced a cancellation that we didn't initiate via
        // abort RPC (or it slipped past the optimistic flag). Synthesize
        // prompt.aborted.
        state.aborted = true;
        const synth: SyntheticPromptAbortedEvent = {
          type: 'prompt.aborted',
          agentId: MAIN_AGENT_ID,
          sessionId: sid,
          promptId: state.promptId,
          abortedAt: new Date().toISOString(),
        };
        this._active.delete(sid);
        // Fire typed handlers BEFORE publishing the event.
        for (const h of this._abortedHandlers) h(synth);
        this.eventService.publish(synth as unknown as Event);
        return;
      }

      state.completed = true;
      const synth: SyntheticPromptCompletedEvent = {
        type: 'prompt.completed',
        agentId: MAIN_AGENT_ID,
        sessionId: sid,
        promptId: state.promptId,
        finishedAt: new Date().toISOString(),
        reason: reason === 'failed' ? 'failed' : 'completed',
      };
      this._active.delete(sid);
      // Fire typed handlers BEFORE publishing the event.
      for (const h of this._completedHandlers) h(synth);
      this.eventService.publish(synth as unknown as Event);
    }
  }

  /**
   * Test helper — peek at active prompt state.
   */
  _activeForTest(sid: string): Readonly<PromptState> | undefined {
    const state = this._active.get(sid);
    return state === undefined ? undefined : { ...state };
  }

  /**
   * Test helper — inject an active prompt record. Used by daemon e2e tests
   * that need to exercise the lifecycle-synthesis path WITHOUT driving a
   * real `core.rpc.prompt(...)` call (which would require an in-memory
   * KimiCore loaded with provider credentials). Not part of the public
   * contract; the underscore prefix is a "do not use in prod" signal.
   */
  _injectActiveForTest(sid: string, promptId: string, turnId: number | null): void {
    this._active.set(sid, {
      promptId,
      turnId,
      completed: false,
      aborted: false,
    });
  }

  // --- internals -----------------------------------------------------------

  private async _requireSession(sid: string): Promise<void> {
    const all = await this.core.rpc.listSessions({});
    if (!all.some((s) => s.id === sid)) {
      throw new SessionNotFoundError(sid);
    }
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._active.clear();
    this._completedHandlers.clear();
    this._abortedHandlers.clear();
    super.dispose();
  }
}
