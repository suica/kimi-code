/**
 * `GET /v1/auth` — readiness probe (REST.md §3).
 *
 * Single权威 readiness signal:web 端首屏靠 `ready` 决定渲染 onboarding 还是 chat
 * 主面板。No token required — this is the入口 that tells the client whether
 * login is needed at all.
 *
 * Wire shape:
 *
 * ```ts
 * {
 *   ready: boolean;
 *   providers_count: number;
 *   default_model: string | null;
 *   managed_provider: {
 *     name: string;
 *     status: 'authenticated' | 'expired' | 'revoked' | 'unauthenticated';
 *   } | null;
 * }
 * ```
 *
 * `ready` ≡ `providers_count >= 1 && default_model != null &&
 * managed_provider?.status !== 'revoked'`. Clients trust this boolean and do
 * NOT recompute from the parts.
 *
 * State flips broadcast via WS `auth.ready_changed`.
 */
import { z } from 'zod';

export const managedProviderStatusSchema = z.enum([
  'authenticated',
  'expired',
  'revoked',
  'unauthenticated',
]);
export type ManagedProviderStatus = z.infer<typeof managedProviderStatusSchema>;

export const managedProviderSummarySchema = z.object({
  name: z.string().min(1),
  status: managedProviderStatusSchema,
});
export type ManagedProviderSummary = z.infer<typeof managedProviderSummarySchema>;

export const authSummarySchema = z.object({
  ready: z.boolean(),
  providers_count: z.number().int().nonnegative(),
  default_model: z.string().nullable(),
  managed_provider: managedProviderSummarySchema.nullable(),
});
export type AuthSummary = z.infer<typeof authSummarySchema>;
