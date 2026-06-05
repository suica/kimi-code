/**
 * `IAuthSummaryService` — daemon-facing readiness probe (P2.1 D2).
 *
 * Single権威 readiness signal source:
 *   - `get()` produces the `AuthSummary` payload for `GET /v1/auth`.
 *   - `ensureReady(modelOverride?)` is the synchronous gate invoked by entry
 *     points that can't proceed without provider credentials — currently
 *     `PromptService.submit`. It throws one of the four sentinel error
 *     classes below; daemon route layers map them to envelope codes
 *     `40110 / 40111 / 40112 / 40113`.
 *
 * Why centralized: the same "is there a usable provider + model + token?"
 * computation is needed by both the read probe and every write-side entry that
 * could surface 50001 "internal" today (PLAN背景 §1). Co-locating it keeps the
 * logic in one place + makes it cheap to add new gated entries (PATCH session
 * model, etc.).
 *
 * Status mapping note (P2.1 scope): we only return `'authenticated'` (token
 * cached) or `'unauthenticated'` (no token). The `'expired' / 'revoked'`
 * states require runtime OAuth introspection that lands in P2.7 + P2.9 —
 * P2.1's gate intentionally does NOT try to differentiate them.
 *
 * **Implementation** (`AuthSummaryService`): Reads the live config via
 * `IHarnessBridge.rpc.getKimiConfig({})` and the managed-OAuth credential
 * state via `KimiAuthFacade.status(...)`. Both are cheap (in-process RPC +
 * a token-file existence probe), so we run them on every call instead of
 * caching — keeps the staleness window at zero.
 */

import { createDecorator, Disposable } from '@moonshot-ai/agent-core';
import type { KimiConfig } from '@moonshot-ai/agent-core';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';
import type { AuthSummary } from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;

  /**
   * Compute the current readiness snapshot. Cheap (one config read + one
   * cached-token lookup); safe to call on every `GET /v1/auth`.
   */
  get(): Promise<AuthSummary>;

  /**
   * Throw a sentinel auth error if the daemon can NOT currently serve a
   * prompt with `modelOverride` (or `config.defaultModel` if omitted).
   * Returns void on success.
   */
  ensureReady(modelOverride?: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAuthSummaryService = createDecorator<IAuthSummaryService>(
  'authSummaryService',
);

/**
 * `40110 auth.provisioning_required` — daemon has zero provider configs.
 */
export class AuthProvisioningRequiredError extends Error {
  constructor() {
    super('no provider configured; complete onboarding via /login or POST /v1/providers');
    this.name = 'AuthProvisioningRequiredError';
  }
}

/**
 * `40111 auth.token_missing` — provider exists in config but its credential
 * (api_key or cached OAuth token) is missing.
 */
export class AuthTokenMissingError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`provider ${providerId} has no credential configured`);
    this.name = 'AuthTokenMissingError';
    this.providerId = providerId;
  }
}

/**
 * `40112 auth.token_unauthorized` — OAuth refresh returned 401; user has
 * revoked the grant. Not produced by P2.1's static gate (would require a
 * round-trip to the OAuth host); reserved for the reactive-refresh path in
 * P2.9.
 */
export class AuthTokenUnauthorizedError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`provider ${providerId} oauth grant revoked; re-login required`);
    this.name = 'AuthTokenUnauthorizedError';
    this.providerId = providerId;
  }
}

/**
 * `40113 auth.model_not_resolved` — the (default or requested) model alias
 * does not resolve to a configured provider. Two sub-cases:
 *   - no default model set at all (`modelId === undefined`)
 *   - alias missing or points at a non-existent provider
 */
export class AuthModelNotResolvedError extends Error {
  readonly modelId: string | undefined;
  readonly providerId: string | undefined;
  constructor(modelId: string | undefined, providerId?: string) {
    super(
      modelId === undefined
        ? 'no default model configured'
        : `model ${modelId} does not resolve to a configured provider`,
    );
    this.name = 'AuthModelNotResolvedError';
    this.modelId = modelId;
    this.providerId = providerId;
  }
}

/** Wire name of the OAuth-managed provider (`@moonshot-ai/kimi-code-oauth`'s `KIMI_CODE_PROVIDER_NAME`). */
const MANAGED_PROVIDER_NAME = 'managed:kimi-code';

export interface AuthSummaryServiceOptions {
  /** `~/.kimi-code` (or test tmpdir) — the credential file root for KimiAuthFacade. */
  readonly homeDir: string;
  /** Full path to `config.toml`. Must match what HarnessBridge / KimiCore see. */
  readonly configPath: string;
}

export class AuthSummaryService
  extends Disposable
  implements IAuthSummaryService
{
  readonly _serviceBrand: undefined;

  private readonly _authFacade: KimiAuthFacade;

  constructor(
    // VSCode-style: static options prefix, @-injected services after.
    options: AuthSummaryServiceOptions,
    @IHarnessBridge private readonly bridge: IHarnessBridge,
  ) {
    super();
    this._authFacade = new KimiAuthFacade({
      homeDir: options.homeDir,
      configPath: options.configPath,
    });
  }

  async get(): Promise<AuthSummary> {
    const config = await this._readConfig();
    const providers = config.providers ?? {};
    const providers_count = Object.keys(providers).length;
    const default_model = nonEmpty(config.defaultModel);

    let managed_provider: AuthSummary['managed_provider'] = null;
    if (providers[MANAGED_PROVIDER_NAME] !== undefined) {
      const hasToken = await this._hasCachedToken(MANAGED_PROVIDER_NAME);
      managed_provider = {
        name: MANAGED_PROVIDER_NAME,
        status: hasToken ? 'authenticated' : 'unauthenticated',
      };
    }

    const ready =
      providers_count >= 1 &&
      default_model !== null &&
      (managed_provider === null || managed_provider.status !== 'revoked');

    return { ready, providers_count, default_model, managed_provider };
  }

  async ensureReady(modelOverride?: string): Promise<void> {
    const config = await this._readConfig();
    const providers = config.providers ?? {};
    if (Object.keys(providers).length === 0) {
      throw new AuthProvisioningRequiredError();
    }

    const modelId = modelOverride ?? config.defaultModel;
    if (modelId === undefined || modelId === '') {
      throw new AuthModelNotResolvedError(undefined);
    }

    const alias = config.models?.[modelId];
    if (alias === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const providerName = alias.provider ?? config.defaultProvider;
    if (providerName === undefined || providerName === '') {
      throw new AuthModelNotResolvedError(modelId);
    }

    const providerConfig = providers[providerName];
    if (providerConfig === undefined) {
      throw new AuthModelNotResolvedError(modelId, providerName);
    }

    // Credential presence: api_key (config or env), OR a cached OAuth token.
    // We deliberately don't probe live OAuth refresh here — that path is
    // reactive (P2.9). Static gate only.
    const hasInlineKey = nonEmpty(providerConfig.apiKey) !== null;
    if (hasInlineKey) return;

    if (providerConfig.oauth !== undefined) {
      const hasToken = await this._hasCachedToken(providerName);
      if (hasToken) return;
      throw new AuthTokenMissingError(providerName);
    }

    // No inline key, no oauth ref. Could still be an env-supplied key — for
    // P2.1 minimum viable we conservatively gate; env-key callers can set
    // apiKey="${VAR}" in config to bypass. The acceptance test fixture for
    // 40111 uses "manual provider with no api_key" which lands here.
    throw new AuthTokenMissingError(providerName);
  }

  override dispose(): void {
    if (this._isDisposed) return;
    super.dispose();
  }

  /* ----------------------------- internals ---------------------------- */

  private async _readConfig(): Promise<KimiConfig> {
    // `reload: true` forces KimiCore to re-read `config.toml` from disk
    // before returning. Critical for the auth probe path: writes from
    // `OAuthService` (toolkit's provisioning) and `IProviderService`
    // future RW endpoints land on disk via `writeConfigFile`, but
    // KimiCore's `this.config` only refreshes when something explicitly
    // asks for `reload`. Without this flag, `GET /v1/auth` would stay
    // `ready:false` for the entire daemon lifetime after first login.
    return this.bridge.rpc.getKimiConfig({ reload: true });
  }

  private async _hasCachedToken(providerName: string): Promise<boolean> {
    try {
      const token = await this._authFacade.getCachedAccessToken(providerName);
      return typeof token === 'string' && token.trim().length > 0;
    } catch {
      // FileTokenStorage throws if the credential dir or file is unreadable;
      // treat any failure as "no token" so callers don't block on transient
      // filesystem errors.
      return false;
    }
  }
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
