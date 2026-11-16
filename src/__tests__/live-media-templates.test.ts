import { describe, expect, it, vi } from 'vitest';

import { hasLiveMediaTemplates } from '@/lib/live-media-templates';
import { listActiveMediaTemplatesPage } from '@/lib/media-template-service';

/**
 * The creators' ways into /templates (the Templates tile beside Enhance and "Browse templates"
 * under "Start from a post") are drawn only while the catalog lists a template: the web sweep of
 * 2026-11-17 followed them to "No templates are live yet". The question is the catalog's own.
 */

type Call = [method: string, ...args: unknown[]];

/** A Supabase client whose every read records what it was asked, per table, and answers `answer`. */
function recordingClient(answer: { data: unknown[] | null; error: unknown }) {
  const calls: Record<string, Call[]> = {};
  const from = vi.fn((table: string) => {
    const tableCalls = (calls[table] ??= []);
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'not', 'in', 'order', 'limit', 'or']) {
      query[method] = (...args: unknown[]) => {
        tableCalls.push([method, ...args]);
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(answer).then(resolve, reject);
    return query;
  });
  return { client: { from } as never, from, calls };
}

const isFilter = ([method]: Call) => method === 'eq' || method === 'not';

describe('whether a template is live', () => {
  it('asks for one template the public catalog would list', async () => {
    const { client, from, calls } = recordingClient({ data: [{ id: 'template-1' }], error: null });

    await expect(hasLiveMediaTemplates(client)).resolves.toBe(true);

    expect(from).toHaveBeenCalledTimes(1);
    expect(calls.templates).toEqual([
      ['select', 'id'],
      ['eq', 'status', 'active'],
      ['eq', 'is_active', true],
      ['not', 'active_version_id', 'is', null],
      ['not', 'creator_user_id', 'is', null],
      ['limit', 1],
    ]);
  });

  it('answers no for an empty catalog', async () => {
    await expect(hasLiveMediaTemplates(recordingClient({ data: [], error: null }).client)).resolves.toBe(false);
    await expect(hasLiveMediaTemplates(recordingClient({ data: null, error: null }).client)).resolves.toBe(false);
  });

  // A failed read says nothing about the catalog: thrown, the creators' data cache never keeps it.
  it('throws a failed read rather than answering no', async () => {
    const failure = { message: 'connection refused' };
    await expect(hasLiveMediaTemplates(recordingClient({ data: null, error: failure }).client)).rejects.toBe(failure);
  });

  // The tile must never be drawn for a template the catalog leaves out, or hidden for one it lists.
  it('filters templates exactly as the catalog page lists them', async () => {
    const flag = recordingClient({ data: [], error: null });
    const catalog = recordingClient({ data: [], error: null });

    await hasLiveMediaTemplates(flag.client);
    await listActiveMediaTemplatesPage(catalog.client);

    expect(flag.calls.templates.filter(isFilter)).toEqual(catalog.calls.templates.filter(isFilter));
  });
});
