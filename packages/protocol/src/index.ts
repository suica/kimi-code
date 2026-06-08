/**
 * `@moonshot-ai/protocol` — daemon REST + WS wire protocol.
 *
 * Exports Zod schemas + TS types for envelopes, error codes, pagination,
 * time normalization, request_id helpers, WS control messages, and re-exports
 * event / approval / question types from `@moonshot-ai/kimi-code-sdk`.
 *
 * Wire format: see REST.md / WS.md / SCHEMAS.md.
 */
export * from './envelope';
export * from './error-codes';
export * from './pagination';
export * from './time';
export * from './request-id';
export * from './events';
export * from './display';
export * from './ws-control';

// Entity schemas (cross-endpoint). Keep these one level above `./rest/` so
// per-endpoint REST schemas can import them without circular ref.
export * from './session';
export * from './message';
export * from './approval';
export * from './question';
export * from './tool';
export * from './task';
export * from './fs';
export * from './file';

// REST endpoint shapes (per-endpoint Zod schemas + TS types). Mirrors
// REST.md §3.x; each file under `./rest/` owns ONE endpoint family.
export * from './rest/meta';
export * from './rest/auth';
export * from './rest/oauth';
export * from './rest/session';
export * from './rest/message';
export * from './rest/prompt';
export * from './rest/approval';
export * from './rest/question';
export * from './rest/tool';
export * from './rest/task';
export * from './rest/fs';
export * from './rest/file';
