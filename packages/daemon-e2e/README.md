# @moonshot-ai/daemon-e2e

Wire-level test client for the kimi-code daemon (HTTP + WS). This package is
**private** — it ships scenario scripts that double as smoke tests and a small
typed `DaemonClient` you can reuse in vitest e2e files.

## When to use this

- You want to drive a real, running daemon process from a Node script and
  observe HTTP + WS behavior end to end.
- You're writing a vitest e2e that covers daemon REST + WS lifecycle as a
  whole — not a single in-process unit (those belong in `packages/daemon/test/`).
- You need a reference for the wire shape of approval / question / events.

## When NOT to use this

- You're testing the WS gateway in isolation — keep using
  `packages/daemon/test/ws-*.e2e.test.ts` (in-process `startDaemon` boots are
  faster and assert on the daemon's internal services directly).
- You want a typed in-process facade over the daemon for user-facing code —
  use `@moonshot-ai/node-sdk` instead (`KimiHarness`, `Session`).

## Quick start

```ts
import { DaemonClient } from '@moonshot-ai/daemon-e2e';

const client = new DaemonClient(); // http://127.0.0.1:7878 by default

const session = await client.createSession({ metadata: { cwd: process.cwd() } });
await client.connect();              // server_hello + client_hello ack
await client.subscribe(session.id);

client.onApprovalRequested(() => ({ decision: 'approved' }));

const { prompt_id, finalFrame } = await client.submitAndWait(session.id, {
  content: [{ type: 'text', text: 'Echo hello' }],
});

await client.close();
await client.deleteSession(session.id);
```

## Scripts

```sh
pnpm --filter @moonshot-ai/daemon-e2e typecheck
pnpm --filter @moonshot-ai/daemon-e2e test            # vitest self-tests
pnpm --filter @moonshot-ai/daemon-e2e test:scenarios  # run every scenarios/*.mjs
```

Both `test` and `test:scenarios` require a running daemon (set `DAEMON_URL`
to override the default `http://127.0.0.1:7878`). The vitest suite skips its
live-dependent cases when no daemon is reachable so CI stays green. Scenarios
are run via `tsx` because they import from `src/*.ts` directly.

## Public API summary

| Symbol | Purpose |
|---|---|
| `DaemonClient` | Main facade — HTTP + WS, handshake plumbing, reverse-RPC handlers. |
| `HttpClient` | REST helpers only (no WS). Useful when you don't need event observation. |
| `WsClient` | Raw WS wrapper — queue, waiters, ack correlation. |
| `EnvelopeError` | Thrown by `unwrap()` / HTTP helpers when `envelope.code !== 0`. |
| `installReverseRpcHandler` | Uniform helper powering `onApprovalRequested` / `onQuestionAsked`. |
| `waitForFrame` / `waitForSessionStatus` | Standalone wait helpers reused by scenarios. |

See `scenarios/README.md` for the executable script catalog and conventions.

## Scope notes

- **No in-process daemon bootstrap** — point at an already-running daemon.
  An in-process `startDaemon(port:0)` helper is intentionally out of scope.
- **No auto-discovery** — the WS endpoint is hard-coded to `${apiPrefix}/ws`.
  Override via `apiPrefix` only.
- **Not published** — `private: true`. Internal tooling only.
