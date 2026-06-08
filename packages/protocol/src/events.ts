/**
 * Event payload type re-exports from `@moonshot-ai/kimi-code-sdk`
 * (SCHEMAS.md §4).
 *
 * **No runtime Zod schemas.** High-frequency events stay on the unchecked
 * path, so event payload schemas are not double-written. The TS types below are the SOT;
 * daemon WS handlers serialize them as-is with `snake_case` field naming
 * already enforced upstream.
 *
 * `Event` is the agent-core event union (`AgentEvent & {agentId, sessionId}`).
 *
 * **Wire-shape Approval/Question request payloads** live in `./approval` /
 * `./question` — those are SNAKE_CASE wire shapes (with daemon-minted
 * `approval_id` / `question_id`, etc.), not the SDK's camelCase in-process
 * shapes. The protocol `ApprovalRequest` / `QuestionRequest` types come from
 * `./approval` / `./question` and are what WS broadcasts carry.
 *
 * Symbol mapping (this prompt → node-sdk export name):
 *   - `Event`            → `Event` (re-exported from `@moonshot-ai/agent-core`)
 */
export type { Event } from '@moonshot-ai/kimi-code-sdk';
