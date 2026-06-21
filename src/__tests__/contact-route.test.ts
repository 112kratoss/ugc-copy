import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ insert }));
  const createClient = vi.fn((_url: string, _key: string) => {
    void _url;
    void _key;

    return { from };
  });
  const createServiceClient = vi.fn(() => ({ from }));

  return {
    createClient,
    createServiceClient,
    from,
    insert,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string) => mocks.createClient(url, key),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
}));

function buildContactRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/contact route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
    mocks.createServiceClient.mockClear();
    mocks.from.mockClear();
    mocks.insert.mockClear();
    mocks.insert.mockResolvedValue({ error: null });
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('rejects invalid contact payloads before creating a privileged Supabase client', async () => {
    const { POST } = await import('@/app/api/contact/route');
    const response = await POST(buildContactRequest({
      name: 'Athul',
      email: 'athul@example.com',
    }));

    expect(response.status).toBe(400);
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
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('contact_messages');
    expect(mocks.insert).toHaveBeenCalledWith({
      name: 'Athul',
      email: 'athul@example.com',
      subject: 'general',
      message: 'Hello',
    });
  });
});
