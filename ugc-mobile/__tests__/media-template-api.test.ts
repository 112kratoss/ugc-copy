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

  it('reads a template with the session only when asked, and keeps that answer for no one', async () => {
    const getAccessToken = vi.fn(async () => 'token-1');
    const fetcher = vi.fn(async () => jsonResponse({
      template: { id: 'template-1', slug: 'rider', name: 'Rider', status: 'draft', inputSlots: [], outputKind: 'image' },
    }));
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken, fetcher: fetcher as unknown as typeof fetch });

    await expect(api.getMediaTemplate('rider', { withSession: true })).resolves.toMatchObject({ template: { status: 'draft' } });
    await api.getMediaTemplate('rider', { withSession: true });
    // The owner's read goes to the server each time, with the token…
    expect(fetcher).toHaveBeenCalledTimes(2);
    // …and a public read after it is not answered with the owner's copy.
    await api.getMediaTemplate('rider');
    expect(fetcher).toHaveBeenCalledTimes(3);

    const calls = fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(calls.map(([, init]) => (init.headers as Headers).get('Authorization'))).toEqual(['Bearer token-1', 'Bearer token-1', null]);
  });

  it('reads the catalog and a template past the five-minute copy when asked, and keeps the new answer', async () => {
    let reads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      reads += 1;
      const item = { id: 'template-1', slug: 'rider', name: `Rider ${reads}`, inputSlots: [], outputKind: 'image' };
      return jsonResponse(String(input).endsWith('/api/templates') ? { templates: [item] } : { template: item });
    });
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken: async () => null, fetcher: fetcher as unknown as typeof fetch });

    await api.listMediaTemplates();
    await expect(api.listMediaTemplates()).resolves.toMatchObject({ templates: [{ name: 'Rider 1' }] });
    await expect(api.listMediaTemplates(undefined, { fresh: true })).resolves.toMatchObject({ templates: [{ name: 'Rider 2' }] });
    await expect(api.listMediaTemplates()).resolves.toMatchObject({ templates: [{ name: 'Rider 2' }] });

    await api.getMediaTemplate('rider');
    await expect(api.getMediaTemplate('rider', { fresh: true })).resolves.toMatchObject({ template: { name: 'Rider 4' } });
    await expect(api.getMediaTemplate('rider')).resolves.toMatchObject({ template: { name: 'Rider 4' } });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reports a template by its id and reason, and leaves the surface to the server (01-3)', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true }));
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token-1', fetcher: fetcher as unknown as typeof fetch });

    await api.reportTemplate('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', { reason: 'stolen_content', details: 'Reported from the mobile template page.' });

    const [[url, init]] = fetcher.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(String(url)).toBe('https://magicbooklet.test/api/moderation/reports');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      targetType: 'template',
      targetId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      reason: 'stolen_content',
      details: 'Reported from the mobile template page.',
    });
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });
});

