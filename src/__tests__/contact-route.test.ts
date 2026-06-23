import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ insert }));
  const rpc = vi.fn(async () => ({
    data: {
      allowed: true,
      limit: 10,
      remaining: 9,
      retryAfterSeconds: 0,
      resetAt: '2026-06-21T06:30:00.000Z',
    },
    error: null,
  }));
  const createClient = vi.fn((_url: string, _key: string) => {
    void _url;
    void _key;

    return { from };
  });
  const createServiceClient = vi.fn(() => ({ from, rpc }));

  return {
    createClient,
    createServiceClient,
    from,
    insert,
    rpc,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string) => mocks.createClient(url, key),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
}));

function buildContactRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/contact route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
    mocks.createServiceClient.mockClear();
    mocks.from.mockClear();
    mocks.insert.mockClear();
    mocks.insert.mockResolvedValue({ error: null });
    mocks.rpc.mockClear();
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: true,
        limit: 10,
        remaining: 9,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('rejects invalid contact payloads before creating a privileged Supabase client', async () => {
    const { POST } = await import('@/app/api/contact/route');
    const response = await POST(buildContactRequest({
      name: 'Athul',
      email: 'athul@example.com',
    }, {
      'x-request-id': 'contact-invalid-1',
    }));

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'contact-invalid-1');
    expect(await response.json()).toEqual({
      error: 'Name, email, and message are required',
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('stores valid contact messages through the shared service client helper', async () => {
    const { POST } = await import('@/app/api/contact/route');
    const response = await POST(buildContactRequest({
      name: ' Athul ',
      email: ' ATHUL@EXAMPLE.COM ',
      subject: '',
      message: ' Hello ',
    }, {
      'x-request-id': 'contact-success-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'contact-success-1');
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'contact:submit',
      p_subject_key: '127.0.0.1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(mocks.from).toHaveBeenCalledWith('contact_messages');
    expect(mocks.insert).toHaveBeenCalledWith({
      name: 'Athul',
      email: 'athul@example.com',
      subject: 'general',
      message: 'Hello',
    });
  });

  it('rate limits public contact submissions before inserting messages', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: false,
        limit: 10,
        remaining: 0,
        retryAfterSeconds: 42,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/contact/route');
    const response = await POST(buildContactRequest({
      name: 'Athul',
      email: 'athul@example.com',
      message: 'Hello',
    }, {
      'x-forwarded-for': '203.0.113.10, 10.0.0.5',
      'x-request-id': 'contact-rate-limit-1',
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expectPrivateNoStoreTraceHeaders(response, 'contact-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'contact:submit',
      p_subject_key: '203.0.113.10',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
