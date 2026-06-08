/**
 * Refresh / reload wire-level invariants.
 *
 * Models the page-refresh path a web client takes when the daemon is already
 * up: hit `/healthz`, `/meta`, `/auth`, then open a fresh WebSocket and replay
 * any missed events via `client_hello.last_seq_by_session` BEFORE pulling REST
 * history (REST.md §3 + WS.md §3.2).
 *
 * What's asserted here (and NOT in `client.test.ts`):
 *   1. `/healthz` returns `{ok: true}`.
 *   2. `/meta` exposes a non-empty `daemon_id` — the signal clients use to
 *      detect a daemon restart and flush their `last_seq_by_session` cache.
 *   3. `/auth` returns the `AuthSummary` shape.
 *   4. After running one prompt to populate the ring buffer, a fresh WS that
 *      passes `last_seq_by_session: { [sid]: currentSeq }` is acked with
 *      `accepted_subscriptions: [sid]`, `resync_required: []`, and NO event
 *      frames arrive between `server_hello` and the ack (caught-up replay).
 *   5. A fresh WS that passes `last_seq_by_session: { [sid]: 0 }` triggers
 *      replay of every buffered event in order (seq 1..N) BEFORE the ack.
 *   6. After reconnect, `GET /messages` reflects the persisted state from
 *      before the WS close.
 *
 * Live-daemon gated via the same `daemonReachable()` check as
 * `client.test.ts`; missing daemon → tests skip cleanly so CI stays green.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';

import { DaemonClient, WsClient, type AnyFrame } from '../src/index.js';

const BASE_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';
const API_PREFIX = '/api/v1';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 120_000;

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}${API_PREFIX}/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T;
  request_id?: string;
}

async function getEnvelope<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${API_PREFIX}${path}`, {
    headers: { accept: 'application/json' },
  });
  const body = (await res.json()) as Envelope<T>;
  expect(typeof body.code, `${path} missing envelope.code`).toBe('number');
  expect(body.code, `${path} returned code=${body.code} msg=${body.msg ?? ''}`).toBe(0);
  return body.data;
}

interface HelloResult {
  ws: WsClient;
  ack: AnyFrame;
  replayed: AnyFrame[];
}

async function openSocketWithHello(opts: {
  sid: string;
  lastSeq?: number;
  clientId?: string;
}): Promise<HelloResult> {
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}${API_PREFIX}/ws`;
  const ws = new WsClient({ url: wsUrl, wsImpl: WsWebSocket, logger: () => {} });
  await ws.open();

  const arrivals: AnyFrame[] = [];
  ws.onFrame((f) => arrivals.push(f));

  await ws.waitForFrame((f) => f.type === 'server_hello', HANDSHAKE_TIMEOUT_MS);

  const helloId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: Record<string, unknown> = {
    client_id: opts.clientId ?? `vitest-refresh-${process.pid}`,
    subscriptions: [opts.sid],
  };
  if (opts.lastSeq !== undefined) {
    payload['last_seq_by_session'] = { [opts.sid]: opts.lastSeq };
  }
  ws.send({ type: 'client_hello', id: helloId, payload });

  const ack = await ws.waitForFrame(
    (f) => f.type === 'ack' && f.id === helloId,
    HANDSHAKE_TIMEOUT_MS,
  );

  const replayed = arrivals.filter(
    (f) =>
      f.type !== 'server_hello' &&
      f.type !== 'ack' &&
      f.type !== 'ping' &&
      f.type !== 'resync_required' &&
      f.type !== 'error' &&
      typeof f.seq === 'number' &&
      f.session_id === opts.sid &&
      (opts.lastSeq === undefined || f.seq > opts.lastSeq),
  );

  return { ws, ack, replayed };
}

const reachable = await daemonReachable();
const itLive = reachable ? it : it.skip;

const created: Array<{ client: DaemonClient; sid: string }> = [];
const sockets: WsClient[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      await ws.close();
    } catch {
      // ignore
    }
  }
  for (const { client, sid } of created.splice(0)) {
    try {
      await client.http.deleteSession(sid);
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
});

describe('refresh-replay (live daemon required)', () => {
  if (!reachable) {
    it.skip(`skipped — no daemon at ${BASE_URL} (set DAEMON_URL or start \`pnpm dev:daemon\`)`, () => {
      // intentionally empty
    });
  }

  itLive('phase 0: /healthz returns ok:true', async () => {
    const health = await getEnvelope<{ ok: boolean }>('/healthz');
    expect(health.ok).toBe(true);
  });

  itLive('phase 0: /meta exposes daemon_id, version, started_at', async () => {
    const meta = await getEnvelope<{
      daemon_id: string;
      daemon_version: string;
      started_at: string;
      capabilities: Record<string, boolean>;
    }>('/meta');
    expect(meta.daemon_id).toMatch(/.+/);
    expect(meta.daemon_version).toMatch(/.+/);
    expect(meta.started_at).toMatch(/.+/);
    expect(meta.capabilities['websocket']).toBe(true);
  });

  itLive('phase 0: /auth returns AuthSummary shape', async () => {
    const auth = await getEnvelope<{
      ready: boolean;
      providers_count: number;
      default_model: string | null;
      managed_provider: { name: string; status: string } | null;
    }>('/auth');
    expect(typeof auth.ready).toBe('boolean');
    expect(typeof auth.providers_count).toBe('number');
  });

  itLive(
    'reconnect with caught-up last_seq → ack accepts subscription, no replay events',
    async () => {
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });

      await client.connect();
      await client.subscribe(session.id);

      let maxSeq = 0;
      client.onFrame((f) => {
        if (
          typeof f.seq === 'number' &&
          f.session_id === session.id &&
          f.seq > maxSeq
        ) {
          maxSeq = f.seq;
        }
      });

      const { finalFrame } = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Reply with the single word "OK" and nothing else.' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      if (typeof finalFrame.seq === 'number' && finalFrame.seq > maxSeq) {
        maxSeq = finalFrame.seq;
      }
      expect(maxSeq, 'session must publish at least one event before reconnect').toBeGreaterThan(0);

      await client.close();

      const refreshed = await openSocketWithHello({ sid: session.id, lastSeq: maxSeq });
      sockets.push(refreshed.ws);

      expect(refreshed.ack.code).toBe(0);
      const payload = (refreshed.ack.payload ?? {}) as {
        accepted_subscriptions?: string[];
        resync_required?: string[];
      };
      expect(payload.accepted_subscriptions ?? []).toEqual([session.id]);
      expect(payload.resync_required ?? []).toEqual([]);
      expect(
        refreshed.replayed,
        `expected 0 replay events when caught up, got: ${JSON.stringify(refreshed.replayed.map((f) => `${f.type}@${f.seq}`))}`,
      ).toHaveLength(0);
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );

  itLive(
    'reconnect with last_seq=0 → daemon replays buffered events in order before ack',
    async () => {
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });

      await client.connect();
      await client.subscribe(session.id);

      let maxSeq = 0;
      client.onFrame((f) => {
        if (
          typeof f.seq === 'number' &&
          f.session_id === session.id &&
          f.seq > maxSeq
        ) {
          maxSeq = f.seq;
        }
      });

      const { finalFrame } = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Reply with the single word "OK" and nothing else.' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      if (typeof finalFrame.seq === 'number' && finalFrame.seq > maxSeq) {
        maxSeq = finalFrame.seq;
      }
      expect(maxSeq).toBeGreaterThan(0);

      await client.close();

      const refreshed = await openSocketWithHello({ sid: session.id, lastSeq: 0 });
      sockets.push(refreshed.ws);

      expect(refreshed.ack.code).toBe(0);
      const payload = (refreshed.ack.payload ?? {}) as {
        accepted_subscriptions?: string[];
        resync_required?: string[];
      };
      expect(payload.accepted_subscriptions ?? []).toEqual([session.id]);
      // Buffer cap defaults to 1000; a single prompt emits <<1000 events, so
      // every event is still in the ring → no resync_required.
      expect(payload.resync_required ?? []).toEqual([]);
      expect(refreshed.replayed.length).toBeGreaterThan(0);

      const seqs = refreshed.replayed
        .map((f) => f.seq)
        .filter((n): n is number => typeof n === 'number');
      expect(Math.min(...seqs)).toBe(1);
      expect(Math.max(...seqs)).toBe(maxSeq);
      // Daemon must dispatch buffered events in seq order
      // (eventService.getBufferedSince filters the buffer in insertion order).
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(seqs).toEqual(sorted);

      // Phase 2: REST snapshot reflects the persisted user + assistant pair.
      const { items } = await client.http.listMessages(session.id, { page_size: 100 });
      expect(items.some((m) => m.role === 'user')).toBe(true);
      expect(items.some((m) => m.role === 'assistant')).toBe(true);

      // `GET /tasks` returns the documented `{items:[]}` envelope shape.
      const tasks = await getEnvelope<{ items: unknown[] }>(
        `/sessions/${encodeURIComponent(session.id)}/tasks`,
      );
      expect(Array.isArray(tasks.items)).toBe(true);
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );
});
