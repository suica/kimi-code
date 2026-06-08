/**
 * `request_id` helper (REST.md §1.5).
 *
 * Clients may supply `X-Request-Id`; the server echoes it back in the
 * envelope `request_id` field. If the header is missing OR is not a valid
 * ULID, the server mints a fresh ULID.
 *
 * This protocol helper returns the bare ULID (no prefix); callers that need a
 * namespace can add their own prefix.
 */
import { isValid, ulid } from 'ulid';

/**
 * Canonical Crockford base32 ULID format: 26 chars, [0-9A-HJKMNP-TV-Z],
 * leading char limited to `[0-7]` (48-bit timestamp upper bound).
 *
 * Exported so callers (REST handlers, tests) can validate without taking a
 * runtime dependency on `ulid`'s `isValid`.
 */
export const ulidRegex = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Resolve the request_id for an incoming REST request.
 *
 * - `undefined` input            → mint a new ULID.
 * - Valid ULID input             → return verbatim.
 * - Anything else (malformed)    → mint a new ULID (do not echo malformed
 *                                   client input back into our logs).
 *
 * The returned value is a 26-char ULID string. Callers that want a `req_`
 * prefix should add it themselves.
 */
export function parseOrGenerateRequestId(headerValue: string | undefined): string {
  if (typeof headerValue === 'string' && isValid(headerValue)) {
    return headerValue;
  }
  return ulid();
}

/**
 * Lightweight predicate companion. Useful in WS / event code paths that need
 * to validate `request_id` without throwing.
 */
export function isUlid(value: string): boolean {
  return isValid(value);
}
