/**
 * `HarnessBridge` — the in-process RPC bridge owned by the services package.
 * Internally:
 *
 *   1. `createRPC<CoreAPI, SDKAPI>()` produces a `[coreRpc, sdkRpc]` pair of
 *      `RPCClient` functions (packages/agent-core/src/rpc/client.ts:31-103).
 *   2. `new KimiCore(coreRpc, options)` — the core is constructed with the
 *      core-side RPC client (it calls into the SDK side over `coreRpc`).
 *   3. `sdkRpc(new BridgeClientAPI({ ... }))` — the SDK side of the pair is
 *      satisfied by a `BridgeClientAPI` instance whose `SDKAPI` methods route
 *      to DI-resolved brokers. Returns `Promise<RPCMethods<CoreAPI>>` — the
 *      core RPC methods that future positive services (W4+/Phase 1) will use.
 *
 * The result is wrapped in a small `SDKRpcClient`-shaped facade so that
 * service impls (Chain 1+) get the same ergonomics as `@moonshot-ai/kimi-code-sdk`
 * (`SDKRpcClientBase` subclass). The facade is exposed as `rpc` for in-package
 * consumers; the public package barrel does NOT re-export `SDKRpcClientBase`,
 * so daemon-side code stays one abstraction layer away.
 *
 * Lifecycle:
 *   - `ready()` resolves when both the `KimiCore` plugin/config load AND the
 *     SDK-side RPC binding have settled. Construction is eager (Singleton
 *     pattern); awaiting `ready()` is the safe gate before issuing RPC calls.
 *   - `dispose()` is idempotent. It flips an internal flag so future `rpc`
 *     method dispatch throws before reaching `KimiCore`, then walks the
 *     `Disposable` child stack. `KimiCore` itself has no `dispose()` today —
 *     when it gets one (PLAN Stage 2), we wire it here.
 */

import {
  createDecorator,
  createRPC,
  Disposable,
  KimiCore,
  resolveConfigPath,
  resolveKimiHome,
  type CoreAPI,
  type CoreRPC,
  type KimiCoreOptions,
  type OAuthTokenProviderResolver,
  type SDKAPI,
} from '@moonshot-ai/agent-core';
import {
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';

import { BridgeClientAPI } from './bridge-client-api';
import { IApprovalBroker } from '../approval/approval-broker';
import { IEventBus } from '../event/event-bus';
import { IQuestionBroker } from '../question/question-broker';

export interface HarnessBridgeOptions extends KimiCoreOptions {
  /**
   * Host identity (product name + version). When set and
   * `kimiRequestHeaders` is omitted, the bridge default-wires
   * `createKimiDefaultHeaders({ homeDir, ...identity })` into KimiCore so
   * upstream sees `User-Agent: <product>/<version>` + `X-Msh-Platform: …`.
   * Without this, the managed Kimi-for-Coding endpoint rejects requests
   * with 40340 ("only available for Coding Agents") because the default
   * fetch User-Agent doesn't match any known coding-agent product.
   *
   * `identity.version` also feeds `appVersion` so session records carry
   * the host CLI version — same wiring `SDKRpcClient` does in node-sdk.
   *
   * Callers can still pass explicit `kimiRequestHeaders` (or `appVersion`)
   * to override; the explicit values win.
   */
  readonly identity?: KimiHostIdentity;
}

/**
 * Read-only view onto the core RPC that the bridge exposes to in-package
 * service impls. Members are dispatched eagerly through the RPC; calls before
 * `ready()` resolves queue inside `RPCClient`'s controlled-promise plumbing.
 */
export type HarnessRPC = CoreRPC;

export interface IHarnessBridge {
  readonly _serviceBrand: undefined;

  /** The core RPC methods. Service impls call e.g. `bridge.rpc.createSession(...)`. */
  readonly rpc: HarnessRPC;

  /**
   * Resolves once `KimiCore` is fully constructed and the SDK side of the
   * in-process RPC has been bound. Repeated calls return the cached promise.
   */
  ready(): Promise<void>;

  /**
   * Tear down the bridge. After dispose, `rpc.<method>(...)` rejects with a
   * "bridge disposed" error before reaching `KimiCore`. Idempotent.
   */
  dispose(): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IHarnessBridge = createDecorator<IHarnessBridge>('harnessBridge');


