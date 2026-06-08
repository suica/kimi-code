/**
 * WebSocket control / system messages (WS.md §2, §3).
 *
 * WS messages do NOT use the REST `Envelope` shape. There are three
 * distinct outer shapes (WS.md §2):
 *
 *   1. Event   — server-pushed event with `seq` and `session_id`
 *                (`{type, seq, session_id, timestamp, payload}`)
 *   2. Control — client-issued control message, optional `id` for ack
 *                correlation (`{type, id?, payload}`)
 *   3. Ack     — server's response to a Control, echoing back `id` plus
 *                `code` + `msg` from the REST error-code namespace
 *                (`{type: 'ack', id, code, msg, payload}`)
 *
 * Each control message in §3 also has a corresponding payload schema. This
 * module exports a Zod schema for every message listed in WS.md §3 plus the
 * generic envelope factories.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from './time';

/* --------------------------------------------------------------------------
 * Generic envelope factories (WS.md §2)
 * ------------------------------------------------------------------------ */

/**
 * Outer shape for server-pushed events. `session_id` is optional because
 * non-session events (e.g. `server_hello`) live on the same frame channel
 * but aren't scoped to a session. `seq` is `0` for non-event system messages
 * (WS.md §2: "事件用；非事件消息 seq=0").
 */
export const wsEventEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    session_id: z.string().optional(),
    timestamp: isoDateTimeSchema,
    payload,
  });

/**
 * Outer shape for client-issued control messages.
 *
 * `id` is optional per WS.md §2 ("客户端生成；server ack 回带"), but in
 * practice every control message that wants an ack supplies one.
 */
export const wsControlEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    id: z.string().optional(),
    payload,
  });

/**
 * Outer shape for the server's `ack` frame in response to a control message
 * (WS.md §2). `code` is from the REST error-code namespace (`0` = success).
 */
export const wsAckEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.literal('ack'),
    id: z.string(),
    code: z.number().int(),
    msg: z.string(),
    payload,
  });

/* --------------------------------------------------------------------------
 * §3.1 server_hello (S→C) — first frame after connect
 * ------------------------------------------------------------------------ */

export const serverHelloPayloadSchema = z.object({
  ws_connection_id: z.string(),
  heartbeat_ms: z.number().int().positive(),
  max_event_buffer_size: z.number().int().positive(),
  capabilities: z.object({
    event_batching: z.boolean(),
    compression: z.boolean(),
  }),
});

export const serverHelloMessageSchema = z.object({
  type: z.literal('server_hello'),
  timestamp: isoDateTimeSchema,
  payload: serverHelloPayloadSchema,
});

export type ServerHelloMessage = z.infer<typeof serverHelloMessageSchema>;

/* --------------------------------------------------------------------------
 * §3.2 client_hello (C→S) — required first frame from client
 * ------------------------------------------------------------------------ */

export const clientHelloPayloadSchema = z.object({
  client_id: z.string(),
  subscriptions: z.array(z.string()),
  last_seq_by_session: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

export const clientHelloMessageSchema = z.object({
  type: z.literal('client_hello'),
  id: z.string(),
  payload: clientHelloPayloadSchema,
});

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;

/** Ack payload for `client_hello` / `subscribe` (WS.md §3.2, §3.3). */
export const helloAckPayloadSchema = z.object({
  accepted_subscriptions: z.array(z.string()).optional(),
  accepted: z.array(z.string()).optional(),
  not_found: z.array(z.string()).optional(),
  resync_required: z.array(z.string()),
});

/* --------------------------------------------------------------------------
 * §3.3 subscribe / unsubscribe (C→S)
 * ------------------------------------------------------------------------ */

export const watchFsConfigSchema = z.object({
  paths: z.array(z.string()),
  recursive: z.boolean().optional(),
});

export const subscribePayloadSchema = z.object({
  session_ids: z.array(z.string()),
  last_seq_by_session: z.record(z.string(), z.number().int().nonnegative()).optional(),
  watch_fs: z.record(z.string(), watchFsConfigSchema).optional(),
});

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  id: z.string(),
  payload: subscribePayloadSchema,
});

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

export const unsubscribePayloadSchema = z.object({
  session_ids: z.array(z.string()),
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  id: z.string(),
  payload: unsubscribePayloadSchema,
});

export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

/* --------------------------------------------------------------------------
 * §3.3.1 watch_fs_add / watch_fs_remove (C→S)
 * ------------------------------------------------------------------------ */

export const watchFsAddPayloadSchema = z.object({
  session_id: z.string(),
  paths: z.array(z.string()),
  recursive: z.boolean().optional(),
});

export const watchFsAddMessageSchema = z.object({
  type: z.literal('watch_fs_add'),
  id: z.string(),
  payload: watchFsAddPayloadSchema,
});

export type WatchFsAddMessage = z.infer<typeof watchFsAddMessageSchema>;

export const watchFsRemovePayloadSchema = z.object({
  session_id: z.string(),
  paths: z.array(z.string()),
});

export const watchFsRemoveMessageSchema = z.object({
  type: z.literal('watch_fs_remove'),
  id: z.string(),
  payload: watchFsRemovePayloadSchema,
});

export type WatchFsRemoveMessage = z.infer<typeof watchFsRemoveMessageSchema>;

export const watchFsAckPayloadSchema = z.object({
  watched_paths: z.array(z.string()).optional(),
  current_count: z.number().int().nonnegative().optional(),
});

/* --------------------------------------------------------------------------
 * §3.4 abort (C→S) — prompt cancellation main path
 * ------------------------------------------------------------------------ */

export const abortPayloadSchema = z.object({
  session_id: z.string(),
  prompt_id: z.string(),
});

export const abortMessageSchema = z.object({
  type: z.literal('abort'),
  id: z.string(),
  payload: abortPayloadSchema,
});

export type AbortMessage = z.infer<typeof abortMessageSchema>;

export const abortAckPayloadSchema = z.object({
  aborted: z.boolean().optional(),
  at_seq: z.number().int().nonnegative().optional(),
});

/* --------------------------------------------------------------------------
 * §3.5 ping / pong
 * ------------------------------------------------------------------------ */

export const pingPayloadSchema = z.object({
  nonce: z.string(),
});

/** `ping` is server-pushed (S→C) so it carries a `timestamp` (WS.md §3.5). */
export const pingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp: isoDateTimeSchema,
  payload: pingPayloadSchema,
});

export type PingMessage = z.infer<typeof pingMessageSchema>;

export const pongPayloadSchema = z.object({
  nonce: z.string(),
});

/** `pong` is client-pushed (C→S); no `timestamp`, no `id` in WS.md §3.5. */
export const pongMessageSchema = z.object({
  type: z.literal('pong'),
  payload: pongPayloadSchema,
});

export type PongMessage = z.infer<typeof pongMessageSchema>;

/* --------------------------------------------------------------------------
 * §3.6 resync_required (S→C) — system notification
 * ------------------------------------------------------------------------ */

export const resyncRequiredPayloadSchema = z.object({
  session_id: z.string(),
  reason: z.enum(['buffer_overflow', 'session_recreated']),
  current_seq: z.number().int().nonnegative(),
});

export const resyncRequiredMessageSchema = z.object({
  type: z.literal('resync_required'),
  timestamp: isoDateTimeSchema,
  payload: resyncRequiredPayloadSchema,
});

export type ResyncRequiredMessage = z.infer<typeof resyncRequiredMessageSchema>;

/* --------------------------------------------------------------------------
 * §3.7 error (S→C) — connection-level error
 * ------------------------------------------------------------------------ */

export const wsErrorPayloadSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  fatal: z.boolean(),
  request_id: z.string().optional(),
  details: z.unknown().optional(),
});

export const wsErrorMessageSchema = z.object({
  type: z.literal('error'),
  timestamp: isoDateTimeSchema,
  payload: wsErrorPayloadSchema,
});

export type WsErrorMessage = z.infer<typeof wsErrorMessageSchema>;

/* --------------------------------------------------------------------------
 * Discriminated union of all C→S control message shapes (WS.md §3.2 .. §3.5)
 * ------------------------------------------------------------------------ */

export const clientControlMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  watchFsAddMessageSchema,
  watchFsRemoveMessageSchema,
  abortMessageSchema,
  pongMessageSchema,
]);

export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

/* --------------------------------------------------------------------------
 * Discriminated union of all S→C system (non-event) message shapes
 * ------------------------------------------------------------------------ */

export const serverSystemMessageSchema = z.discriminatedUnion('type', [
  serverHelloMessageSchema,
  pingMessageSchema,
  resyncRequiredMessageSchema,
  wsErrorMessageSchema,
]);

export type ServerSystemMessage = z.infer<typeof serverSystemMessageSchema>;
