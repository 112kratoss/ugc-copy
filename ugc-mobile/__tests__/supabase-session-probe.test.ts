import { describe, expect, it, vi } from 'vitest';

import { probeSupabaseSession } from '../lib/supabase-session-probe';

function answer(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function probe(fetcher: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  return probeSupabaseSession({
    supabaseUrl: 'https://project.supabase.example/',
    publishableKey: 'publishable-key',
    accessToken: 'access-token',
    fetcher: fetcher as unknown as typeof fetch,
    timeoutMs,
  });
}

describe('probeSupabaseSession', () => {
  it('asks Supabase Auth about the token itself', async () => {
    const fetcher = answer(200, { id: 'user-1' });

    await expect(probe(fetcher)).resolves.toBe('alive');

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://project.supabase.example/auth/v1/user');
    expect(init.headers).toMatchObject({
      apikey: 'publishable-key',
      Authorization: 'Bearer access-token',
    });
  });

  // The session_not_found, user_not_found and bad_jwt bodies are verbatim what
  // Supabase Auth returned on 2026-09-11, from the local stack; production gave
  // the identical bad_jwt body for a token no key had signed.
  it('reports a session that no longer exists as ended', async () => {
    await expect(probe(answer(403, {
      code: 403,
      error_code: 'session_not_found',
      msg: 'Session from session_id claim in JWT does not exist',
    }))).resolves.toBe('ended');
  });

  it('reports a deleted user as ended', async () => {
    await expect(probe(answer(403, {
      code: 403,
      error_code: 'user_not_found',
      msg: 'User from sub claim in JWT does not exist',
    }))).resolves.toBe('ended');
  });

  it('reads the error from the 2024-01-01 response format too', async () => {
    // Not observed here: the format Supabase Auth uses for clients that send
    // its API-version header, where `code` carries the name instead.
    await expect(probe(answer(403, { code: 'session_not_found', message: 'Session not found' })))
      .resolves.toBe('ended');
  });

  it('reports a clean refusal for any other reason, which a refresh can settle', async () => {
    await expect(probe(answer(403, {
      code: 403,
      error_code: 'bad_jwt',
      msg: 'invalid JWT: unable to parse or verify signature, token signature is invalid: signature is invalid',
    }))).resolves.toBe('refused');
    await expect(probe(answer(401, { message: 'Invalid JWT' }))).resolves.toBe('refused');
  });

  it('concludes nothing from a server error, a rate limit or a gateway failure', async () => {
    await expect(probe(answer(500, { code: 500, msg: 'Database error' }))).resolves.toBe('unknown');
    await expect(probe(answer(429, { code: 429, error_code: 'over_request_rate_limit' }))).resolves.toBe('unknown');
    await expect(probe(answer(502))).resolves.toBe('unknown');
    await expect(probe(answer(503))).resolves.toBe('unknown');
  });

  it('concludes nothing from a network failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });

    await expect(probe(fetcher)).resolves.toBe('unknown');
  });

  it('aborts a request Supabase does not answer, rather than waiting on it forever', async () => {
    // React Native's Android HTTP client has no timeout of its own.
    let aborted = false;
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));

    await expect(probe(fetcher, 10)).resolves.toBe('unknown');
    expect(aborted).toBe(true);
  });

  it('treats a refusal with an unreadable body as a plain refusal', async () => {
    const fetcher = vi.fn(async () => new Response('<html>denied</html>', { status: 403 }));

    await expect(probe(fetcher)).resolves.toBe('refused');
  });
});
