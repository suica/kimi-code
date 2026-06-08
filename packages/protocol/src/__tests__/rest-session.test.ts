/**
 * `/api/v1/sessions` REST endpoint schemas (REST.md §3.3).
 *
 * Tests the endpoint-specific shapes: create / list-query / update / delete
 * response. Session entity round-tripping is in `session.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  createSessionRequestSchema,
  deleteSessionResponseSchema,
  listSessionsQuerySchema,
  updateSessionMetaRequestSchema,
  updateSessionRequestSchema,
} from '../rest/session';

describe('createSessionRequestSchema', () => {
  it('accepts a minimal POST body with metadata.cwd', () => {
    const parsed = createSessionRequestSchema.parse({ metadata: { cwd: '/tmp/foo' } });
    expect(parsed.metadata?.cwd).toBe('/tmp/foo');
  });

  it('accepts a POST body with only workspace_id (route layer resolves cwd)', () => {
    const parsed = createSessionRequestSchema.parse({
      workspace_id: 'wd_kimi_0123456789ab',
    });
    expect(parsed.workspace_id).toBe('wd_kimi_0123456789ab');
    expect(parsed.metadata).toBeUndefined();
  });

  it('rejects metadata without cwd', () => {
    expect(
      createSessionRequestSchema.safeParse({ metadata: {} } as unknown).success,
    ).toBe(false);
  });

  it('rejects extra unknown agent_config keys via partial schema (zod is permissive but the partial holds known keys)', () => {
    // The partial schema accepts any subset of known keys; unknown keys are
    // dropped by zod's default strip-mode. This test pins the strip behavior
    // so a switch to `.strict()` later surfaces here first.
    const parsed = createSessionRequestSchema.parse({
      metadata: { cwd: '/tmp/foo' },
      agent_config: { model: 'm', unknown_key: 'x' } as unknown as { model: string },
    });
    expect(parsed.agent_config?.model).toBe('m');
    expect((parsed.agent_config as Record<string, unknown>)['unknown_key']).toBeUndefined();
  });
});

describe('listSessionsQuerySchema', () => {
  it('accepts an empty query (defaults applied at handler layer)', () => {
    expect(listSessionsQuerySchema.parse({})).toEqual({});
  });

  it('accepts before_id + page_size', () => {
    const parsed = listSessionsQuerySchema.parse({ before_id: 'sess_abc', page_size: 20 });
    expect(parsed.before_id).toBe('sess_abc');
    expect(parsed.page_size).toBe(20);
  });

  it('rejects before_id + after_id together (REST §1.6 mutual exclusivity)', () => {
    const result = listSessionsQuerySchema.safeParse({
      before_id: 'a',
      after_id: 'b',
    });
    expect(result.success).toBe(false);
  });

  it('rejects page_size > 100', () => {
    expect(listSessionsQuerySchema.safeParse({ page_size: 101 }).success).toBe(false);
  });

  it('accepts a status filter', () => {
    expect(listSessionsQuerySchema.parse({ status: 'idle' })).toEqual({ status: 'idle' });
  });

  it('rejects an unknown status value', () => {
    expect(listSessionsQuerySchema.safeParse({ status: 'frozen' }).success).toBe(false);
  });
});

describe('updateSessionMetaRequestSchema', () => {
  it('accepts a metadata patch (without cwd)', () => {
    expect(
      updateSessionMetaRequestSchema.parse({ metadata: { custom_field: 'x' } }),
    ).toEqual({ metadata: { custom_field: 'x' } });
  });

  it('accepts an empty POST body (no-op)', () => {
    expect(updateSessionMetaRequestSchema.parse({})).toEqual({});
  });

  it('accepts agent_config.model', () => {
    const parsed = updateSessionMetaRequestSchema.parse({
      agent_config: { model: 'moonshot-v1-128k' },
    });
    expect(parsed.agent_config?.model).toBe('moonshot-v1-128k');
  });
});

describe('updateSessionRequestSchema (legacy alias)', () => {
  it('round-trips through the same schema as updateSessionMetaRequestSchema', () => {
    expect(updateSessionRequestSchema.parse({ metadata: { custom_field: 'x' } })).toEqual(
      updateSessionMetaRequestSchema.parse({ metadata: { custom_field: 'x' } }),
    );
  });
});

describe('deleteSessionResponseSchema', () => {
  it('accepts the canonical { deleted: true } shape', () => {
    expect(deleteSessionResponseSchema.parse({ deleted: true })).toEqual({ deleted: true });
  });

  it('rejects { deleted: false }', () => {
    expect(deleteSessionResponseSchema.safeParse({ deleted: false }).success).toBe(false);
  });
});
