/**
 * ISO 8601 time normalization (SCHEMAS.md §1.4).
 *
 * Wire format: `"2026-06-04T10:30:00.123Z"` — always milliseconds + `Z`.
 *
 * Inputs are accepted leniently (`+08:00`, `Z`, or no offset → treated as UTC)
 * and re-emitted in canonical UTC form. The server is the normalization
 * point; clients should not have to do timezone math.
 */
import { z } from 'zod';

/**
 * Strict-ish ISO 8601 datetime regex. Accepts:
 *   - `YYYY-MM-DDTHH:MM:SS` + offset (`Z`, `+HH:MM`, `+HHMM`, `-HH:MM`,
 *     `-HHMM`, `+HH`, or `-HH`)
 *   - Optional fractional seconds before the offset (1..9 digits).
 *
 * The offset is REQUIRED. Inputs without a `Z` or numeric offset are
 * rejected — leaving timezone implicit would make the input ambiguous
 * (ECMAScript parses such strings as local time, which is a footgun).
 */
const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Lenient ISO 8601 input → canonical UTC string with milliseconds + `Z`.
 *
 * Examples:
 *   - `IsoDateTime.parse('2026-06-04T18:30:00+08:00')` → `'2026-06-04T10:30:00.000Z'`
 *   - `IsoDateTime.parse('2026-06-04T10:30:00Z')`     → `'2026-06-04T10:30:00.000Z'`
 *   - `IsoDateTime.parse('2026-06-04T10:30:00.500Z')` → `'2026-06-04T10:30:00.500Z'`
 *   - `IsoDateTime.parse('not-a-date')`              → throws ZodError
 */
export const isoDateTimeSchema = z
  .string()
  .refine((value) => ISO_8601_REGEX.test(value), {
    message: 'must be an ISO 8601 datetime string',
  })
  .transform((value, ctx) => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      ctx.addIssue({
        code: 'custom',
        message: 'invalid ISO 8601 datetime',
      });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

/** Alias matching the canonical SCHEMAS naming. */
export const IsoDateTime = isoDateTimeSchema;

/** Branded TS string type for canonical UTC ISO 8601 with millisecond precision. */
export type IsoDateTime = string;

/**
 * Convenience: produce `now` in the canonical wire format. Useful for daemon
 * code that needs to stamp `created_at` / `expires_at` without going through
 * a Zod parse cycle.
 */
export function nowIsoDateTime(): IsoDateTime {
  return new Date().toISOString();
}
