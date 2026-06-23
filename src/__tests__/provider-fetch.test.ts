import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const projectRoot = process.cwd();
const providerFetchProductionRoots = [
  join(projectRoot, 'src/app/api'),
  join(projectRoot, 'src/lib'),
];

function listSourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .flatMap((entry) => {
      const fullPath = join(root, entry);
      if (statSync(fullPath).isDirectory()) {
        return listSourceFiles(fullPath);
      }

      return fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') ? [fullPath] : [];
    });
}

function findProviderFetchCallsMissingServiceName() {
  const missing: string[] = [];

  for (const filePath of providerFetchProductionRoots.flatMap(listSourceFiles)) {
    const source = readFileSync(filePath, 'utf8');
    if (!source.includes('fetchWithProviderTimeout')) {
      continue;
    }

    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'fetchWithProviderTimeout'
        && node.arguments.length < 5
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        missing.push(`${relative(projectRoot, filePath)}:${line + 1}:${character + 1}`);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return missing.sort();
}

describe('provider fetch', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/provider-dependency-telemetry');
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('preserves an existing request signal instead of replacing it with a timeout signal', async () => {
    const { fetchWithProviderTimeout } = await import('@/lib/provider-fetch');
    const callerSignal = AbortSignal.abort();
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return { ok: true } as Response;
    }));

    await fetchWithProviderTimeout('https://provider.example.com/task', {
      method: 'POST',
      signal: callerSignal,
    }, 30_000);

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(requestInit?.signal).toBe(callerSignal);
  });

  it('applies timeout signals to injected fetch implementations', async () => {
    const { fetchWithProviderTimeout } = await import('@/lib/provider-fetch');
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const globalFetcher = vi.fn(async () => ({ ok: true }) as Response);
    const injectedFetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', globalFetcher);

    await fetchWithProviderTimeout(
      'https://provider.example.com/task',
      { method: 'POST' },
      30_000,
      injectedFetcher as unknown as typeof fetch
    );

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(injectedFetcher).toHaveBeenCalledWith('https://provider.example.com/task', expect.objectContaining({
      method: 'POST',
      signal: timeoutSignal,
    }));
    expect(globalFetcher).not.toHaveBeenCalled();
  });

  it('normalizes wrapper-created timeout aborts into typed external timeout errors', async () => {
    const { fetchWithProviderTimeout } = await import('@/lib/provider-fetch');
    const timeoutSignal = AbortSignal.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    await expect(fetchWithProviderTimeout(
      'https://provider.example.com/task',
      { method: 'POST' },
      30_000,
      fetcher as unknown as typeof fetch,
      'KIE'
    )).rejects.toMatchObject({
      name: 'ExternalServiceTimeoutError',
      serviceName: 'KIE',
      timeoutMs: 30_000,
      message: 'KIE request timed out after 30000ms.',
    });
    expect(warnSpy).toHaveBeenCalledWith('[provider-fetch]', expect.objectContaining({
      serviceName: 'KIE',
      outcome: 'timeout',
      timeoutMs: 30_000,
      method: 'POST',
      host: 'provider.example.com',
    }));
  });

  it('names every production provider timeout boundary for actionable logs', () => {
    expect(findProviderFetchCallsMissingServiceName()).toEqual([]);
  });

  it('emits structured provider telemetry for failed HTTP responses', async () => {
    const { fetchWithProviderTimeout } = await import('@/lib/provider-fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'bad gateway' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }));

    const response = await fetchWithProviderTimeout(
      'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-123',
      { method: 'GET' },
      10_000,
      fetcher as unknown as typeof fetch,
      'KIE task status'
    );

    expect(response.status).toBe(502);
    expect(warnSpy).toHaveBeenCalledWith('[provider-fetch]', expect.objectContaining({
      type: 'provider_fetch',
      serviceName: 'KIE task status',
      outcome: 'http_error',
      status: 502,
      ok: false,
      host: 'api.kie.ai',
      method: 'GET',
      timeoutMs: 10_000,
      providerTaskId: 'task-123',
      durationMs: expect.any(Number),
    }));
  });

  it('records durable provider telemetry for failed HTTP responses', async () => {
    const recordProviderDependencyEvent = vi.fn(async () => undefined);
    vi.doMock('@/lib/provider-dependency-telemetry', () => ({
      recordProviderDependencyEvent,
    }));
    const { fetchWithProviderTimeout } = await import('@/lib/provider-fetch');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'bad gateway' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }));

    await fetchWithProviderTimeout(
      'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-durable-1',
      { method: 'GET' },
      10_000,
      fetcher as unknown as typeof fetch,
      'KIE task status'
    );

    expect(recordProviderDependencyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'provider_fetch',
      serviceName: 'KIE task status',
      outcome: 'http_error',
      status: 502,
      ok: false,
      host: 'api.kie.ai',
      method: 'GET',
      timeoutMs: 10_000,
      providerTaskId: 'task-durable-1',
      durationMs: expect.any(Number),
    }));
  });

  it('includes active API request ids in telemetry without sending them to providers', async () => {
    const { withRequestTrace } = await import('@/lib/request-trace');
    const { fetchWithProviderTimeout } = await import('@/lib/provider-fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-request-id')).toBeNull();
      return new Response('{}', { status: 503 });
    });

    await withRequestTrace({ requestId: 'api-route-req-1' }, () => fetchWithProviderTimeout(
      'https://provider.example.com/status?taskId=task-456',
      { headers: { Accept: 'application/json' } },
      10_000,
      fetcher as unknown as typeof fetch,
      'Provider status'
    ));

    expect(warnSpy).toHaveBeenCalledWith('[provider-fetch]', expect.objectContaining({
      serviceName: 'Provider status',
      outcome: 'http_error',
      requestId: 'api-route-req-1',
      providerTaskId: 'task-456',
    }));
  });

  it('warns for slow provider successes without warning for fast successes', async () => {
    const { fetchWithProviderTimeout, PROVIDER_SLOW_FETCH_WARNING_MS } = await import('@/lib/provider-fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(PROVIDER_SLOW_FETCH_WARNING_MS - 1)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(PROVIDER_SLOW_FETCH_WARNING_MS + 1);
    const fetcher = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await fetchWithProviderTimeout(
      'https://provider.example.com/fast',
      { method: 'POST' },
      30_000,
      fetcher as unknown as typeof fetch,
      'Fast provider'
    );
    expect(warnSpy).not.toHaveBeenCalled();

    await fetchWithProviderTimeout(
      'https://provider.example.com/slow',
      { method: 'POST' },
      30_000,
      fetcher as unknown as typeof fetch,
      'Slow provider'
    );
    expect(warnSpy).toHaveBeenCalledWith('[provider-fetch]', expect.objectContaining({
      serviceName: 'Slow provider',
      outcome: 'success',
      status: 200,
      durationMs: PROVIDER_SLOW_FETCH_WARNING_MS + 1,
    }));
    expect(nowSpy).toHaveBeenCalledTimes(4);
  });

  it('rejects external service promises after the configured timeout', async () => {
    vi.useFakeTimers();
    const { withExternalServiceTimeout } = await import('@/lib/provider-fetch');

    const result = withExternalServiceTimeout(new Promise(() => undefined), 5_000, 'Razorpay');
    const expectation = expect(result).rejects.toMatchObject({
      name: 'ExternalServiceTimeoutError',
      message: 'Razorpay request timed out after 5000ms.',
      serviceName: 'Razorpay',
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
  });
});
