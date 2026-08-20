import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getContactRateLimitKey,
  submitContactMessageForRoute,
} from '@/lib/contact-submission-service';

function createContactClientMock(options?: {
  rateLimited?: boolean;
  rateLimitError?: { message: string } | null;
  insertError?: { message: string } | null;
}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tables: [] as string[],
    inserts: [] as Array<Record<string, unknown>>,
  };

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      if (name !== 'check_backend_rate_limit') {
        throw new Error(`Unexpected RPC: ${name}`);
      }

      return Promise.resolve({
        data: {
          allowed: !options?.rateLimited,
          limit: 10,
          remaining: options?.rateLimited ? 0 : 9,
          retryAfterSeconds: options?.rateLimited ? 42 : 0,
          resetAt: '2026-06-23T06:30:00.000Z',
        },
        error: options?.rateLimitError ?? null,
      });
    },
    from(table: string) {
      calls.tables.push(table);
      if (table !== 'contact_messages') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        async insert(payload: Record<string, unknown>) {
          calls.inserts.push(payload);
          return { error: options?.insertError ?? null };
        },
      };
    },
  };

  return {
    calls,
    client: client as unknown as SupabaseClient,
  };
}

describe('getContactRateLimitKey', () => {
  it('prefers forwarded client IP, then real IP, then localhost fallback', () => {
    expect(getContactRateLimitKey(new Headers({
      'x-forwarded-for': '203.0.113.10, 10.0.0.5',
      'x-real-ip': '198.51.100.2',
    }))).toBe('203.0.113.10');

    expect(getContactRateLimitKey(new Headers({
      'x-real-ip': '198.51.100.2',
    }))).toBe('198.51.100.2');

    expect(getContactRateLimitKey(new Headers())).toBe('127.0.0.1');
  });
});

describe('submitContactMessageForRoute', () => {
  it('charges invalid payloads to the network rate limit before validation', async () => {
    const admin = createContactClientMock();
    const createAdminSupabase = vi.fn(() => admin.client);

    const result = await submitContactMessageForRoute({
      readBody: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: 'Athul',
          email: 'athul@example.com',
        },
      })),
      rateLimitKey: '203.0.113.10',
      createAdminSupabase,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Name, email, and message are required' },
    });
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(admin.calls.rpc).toHaveLength(1);
    expect(admin.calls.inserts).toEqual([]);
  });

  it('normalizes valid contact messages after rate limiting', async () => {
    const admin = createContactClientMock();

    const result = await submitContactMessageForRoute({
      readBody: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: ' Athul ',
          email: ' ATHUL@EXAMPLE.COM ',
          subject: '',
          message: ' Hello ',
        },
      })),
      rateLimitKey: '203.0.113.10',
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(admin.calls.rpc).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'contact:submit',
          p_subject_key: '203.0.113.10',
          p_limit: 10,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(admin.calls.inserts).toEqual([
      {
        name: 'Athul',
        email: 'athul@example.com',
        subject: 'general',
        message: 'Hello',
      },
    ]);
  });

  it('returns a route-ready rate limit result before inserting messages', async () => {
    const admin = createContactClientMock({ rateLimited: true });

    const readBody = vi.fn(async () => ({
      ok: true as const,
      value: {
        name: 'Athul',
        email: 'athul@example.com',
        message: 'Hello',
      },
    }));
    const result = await submitContactMessageForRoute({
      readBody,
      rateLimitKey: '203.0.113.10',
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected a rate-limit error');
    expect(result.status).toBe(429);
    expect(result).toHaveProperty('rateLimitError');
    expect(result.body).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 10,
      resetAt: '2026-06-23T06:30:00.000Z',
    });
    expect(admin.calls.inserts).toEqual([]);
    expect(readBody).not.toHaveBeenCalled();
  });

  it('returns 413 after admission when the bounded reader rejects the body', async () => {
    const admin = createContactClientMock();

    const result = await submitContactMessageForRoute({
      readBody: vi.fn(async () => ({ ok: false as const, reason: 'too_large' as const })),
      rateLimitKey: '203.0.113.10',
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 413,
      body: { error: 'Contact submission is too large.' },
    });
    expect(admin.calls.rpc).toHaveLength(1);
    expect(admin.calls.inserts).toEqual([]);
  });

  it('maps Supabase insert failures to stable route errors', async () => {
    const admin = createContactClientMock({ insertError: { message: 'database unavailable' } });

    const result = await submitContactMessageForRoute({
      readBody: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: 'Athul',
          email: 'athul@example.com',
          message: 'Hello',
        },
      })),
      rateLimitKey: '203.0.113.10',
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to send message. Please try again.' },
    });
  });
});
