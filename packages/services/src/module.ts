/**
 * `defaultServicesModule()` — DI entries shipped by `@moonshot-ai/services`.
 *
 * This is now a thin projection of the global singleton registry:
 * service impl files (`./<domain>/<domain>Service.ts`) self-register at
 * module-load time via `registerSingleton(IXxx, new SyncDescriptor(...))`
 * (plan §535). Importing this `module.ts` triggers the side-effect imports
 * below, which populate the registry; `defaultServicesModule()` then snapshots
 * the registry via `getSingletonServiceDescriptors()`.
 *
 * Callers spread the array into a `ServiceCollection` ctor:
 *
 *   const entries = defaultServicesModule();
 *   const collection = new ServiceCollection(
 *     ...entries.map(([id, descriptor]) => [id, descriptor] as const),
 *     // ...peer-service impls (IEventService / IApprovalService /
 *     //    IQuestionService — those live in @moonshot-ai/daemon)
 *   );
 *
 * Each entry is `[ServiceIdentifier, SyncDescriptor, InstantiationType]` —
 * the `InstantiationType` is derived from each descriptor's
 * `supportsDelayedInstantiation` flag (Delayed when `true`, Eager otherwise).
 * Phase 3 registers everything with `supportsDelayedInstantiation = false`
 * (plan §540) so every entry projects to `Eager`.
 *
 * Canonical wiring strategy (post-Phase 3): daemon-side `start.ts` consumes
 * `defaultServicesModule()` for the descriptor-only services and overrides
 * specific entries via `services.set(...)` for services that need runtime
 * static args (e.g. `CoreProcessService` with the real `coreProcessOptions`
 * bag) or for prebuilt instances that carry external handles
 * (`PinoLogger` / `FastifyRestGateway`). Because the duplicate-registration
 * throw was intentionally removed from `registerSingleton` (plan §158), the
 * later registration wins at every layer.
 *
 * Per-domain layout: see `packages/services/AGENTS.md`. Classes live in
 * per-domain folders (`session/`, `message/`, …) with one `<domain>.ts`
 * contracts file and one `<domain>Service.ts` impl file each.
 */

import {
  getSingletonServiceDescriptors,
  InstantiationType,
  SyncDescriptor,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core';

// Side-effect imports — each impl file calls `registerSingleton(...)` at
// file bottom (plan §535). Ordering matters: it determines the order
// entries surface from `getSingletonServiceDescriptors()`, which the
// daemon's reverse-dispose semantics piggy-back on. CoreProcessService
// MUST register first — the existing `defaultServicesModule()` test
// (`packages/services/test/coreProcessService.test.ts:315`) asserts it
// sits at index 0, and downstream `a.get(...)` "touch" ordering in
// `packages/daemon/src/start.ts` assumes the bridge is the first
// service-package entry into the construction-order list.
import './coreProcess/coreProcessService';
import './session/sessionService';
import './message/messageService';
import './prompt/promptService';
import './tool/toolService';
import './mcp/mcpService';
import './task/taskService';
import './authSummary/authSummaryService';
import './oauth/oauthService';

export type ServiceModuleEntry = readonly [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServiceIdentifier<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SyncDescriptor<any>,
  InstantiationType,
];

export function defaultServicesModule(): ReadonlyArray<ServiceModuleEntry> {
  return getSingletonServiceDescriptors().map(
    ([id, descriptor]) =>
      [
        id,
        descriptor,
        descriptor.supportsDelayedInstantiation
          ? InstantiationType.Delayed
          : InstantiationType.Eager,
      ] as const,
  );
}
