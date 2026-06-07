/**
 * `ToolService` — implementation of `IToolService`.
 */

import { Disposable } from '@moonshot-ai/agent-core';

import { IHarnessBridge } from '../bridge/harness-bridge';
import { IToolService, toProtocolTool, type AgentCoreToolInfoLike } from './tool';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;

  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    const resolvedSid = sessionId ?? (await this._anyKnownSessionId());
    if (resolvedSid === undefined) return [];
    let raw: readonly unknown[];
    try {
      raw = await this.bridge.rpc.getTools({
        sessionId: resolvedSid,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session not loaded into the active session map; return empty rather
      // than surface a 500 — the global-list semantics is "best effort".
      return [];
    }
    return raw.map((t) => toProtocolTool(t as AgentCoreToolInfoLike));
  }

  /**
   * Find a usable session id when caller hasn't supplied one. Returns the
   * most recently created session id, or `undefined` when no sessions exist.
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.bridge.rpc.listSessions({});
    if (all.length === 0) return undefined;
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}
