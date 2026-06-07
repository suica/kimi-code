/**
 * `HarnessBridge` — implementation of `IHarnessBridge`.
 */

import {
  createRPC,
  Disposable,
  KimiCore,
  resolveConfigPath,
  resolveKimiHome,
  type CoreAPI,
  type CoreRPC,
  type OAuthTokenProviderResolver,
  type SDKAPI,
} from '@moonshot-ai/agent-core';
import {
  createKimiDefaultHeaders,
} from '@moonshot-ai/kimi-code-oauth';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';

import { BridgeClientAPI } from './bridge-client-api';
import { IApprovalBroker } from '../approval/approval-broker';
import { IEventBus } from '../event/event-bus';
import { IQuestionBroker } from '../question/question-broker';
import { IHarnessBridge, type HarnessBridgeOptions, type HarnessRPC } from './harness-bridge';

export class HarnessBridge extends Disposable implements IHarnessBridge {
  readonly _serviceBrand: undefined;

  /**
   * Service-facing RPC handle. This is a `Proxy` over the awaited
   * `RPCMethods<CoreAPI>` so callers don't have to await a promise themselves
   * — `bridge.rpc.createSession({...})` returns a `Promise<SessionSummary>`
   * directly. After dispose, the proxy rejects on every method invocation.
   */
  public readonly rpc: HarnessRPC;

  /**
   * The in-process `KimiCore` instance. Kept private so daemon-side code can't
   * grab it and bypass the broker indirection.
   */
  private readonly _core: KimiCore;

  /**
   * Promise that resolves to the resolved RPC methods. The bridge's `rpc`
   * proxy awaits this on every dispatch (cheap — controlled-promise resolves
   * synchronously on the second call).
   */
  private readonly _coreRpcPromise: Promise<CoreRPC>;

  /**
   * Cached readiness signal. We treat "SDK-side RPC bound" as the readiness
   * marker today; once `KimiCore.pluginsReady` is publicly exposed we can
   * combine them here.
   */
  private readonly _ready: Promise<void>;

  constructor(
    // P2.5: VSCode-style static-first / services-last ctor. `options`
    // moves to the prefix because it's a config bag, not a DI dep.
    // The brokers + event bus are auto-injected by the container; the
    // caller (daemon start.ts) passes `options` (or `{}`). The inline
    // default is dropped because TS forbids a required param after an
    // optional one — call sites already pass an explicit object.
    options: HarnessBridgeOptions,
    @IEventBus eventBus: IEventBus,
    @IApprovalBroker approvalBroker: IApprovalBroker,
    @IQuestionBroker questionBroker: IQuestionBroker,
  ) {
    super();

    // 1. Build the in-process RPC pair. Left/Right are typed; `coreRpc` is the
    //    function KimiCore receives, `sdkRpc` is the one the bridge satisfies.
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();

    // Default-wire the OAuth token resolver. Without this, KimiCore's
    // `ProviderManager.resolveAuth` sees `resolveOAuthTokenProvider ===
    // undefined` and synthesizes a closure that ALWAYS throws
    // `AUTH_LOGIN_REQUIRED` — even after a successful device-code login that
    // persisted a fresh token to disk. The daemon's `/auth` readiness probe
    // is a different code path (file existence on the credentials store) so
    // it stays green; the failure only surfaces inside the prompt turn, as
    // an `auth.login_required` error after `turn.step.started`. We bridge
    // the gap by default-constructing a `KimiAuthFacade` against the same
    // home + config paths KimiCore will use, and handing its
    // `resolveOAuthTokenProvider` into the core. Callers (e.g. node-sdk
    // tests) can still override via `options.resolveOAuthTokenProvider`.
    const resolveOAuthTokenProvider: OAuthTokenProviderResolver =
      options.resolveOAuthTokenProvider ??
      HarnessBridge._defaultOAuthTokenResolver(options);

    // Default-wire the Kimi request headers (User-Agent + X-Msh-* device
    // identity). Without this, KimiCore's outbound fetch carries the
    // default Node fetch User-Agent and the managed Kimi-for-Coding
    // endpoint rejects with 40340 ("only available for Coding Agents
    // such as Kimi CLI, Claude Code, …"). Mirrors what `SDKRpcClient`
    // does for the in-process TUI path (node-sdk's sdk-rpc-client.ts).
    // Caller-supplied `kimiRequestHeaders` always wins; absent that, we
    // synthesize from `options.identity`. Hosts that pass neither
    // (no identity, no headers) still construct — preserves the W3
    // contract — but their requests will trip the 40340 guard.
    const kimiRequestHeaders: Record<string, string> | undefined =
      options.kimiRequestHeaders ??
      HarnessBridge._defaultKimiRequestHeaders(options);

    // `appVersion` flows into Session records (`app_version`) and tool
    // call ctx. Prefer explicit > identity.version so callers can pin
    // a different value if they need to.
    const appVersion: string | undefined =
      options.appVersion ?? options.identity?.version;

    // 2. Construct the core. KimiCore's ctor wires itself into `coreRpc` and
    //    exposes `this.sdk: Promise<SDKRPC>` for the reverse direction.
    this._core = new KimiCore(coreRpc, {
      ...options,
      kimiRequestHeaders,
      appVersion,
      resolveOAuthTokenProvider,
    });

    // 3. Satisfy the SDK side with a BridgeClientAPI that routes to brokers.
    //    sdkRpc returns Promise<RPCMethods<CoreAPI>> — these are the methods
    //    in-package services will dispatch on.
    const clientApi = new BridgeClientAPI({
      eventBus,
      approvalBroker,
      questionBroker,
    });
    this._coreRpcPromise = sdkRpc(clientApi);

    // 4. Readiness is "the RPC pair is bound on both sides". Plugin load
    //    happens inside KimiCore's ctor and self-heals (the worker captures
    //    the error rather than surfacing it; see core-impl.ts:170-172).
    this._ready = this._coreRpcPromise.then(() => undefined);

    // 5. Build the dispatch proxy. Each method on the proxy awaits the resolved
    //    RPC methods then forwards. After dispose, dispatch rejects eagerly.
    this.rpc = this._buildRpcProxy();
  }

  async ready(): Promise<void> {
    return this._ready;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // KimiCore does not currently expose a dispose() — when it does (PLAN
    // Stage 2), we'll await/call it here BEFORE super.dispose(). For now,
    // disposing the bridge flips _disposed, which makes future rpc.*
    // invocations reject before they reach KimiCore.
    super.dispose();
  }

  private _buildRpcProxy(): HarnessRPC {
    const rpcPromise = this._coreRpcPromise;
    const isDisposedRef = () => this._isDisposed;

    // We don't know the concrete method set at compile time here (CoreAPI is
    // a structural interface; `RPCMethods<CoreAPI>` is a mapped type).
    // The Proxy lets us intercept every property access and return a function
    // that awaits the underlying RPC and forwards.
    return new Proxy({} as HarnessRPC, {
      get(_target, prop) {
        // Symbols / well-known properties (Symbol.toPrimitive, then-able
        // probe, etc.) should not be RPC-dispatched.
        if (typeof prop !== 'string') return undefined;
        // Returning a function keeps `typeof rpc.foo === 'function'` true,
        // which downstream code may probe.
        return (...args: unknown[]) => {
          if (isDisposedRef()) {
            return Promise.reject(new Error('HarnessBridge has been disposed'));
          }
          return rpcPromise.then((methods) => {
            const fn = (methods as unknown as Record<string, unknown>)[prop];
            if (typeof fn !== 'function') {
              return Promise.reject(
                new Error(`HarnessBridge.rpc.${prop} is not a function`),
              );
            }
            return (fn as (...args: unknown[]) => unknown)(...args);
          });
        };
      },
    });
  }

  /**
   * Build the default `resolveOAuthTokenProvider` from the same home + config
   * paths KimiCore resolves internally. Mirrors `SDKRpcClient`'s default in
   * `packages/node-sdk/src/sdk-rpc-client.ts` so the daemon and the SDK
   * runtimes share OAuth credentials when both run against the same
   * `~/.kimi-code`.
   *
   * Exposed as `static` so tests can assert the wiring without exercising the
   * full agent-core turn loop.
   */
  static _defaultOAuthTokenResolver(
    options: HarnessBridgeOptions,
  ): OAuthTokenProviderResolver {
    const homeDir = resolveKimiHome(options.homeDir);
    const configPath = resolveConfigPath({
      homeDir: options.homeDir,
      configPath: options.configPath,
    });
    const facade = new KimiAuthFacade({ homeDir, configPath });
    return facade.resolveOAuthTokenProvider;
  }

  /**
   * Build the default `kimiRequestHeaders` from `options.identity` so the
   * outbound `User-Agent` + device-identity headers identify this process
   * as a real Coding Agent host (e.g. `kimi-code-cli/<ver>`). Without
   * these, the managed Kimi-for-Coding endpoint rejects with 40340.
   *
   * Returns `undefined` when no identity is provided — preserves the
   * pre-fix W3 contract for hosts that pass headers explicitly via
   * `options.kimiRequestHeaders` (or for legacy callers / tests that
   * don't talk to the managed endpoint at all).
   *
   * `homeDir` resolution matches KimiCore's so the per-device id (minted
   * + cached at `<homeDir>/device_id` on first call) lives in the same
   * root as everything else KimiCore touches.
   *
   * Exposed as `static` so tests can assert the wiring without booting
   * the bridge.
   */
  static _defaultKimiRequestHeaders(
    options: HarnessBridgeOptions,
  ): Record<string, string> | undefined {
    if (options.identity === undefined) return undefined;
    const homeDir = resolveKimiHome(options.homeDir);
    return createKimiDefaultHeaders({
      homeDir,
      ...options.identity,
    });
  }
}
