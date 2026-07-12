import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../lib/api-client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('mobile media template API', () => {
  it('loads public template catalog and detail without requiring auth', async () => {
    const getAccessToken = vi.fn(async () => 'token-1');
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/templates')) {
        return jsonResponse({ templates: [{ id: 'template-1', slug: 'rider', name: 'Rider', inputSlots: [], outputKind: 'image' }] });
      }
      return jsonResponse({ template: { id: 'template-1', slug: 'rider', name: 'Rider', inputSlots: [], outputKind: 'image' } });
    });
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken, fetcher: fetcher as unknown as typeof fetch });

    await expect(api.listMediaTemplates()).resolves.toMatchObject({ templates: [{ name: 'Rider', outputKind: 'image' }] });
    await expect(api.getMediaTemplate('rider')).resolves.toMatchObject({ template: { id: 'template-1' } });
    expect(getAccessToken).not.toHaveBeenCalled();
    for (const [, init] of fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>) {
      expect((init.headers as Headers).has('Authorization')).toBe(false);
    }
  });

  it('uses authenticated generic start, step retry, step approval, and resume endpoints', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      run: { id: 'run-1', templateId: 'template-1', status: 'collecting_inputs', inputSlots: [], inputs: [], steps: [], result: null },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.createMediaTemplateRun('template-1', 'run-key');
    await api.finalizeTemplateRunInput('run-1', { inputs: [{ slotKey: 'person', storagePath: 'template_inputs/person.jpg' }] });
    await api.startTemplateRun('run-1', 'start-key');
    await api.retryTemplateRunStep('run-1', 'step-retry', 'retry-key');
    await api.approveTemplateRunStep('run-1', 'step-approval', 'approve-key');
    await api.getTemplateRun('run-1');

    const calls = fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(calls.map(([url]) => String(url))).toEqual([
      'https://magicbooklet.test/api/templates/template-1/runs',
      'https://magicbooklet.test/api/template-runs/run-1/inputs/finalize',
      'https://magicbooklet.test/api/template-runs/run-1/start',
      'https://magicbooklet.test/api/template-runs/run-1/steps/step-retry/retry',
      'https://magicbooklet.test/api/template-runs/run-1/approval-steps/step-approval/approve',
      'https://magicbooklet.test/api/template-runs/run-1',
    ]);
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ inputs: [{ slotKey: 'person', storagePath: 'template_inputs/person.jpg' }] });
    expect(JSON.parse(String(calls[4][1].body))).toEqual({});
    expect((calls[0][1].headers as Headers).get('Idempotency-Key')).toBe('run-key');
    expect((calls[2][1].headers as Headers).get('Idempotency-Key')).toBe('start-key');
    expect((calls[3][1].headers as Headers).get('Idempotency-Key')).toBe('retry-key');
    expect((calls[4][1].headers as Headers).get('Idempotency-Key')).toBe('approve-key');
    for (const [, init] of calls) expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });
});
