/**
 * `TaskService` — implementation of `ITaskService`.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { BackgroundTaskInfo } from '@moonshot-ai/agent-core';
import type { BackgroundTask } from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import { SessionNotFoundError } from '../session/session';
import {
  ITaskService,
  TaskNotFoundError,
  TaskAlreadyFinishedError,
  toProtocolTask,
  isTerminalStatus,
  type TaskListQuery,
} from './task';

const MAIN_AGENT_ID = 'main';

export class TaskService extends Disposable implements ITaskService {
  readonly _serviceBrand: undefined;

  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const all = raw.map((info) => toProtocolTask(sessionId, info));
    if (query.status !== undefined) {
      return all.filter((t) => t.status === query.status);
    }
    return all;
  }

  async get(sessionId: string, taskId: string): Promise<BackgroundTask> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }
    return toProtocolTask(sessionId, found);
  }

  async cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    await this._requireSession(sessionId);
    // Pre-fetch so we can distinguish the 40406 (not found) and 40904 (already
    // finished) cases deterministically — agent-core's `stopBackground` is a
    // fire-and-forget call that doesn't surface this.
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }
    const wireStatus = toProtocolTask(sessionId, found).status;
    if (isTerminalStatus(wireStatus)) {
      throw new TaskAlreadyFinishedError(sessionId, taskId, wireStatus);
    }
    await this.bridge.rpc.stopBackground({
      sessionId,
      agentId: MAIN_AGENT_ID,
      taskId,
    });
    return { cancelled: true };
  }

  // --- internals ------------------------------------------------------------

  private async _requireSession(sessionId: string): Promise<void> {
    const all = await this.bridge.rpc.listSessions({});
    if (!all.some((s) => s.id === sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  private async _getAllRaw(
    sessionId: string,
  ): Promise<ReadonlyArray<Awaited<ReturnType<typeof this.bridge.rpc.getBackground>>[number]>> {
    try {
      return await this.bridge.rpc.getBackground({
        sessionId,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session not loaded; treat as empty.
      return [];
    }
  }
}
