/**
 * HTTP layer for `DaemonClient` — typed wrappers around fetch + envelope
 * unwrap. All paths concatenate `baseUrl + apiPrefix + route`.
 */
import type {
  ApprovalResolveResult,
  ApprovalResponse,
  Envelope,
  FsBrowseResponse,
  FsHomeResponse,
  Message,
  PromptAbortResponse,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResolveResult,
  QuestionResponse,
  Session,
  SessionCreate,
  SessionUpdate,
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
} from '@moonshot-ai/protocol';

import { unwrap } from './envelope.js';

export interface HttpClientOptions {
  baseUrl: string;
  apiPrefix: string;
  fetchImpl: typeof fetch;
}

export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  private url(path: string): string {
    return `${this.opts.baseUrl}${this.opts.apiPrefix}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown | undefined,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    let init: RequestInit;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init = { method, headers, body: JSON.stringify(body) };
    } else {
      init = { method, headers };
    }
    const res = await this.opts.fetchImpl(this.url(path), init);
    const text = await res.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch (cause) {
      throw new Error(
        `daemon ${method} ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        { cause: cause as Error },
      );
    }
    return unwrap(envelope);
  }

  // ── Sessions ────────────────────────────────────────────────────────────
  createSession(body: SessionCreate): Promise<Session> {
    return this.request<Session>('POST', '/sessions', body);
  }
  getSession(sid: string): Promise<Session> {
    return this.request<Session>('GET', `/sessions/${encodeURIComponent(sid)}`, undefined);
  }
  listSessions(query?: {
    page_size?: number;
    before_id?: string;
    after_id?: string;
    workspace_id?: string;
  }): Promise<{ items: Session[]; has_more: boolean }> {
    return this.request('GET', `/sessions${qs(query)}`, undefined);
  }
  updateSession(sid: string, body: SessionUpdate): Promise<Session> {
    // Daemon canonical route: `POST /v1/sessions/{sid}/meta` (REST.md §3.3).
    // Earlier scaffolding spoke `PATCH /v1/sessions/{sid}`, which the daemon
    // never wired — keep the helper name (used by existing fixtures) and just
    // dispatch to the right URL.
    return this.request<Session>(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/meta`,
      body,
    );
  }
  deleteSession(sid: string): Promise<{ deleted: true }> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sid)}`, undefined);
  }

  // ── Workspaces ──────────────────────────────────────────────────────────
  listWorkspaces(): Promise<{ items: Workspace[] }> {
    return this.request('GET', '/workspaces', undefined);
  }
  createWorkspace(body: WorkspaceCreate): Promise<Workspace> {
    return this.request<Workspace>('POST', '/workspaces', body);
  }
  updateWorkspace(workspaceId: string, body: WorkspaceUpdate): Promise<Workspace> {
    return this.request<Workspace>(
      'PATCH',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      body,
    );
  }
  deleteWorkspace(workspaceId: string): Promise<{ deleted: true }> {
    return this.request(
      'DELETE',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      undefined,
    );
  }

  // ── Folder picker (fs:browse + fs:home) ─────────────────────────────────
  fsBrowse(path?: string): Promise<FsBrowseResponse> {
    return this.request('GET', `/fs:browse${qs({ path })}`, undefined);
  }
  fsHome(): Promise<FsHomeResponse> {
    return this.request('GET', '/fs:home', undefined);
  }

  // ── Messages ────────────────────────────────────────────────────────────
  listMessages(
    sid: string,
    query?: { page_size?: number; before_id?: string; after_id?: string; role?: string },
  ): Promise<{ items: Message[]; has_more: boolean }> {
    return this.request('GET', `/sessions/${encodeURIComponent(sid)}/messages${qs(query)}`, undefined);
  }

  // ── Prompts ─────────────────────────────────────────────────────────────
  submitPrompt(sid: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.request('POST', `/sessions/${encodeURIComponent(sid)}/prompts`, body);
  }
  abortPrompt(sid: string, pid: string): Promise<PromptAbortResponse> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/prompts/${encodeURIComponent(pid)}:abort`,
      {},
    );
  }

  // ── Approvals / Questions (reverse-RPC resolves) ────────────────────────
  resolveApproval(
    sid: string,
    aid: string,
    body: ApprovalResponse,
  ): Promise<ApprovalResolveResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(aid)}`,
      body,
    );
  }
  resolveQuestion(
    sid: string,
    qid: string,
    body: QuestionResponse,
  ): Promise<QuestionResolveResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sid)}/questions/${encodeURIComponent(qid)}`,
      body,
    );
  }
}

function qs(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
