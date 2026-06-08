/**
 * Self-tests for `DaemonClient` against a live daemon at
 * `process.env.DAEMON_URL ?? http://127.0.0.1:7878`.
 *
 * Every test gates on a `daemonReachable()` check so CI / dev machines
 * without a running daemon stay green. Run a daemon (`pnpm dev:daemon` from
 * repo root) to exercise these locally.
 *
 * Coverage:
 *   1. HTTP envelope unwrap throws on `code !== 0`.
 *   2. WS handshake completes (server_hello + client_hello ack).
 *   3. Subscribe ack succeeds for a real session id.
 *   4. `waitForFrame` times out cleanly (no zombie waiters).
 *   5. Created session is observable via `getSession`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { DaemonClient, EnvelopeError } from '../src/index.js';

const BASE_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await daemonReachable();
const itLive = reachable ? it : it.skip;

let created: { client: DaemonClient; sid: string }[] = [];

afterEach(async () => {
  // Best-effort cleanup so reruns don't accumulate phantom sessions.
  for (const { client, sid } of created.splice(0)) {
    try {
      await client.deleteSession(sid);
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

describe('DaemonClient (live daemon required)', () => {
  if (!reachable) {
    it.skip(`skipped — no daemon at ${BASE_URL} (set DAEMON_URL or start \`pnpm dev:daemon\`)`, () => {
      // intentionally empty
    });
  }

  itLive('throws EnvelopeError on code !== 0', async () => {
    const client = new DaemonClient({ baseUrl: BASE_URL });
    await expect(client.getSession('sess_does_not_exist_xxxxxxxx')).rejects.toBeInstanceOf(
      EnvelopeError,
    );
  });

  itLive('completes handshake (server_hello + client_hello ack)', async () => {
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const hello = await client.connect();
    expect(hello.heartbeat_ms).toBeGreaterThan(0);
    expect(typeof hello.ws_connection_id).toBe('string');
    await client.close();
  });

  itLive('subscribes to a real session id', async () => {
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    created.push({ client, sid: session.id });
    await client.connect();
    await expect(client.subscribe(session.id)).resolves.toBeUndefined();
  });

  itLive('waitForFrame times out cleanly', async () => {
    const client = new DaemonClient({ baseUrl: BASE_URL });
    await client.connect();
    await expect(
      client.waitForFrame((f) => f.type === 'event.does.not.exist', { timeoutMs: 100 }),
    ).rejects.toThrow(/waitForFrame timed out/);
    await client.close();
  });

  itLive('created session is readable via getSession', async () => {
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    created.push({ client, sid: session.id });
    const fetched = await client.getSession(session.id);
    expect(fetched.id).toBe(session.id);
    expect(fetched.metadata.cwd).toBe(process.cwd());
  });
});
