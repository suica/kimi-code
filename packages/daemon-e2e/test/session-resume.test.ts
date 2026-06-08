/**
 * Session-resume / status invariants — assertions for the two gaps the
 * "browser refresh" walkthrough flagged:
 *
 *   1. **Cold-session `GET /messages` must NOT 401.** Pre-fix, the
 *      messageService threw `SESSION_NOT_FOUND` (40401) for any session that
 *      wasn't loaded in the bridge's in-memory map. Fixed by
 *      `services/src/message/messageService.ts:106` calling
 *      `core.rpc.resumeSession({sessionId})` before `getContext`, so any
 *      session whose snapshot exists on disk is rehydrated transparently.
 *
 *   2. **`GET /sessions/{sid}.status` must reflect runtime state.** The
 *      protocol exposes `idle | running | awaiting_approval |
 *      awaiting_question | aborted` (`session.ts:36-42`); pre-fix,
 *      `toProtocolSession` (`services/src/session/session.ts:178`) hardcoded
 *      `status: 'idle'`. This test asserts the live daemon transitions
 *      `idle → running → idle` across a prompt; it's marked `it.fails` so the
 *      runner flags the moment the hardcode is removed.
 *
 * Both tests gate on `daemonReachable()` so CI without a daemon stays green.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { DaemonClient } from '../src/index.js';

const BASE_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';
const API_PREFIX = '/api/v1';
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

const reachable = await daemonReachable();
const itLive = reachable ? it : it.skip;

const created: Array<{ client: DaemonClient; sid: string }> = [];

afterEach(async () => {
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

describe('session resume + status (live daemon required)', () => {
  if (!reachable) {
    it.skip(`skipped — no daemon at ${BASE_URL} (set DAEMON_URL or start \`pnpm dev:daemon\`)`, () => {
      // intentionally empty
    });
  }

  // ── Gap 1: cold-session /messages ──────────────────────────────────────
  itLive(
    'GET /messages on a persisted session returns 200 (resumeSession injection)',
    async () => {
      const probe = new DaemonClient({ baseUrl: BASE_URL });

      // Seed: ensure at least one session exists in the store. (If a prior
      // daemon process already left some, we'll still pick one of those —
      // either way, the resumeSession code path is the same.)
      const seeded = await probe.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client: probe, sid: seeded.id });
      await probe.connect();
      await probe.subscribe(seeded.id);
      await probe.submitAndWait(
        seeded.id,
        { content: [{ type: 'text', text: 'Reply with "OK".' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      await probe.close();

      // Fresh client — closing the previous WS doesn't evict the bridge's
      // in-memory session, but it ensures the call goes through the REST
      // resume path (no stale subscription state).
      const fresh = new DaemonClient({ baseUrl: BASE_URL });
      const { items: sessions } = await fresh.listSessions({ page_size: 20 });
      expect(sessions.length).toBeGreaterThan(0);

      // Probe up to 3 sessions to keep the test deterministic across daemon
      // states (fresh-start vs. long-running). Every one must return 200.
      const probeSet = sessions.slice(0, 3);
      for (const s of probeSet) {
        const { items: msgs } = await fresh.listMessages(s.id, { page_size: 5 });
        expect(Array.isArray(msgs), `messages for ${s.id} should be an array`).toBe(true);
      }
      await fresh.close();
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );

  // ── Gap 2: live status field ───────────────────────────────────────────
  // Marked `it.fails` until the toProtocolSession hardcode at
  // `services/src/session/session.ts:178` is replaced with a real status
  // pull (likely from the bridge's `ISessionService.getStatus(sid)` or
  // similar). When the fix lands the test starts passing and vitest fails
  // *this* assertion shape — that's the cue to remove `.fails`.
  itLive.fails(
    'GET /sessions/{sid}.status transitions idle → running → idle across a prompt',
    async () => {
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });
      expect(session.status).toBe('idle');

      await client.connect();
      await client.subscribe(session.id);

      // Fire-and-forget submit so we can poll while the prompt is mid-flight.
      const submit = await client.submitPrompt(session.id, {
        content: [{ type: 'text', text: 'Reply with "OK".' }],
      });

      // Race the daemon: poll status quickly until we observe a non-idle
      // value or `prompt.completed` lands. Either outcome ends the loop; we
      // assert on the captured `seenRunning` flag afterward.
      let seenRunning = false;
      const ackPromise = client.waitForFrame(
        (f) => {
          if (f.type !== 'prompt.completed') return false;
          const payload = (f.payload ?? {}) as { promptId?: string; prompt_id?: string };
          return (payload.promptId ?? payload.prompt_id) === submit.prompt_id;
        },
        { timeoutMs: PROMPT_TIMEOUT_MS },
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !seenRunning) {
        const snap = await client.http.getSession(session.id);
        if (snap.status !== 'idle') {
          seenRunning = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await ackPromise;
      const after = await client.http.getSession(session.id);

      expect(seenRunning, 'expected at least one non-idle status reading during prompt').toBe(true);
      expect(after.status).toBe('idle');
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );
});
