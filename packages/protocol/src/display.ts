/**
 * Tool input display type re-export from `@moonshot-ai/kimi-code-sdk`
 * (SCHEMAS.md §6.1).
 *
 * The full 12-arm `ToolInputDisplay` discriminated union — `command` /
 * `file_io` / `diff` / `search` / `url_fetch` / `agent_call` / `skill_call`
 * / `todo_list` / `background_task` / `task_stop` / `plan_review` /
 * `generic` — is the SOT, defined in agent-core's tool-display schemas and
 * re-exported through node-sdk's events module.
 *
 * Do not carve a daemon-specific subset; web clients that don't understand a
 * kind fall back to rendering `generic.summary` (SCHEMAS.md §6.1 "未知字段宽松").
 */
export type { ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';
