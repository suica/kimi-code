/**
 * Question entity schemas (SCHEMAS.md §6.2 / §6.3).
 *
 * Question is the **data-collection reverse-RPC** primitive — agent-core asks
 * the user 1-4 questions, each with required `options[]` (multi-select +
 * "Other" free-text bottom fall-back). Request is broadcast via WS
 * `event.question.requested`; the answer comes back via REST.
 *
 * **5-kind answer union** (SCHEMAS.md §6.2):
 *   - `single`            — `option_id`
 *   - `multi`             — `option_ids[]`
 *   - `other`             — `text` (free form via the "Other" fall-back)
 *   - `multi_with_other`  — `option_ids[]` + `other_text`
 *   - `skipped`           — empty (partial-answer marker for the un-answered
 *                          subset of a tri-state interaction; full-group
 *                          dismiss uses the separate `:dismiss` REST path).
 *
 * **vs in-process SDK shape** (SCHEMAS §6.4): agent-core's
 * `QuestionAnswers = Record<string, string | true>` is the lossy legacy
 * shape. The protocol↔in-process adapter (`packages/services/src/adapter/
 * question-adapter.ts`) flattens the 5-kind union into the SDK record per
 * §6.4 verbatim rules:
 *
 *     single            → answers[qid] = option_id
 *     multi             → answers[qid] = option_ids.join(',')   (lossy)
 *     other             → answers[qid] = text
 *     multi_with_other  → answers[qid] = [...option_ids, other_text].join(',')
 *     skipped           → omitted from the record entirely
 *
 * `Record<string, true>` was an in-process shorthand for "yes-no" answers;
 * the daemon never produces `true` (we always have an option_id or text), so
 * the adapter only emits `string`-valued entries.
 *
 * The wire form uses `kind` (not `type`) as the discriminator per SCHEMAS
 * §6.2 verbatim.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './time';

// --- §6.2 QuestionOption ----------------------------------------------------

/**
 * SCHEMAS §6.2: `QuestionOption.id` is the STABLE option identifier; answers
 * reference options by id (NOT by label, which is mutable for i18n).
 */
export const questionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

// --- §6.2 QuestionItem ------------------------------------------------------

/**
 * SCHEMAS §6.2: 1-4 questions per group, each with 2-4 options. `allow_other`
 * enables the "Other" free-text fall-back; `other_label` / `other_description`
 * customize the affordance's label.
 */
export const questionItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(questionOptionSchema).min(2).max(4),
  multi_select: z.boolean().optional(),
  allow_other: z.boolean().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;

// --- §6.2 QuestionRequest ---------------------------------------------------

export const questionRequestSchema = z.object({
  question_id: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.number().int().nonnegative().optional(),
  tool_call_id: z.string().min(1).optional(),
  questions: z.array(questionItemSchema).min(1).max(4),
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;

// --- §6.2 QuestionAnswer (5-kind discriminated union) -----------------------

/**
 * SCHEMAS §6.2 verbatim 5-kind discriminated union. Discriminator is `kind`.
 *
 * `option_id` / `option_ids` reference `QuestionOption.id` (which the daemon
 * does NOT structurally cross-validate against the original request here —
 * the adapter / REST handler can do that lookup with the held request).
 */
export const questionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), option_id: z.string().min(1) }),
  z.object({ kind: z.literal('multi'), option_ids: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('other'), text: z.string() }),
  z.object({
    kind: z.literal('multi_with_other'),
    option_ids: z.array(z.string().min(1)),
    other_text: z.string(),
  }),
  z.object({ kind: z.literal('skipped') }),
]);
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

// --- §6.2 QuestionResponse --------------------------------------------------

/**
 * `answers` is a Record keyed by `QuestionItem.id`. `method` / `note` are
 * informational. Partial-answer (some `kind: 'skipped'`) is valid;
 * full-group dismiss uses the separate `:dismiss` REST path.
 */
export const questionAnswerMethodSchema = z.enum(['enter', 'space', 'number_key', 'click']);
export type QuestionAnswerMethod = z.infer<typeof questionAnswerMethodSchema>;

export const questionResponseSchema = z.object({
  answers: z.record(z.string().min(1), questionAnswerSchema),
  method: questionAnswerMethodSchema.optional(),
  note: z.string().optional(),
});
export type QuestionResponse = z.infer<typeof questionResponseSchema>;
