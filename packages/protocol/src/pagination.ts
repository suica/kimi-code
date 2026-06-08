/**
 * Cursor pagination primitives (SCHEMAS.md §1.3, REST.md §1.6).
 *
 * Only time-series resources (messages, sessions) use this. Wire format:
 *   ?before_id=<id>&after_id=<id>&page_size=<1..100>
 *
 * - `before_id` and `after_id` are mutually exclusive — sending both is
 *   `40001 validation.failed`.
 * - `page_size` upper bound is **100** per SCHEMAS.md §1.3 / REST.md §1.6.
 *   Per-endpoint defaults differ (messages=50, sessions=20) and are
 *   applied at the endpoint layer, not here.
 * - Response shape is `{ items, has_more }` — no `next_cursor`, no `total`,
 *   no `order`. Cursor anchors are the id of the first/last item; clients
 *   keep them.
 */
import { z } from 'zod';

import { ErrorCode } from './error-codes';

/**
 * Query schema for cursor pagination on time-series collections.
 *
 * Validation rules:
 *   - `page_size` is an integer in `[1, 100]` (REST.md §1.6 "最大 100")
 *   - `before_id` ⊥ `after_id`; sending both attaches `params.code = 40001`
 *     to the Zod issue so handlers can return `validation.failed`.
 *
 * Defaults are NOT applied here — the endpoint layer picks a default per
 * resource (messages=50, sessions=20) and feeds it in before validation.
 */
export const cursorQuerySchema = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** Alias matching the SCHEMAS.md type name. */
export const CursorQuery = cursorQuerySchema;

/**
 * Generic `Page<T>` factory for envelope.data on paginated list endpoints.
 *
 * Shape per SCHEMAS.md §1.3 — `items` plus `has_more` only. No `next_cursor`:
 * clients derive the next cursor from the first/last item id themselves.
 */
export const pageResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    has_more: z.boolean(),
  });

/**
 * Static companion to `pageResponseSchema`. `T` is the per-item type.
 */
export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}
