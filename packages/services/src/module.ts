/**
 * `defaultServicesModule()` — DI entries shipped by `@moonshot-ai/services`.
 * W3 ships ONLY the `HarnessBridge` registration; positive `IXxxService`
 * entries (ISessionService etc.) get appended per-Chain in Phase 1.
 *
 * Callers spread the array into a `ServiceCollection` ctor:
 *
 *   const entries = defaultServicesModule();
 *   const collection = new ServiceCollection(
 *     ...entries.map(([id, descriptor]) => [id, descriptor] as const),
 *     // ...broker impls...
 *   );
 *
 * Each entry is `[ServiceIdentifier, SyncDescriptor, InstantiationType]` —
 * the `InstantiationType` is informational today (W2 treats Delayed as Eager;
 * see instantiationService.ts:158 TODO). When delayed-instantiation lands the
 * wiring layer can route entries accordingly without touching this module.
 *
 * Canonical wiring strategy: `defaultServicesModule()` returned to the
 * daemon's bootstrap, which builds the `ServiceCollection` once. We do NOT
 * use the global `registerSingleton` registry as the canonical path — the
 * registry exists for legacy "side-effect on import" wiring and is exposed
 * only via `./bridge/lifecycle.ts`'s `registerHarnessBridge` helper (NOT
 * re-exported from the package barrel; W3 STATUS.md documents this).
 *
 * Per-domain layout (Phase B):
 *   Classes are now in per-domain folders (session/, message/, etc.) with
 *   the `-Impl` suffix dropped. The descriptor entries below reference the
 *   new class names directly.
 */

import {
  InstantiationType,
  SyncDescriptor,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core';

import { HarnessBridge } from './bridge/harnessBridge';
import { IHarnessBridge } from './bridge/harness-bridge';
import { McpService } from './mcp/mcpService';
import { IMcpService } from './mcp/mcp';
import { MessageService } from './message/messageService';
import { IMessageService } from './message/message';
import { PromptService } from './prompt/promptService';
import { IPromptService } from './prompt/prompt';
import { SessionService } from './session/sessionService';
import { ISessionService } from './session/session';
import { TaskService } from './task/taskService';
import { ITaskService } from './task/task';
import { ToolService } from './tool/toolService';
import { IToolService } from './tool/tool';

export type ServiceModuleEntry = readonly [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServiceIdentifier<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SyncDescriptor<any>,
  InstantiationType,
];

export function defaultServicesModule(): ReadonlyArray<ServiceModuleEntry> {
  return [
    [IHarnessBridge, new SyncDescriptor(HarnessBridge), InstantiationType.Eager],
    // W6.2 / Chain 2 — `ISessionService`. The descriptor lacks staticArguments
    // (SessionService ctor needs IHarnessBridge). W2 has no ctor-arg DI,
    // so this descriptor is informational; the daemon's `start.ts` wires the
    // instance via `ix.createInstance(SessionService, a.get(IHarnessBridge))`
    // then `services.set(ISessionService, instance)`. The descriptor entry
    // documents that ISessionService is part of the canonical service set.
    [ISessionService, new SyncDescriptor(SessionService), InstantiationType.Eager],
    // W7.1 / Chain 3 — `IMessageService`. Same wiring story as `ISessionService`:
    // `MessageService` ctor takes `IHarnessBridge`; W2 has no ctor-arg DI so
    // the daemon's `start.ts` calls `ix.createInstance(MessageService, a.get(IHarnessBridge))`
    // and `services.set(IMessageService, instance)`. The descriptor entry is the
    // canonical declaration of the service set.
    [IMessageService, new SyncDescriptor(MessageService), InstantiationType.Eager],
    // W7.2 / Chain 4 — `IPromptService`. Ctor takes `IHarnessBridge` + `IEventBus`
    // (it self-registers as a lifecycle observer on the bus so it can synthesize
    // `prompt.completed` / `prompt.aborted` from `turn.ended`). Same descriptor
    // shape as the others — daemon does manual wiring in start.ts.
    [IPromptService, new SyncDescriptor(PromptService), InstantiationType.Eager],
    // W9.1 / Chain 7 — `IToolService` + `IMcpService`. Both depend only on
    // `IHarnessBridge`; daemon's `start.ts` wires them after `IPromptService`
    // so reverse-dispose closes them before the bridge.
    [IToolService, new SyncDescriptor(ToolService), InstantiationType.Eager],
    [IMcpService, new SyncDescriptor(McpService), InstantiationType.Eager],
    // W9.2 / Chain 8 — `ITaskService`. Same ctor-arg-via-`createInstance`
    // wiring as IToolService/IMcpService; appended last so reverse-dispose
    // closes it first among the new services.
    [ITaskService, new SyncDescriptor(TaskService), InstantiationType.Eager],
  ] as const;
}
