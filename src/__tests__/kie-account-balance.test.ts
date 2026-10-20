// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  KIE_ACCOUNT_BALANCE_ENDPOINT,
  KieAccountBalanceError,
  hasConfiguredKieAccountBalanceCheck,
  parseKieAccountBalanceResponse,
  readKieAccountBalance,
} from '@/lib/kie-account-balance';

// Distinctive enough that any leak into an error, a log line or a console
// write is caught by a plain substring search.
const KIE_KEY = 'kie-live-key-7f3a9c41-never-print-me';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', KIE_AI_API_KEY: KIE_KEY, ...overrides };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readError(promise: Promise<unknown>): Promise<KieAccountBalanceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(KieAccountBalanceError);
    return error as KieAccountBalanceError;
  }
  throw new Error('Expected the balance read to fail');
}

describe('parseKieAccountBalanceResponse', () => {
  it('reads the balance from a code 200 answer', () => {
    expect(parseKieAccountBalanceResponse({ code: 200, msg: 'success', data: 845.32 })).toBe(845.32);
    expect(parseKieAccountBalanceResponse({ code: 200, msg: 'success', data: 0 })).toBe(0);
  });

  it('treats any other code as the provider refusing the read', () => {
    const error = (() => {
      try {
        parseKieAccountBalanceResponse({ code: 401, msg: 'You do not have access permissions', data: null });
      } catch (caught) {
        return caught as KieAccountBalanceError;
      }
      throw new Error('Expected a refusal');
    })();

    expect(error).toBeInstanceOf(KieAccountBalanceError);
    expect(error.reason).toBe('provider_error');
    expect(error.providerCode).toBe(401);
    expect(error.message).toContain('401');
  });

  it.each([
    ['no body', null],
    ['an array', [200, 845.32]],
    ['a string', 'credits: 845.32'],
    ['a code that is not a number', { code: '200', msg: 'success', data: 845.32 }],
    ['a balance sent as a string', { code: 200, msg: 'success', data: '845.32' }],
    ['a balance that is not finite', { code: 200, msg: 'success', data: Number.POSITIVE_INFINITY }],
    ['no balance at all', { code: 200, msg: 'success' }],
    ['a balance without a code', { msg: 'success', data: 845.32 }],
  ])('refuses %s as a malformed answer', (_name, body) => {
    expect(() => parseKieAccountBalanceResponse(body)).toThrow(KieAccountBalanceError);
    try {
      parseKieAccountBalanceResponse(body);
    } catch (error) {
      expect((error as KieAccountBalanceError).reason).toBe('malformed_body');
    }
  });
});

describe('readKieAccountBalance', () => {
  let logs: BackendLogRecord[];
  let restoreSink: () => void;
  let consoleOutput: string[];

  beforeEach(() => {
    logs = [];
    restoreSink = setBackendLogSink((record) => logs.push(record));
    consoleOutput = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
  });

  afterEach(() => {
    restoreSink();
    vi.restoreAllMocks();
  });

  function expectNoKeyLeak(...values: unknown[]) {
    const captured = [
      ...values.map((value) => {
        if (value instanceof Error) {
          return `${value.name} ${value.message} ${value.stack ?? ''} ${JSON.stringify({ ...value })}`;
        }
        return typeof value === 'string' ? value : JSON.stringify(value);
      }),
      JSON.stringify(logs),
      ...consoleOutput,
    ].join('\n');
    expect(captured).not.toContain(KIE_KEY);
  }

  it('asks the credit endpoint with the bearer key and returns the balance', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ code: 200, msg: 'success', data: 845.32 }));

    const balance = await readKieAccountBalance({
      environment: env(),
      fetcher,
      now: () => new Date('2026-10-20T06:00:00.000Z'),
    });

    expect(balance).toEqual({ credits: 845.32, checkedAt: '2026-10-20T06:00:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    expect(String(input)).toBe(KIE_ACCOUNT_BALANCE_ENDPOINT);
    expect(KIE_ACCOUNT_BALANCE_ENDPOINT).toBe('https://api.kie.ai/api/v1/chat/credit');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KIE_KEY}`);
    expectNoKeyLeak(balance);
  });

  it('does not call Kie when no key is configured', async () => {
    const fetcher = vi.fn<typeof fetch>();

    const error = await readError(readKieAccountBalance({ environment: env({ KIE_AI_API_KEY: '  ' }), fetcher }));

    expect(error.reason).toBe('not_configured');
    expect(fetcher).not.toHaveBeenCalled();
    expect(hasConfiguredKieAccountBalanceCheck(env({ KIE_AI_API_KEY: '' }))).toBe(false);
    expect(hasConfiguredKieAccountBalanceCheck(env())).toBe(true);
  });

  it('names a code other than 200 as a provider error, with the code but never the key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      code: 401,
      // A provider that echoes the credential back must not get it logged.
      msg: `Invalid API key ${KIE_KEY}`,
      data: null,
    }));

    const error = await readError(readKieAccountBalance({ environment: env(), fetcher }));

    expect(error.reason).toBe('provider_error');
    expect(error.providerCode).toBe(401);
    expect(error.message).toContain('[redacted]');
    expectNoKeyLeak(error);
  });

  it('names an HTTP failure with its status', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('upstream down', { status: 503 }));

    const error = await readError(readKieAccountBalance({ environment: env(), fetcher }));

    expect(error.reason).toBe('http_error');
    expect(error.httpStatus).toBe(503);
    expectNoKeyLeak(error);
  });

  it('names a body that is not JSON as malformed', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>gateway</html>', { status: 200 }));

    const error = await readError(readKieAccountBalance({ environment: env(), fetcher }));

    expect(error.reason).toBe('malformed_body');
    expectNoKeyLeak(error);
  });

  it('gives up after its timeout when Kie never answers', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      });
    }));
    const startedAt = Date.now();

    const error = await readError(readKieAccountBalance({ environment: env(), fetcher, timeoutMs: 30 }));

    expect(error.reason).toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expectNoKeyLeak(error);
  });

  it('gives up after its timeout even when the request ignores the abort signal', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

    const error = await readError(readKieAccountBalance({ environment: env(), fetcher, timeoutMs: 30 }));

    expect(error.reason).toBe('timeout');
    expectNoKeyLeak(error);
  });

  it('names a lost connection as a network error', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });

    const error = await readError(readKieAccountBalance({ environment: env(), fetcher }));

    expect(error.reason).toBe('network_error');
    expectNoKeyLeak(error);
  });
});
