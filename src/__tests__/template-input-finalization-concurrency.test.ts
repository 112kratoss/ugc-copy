import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeTemplateRunInputs } from '@/lib/template-run-service';

const mocks = vi.hoisted(() => ({ abort: vi.fn(), complete: vi.fn() }));
vi.mock('@/lib/template-input-preflight', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/template-input-preflight')>(),
  validateTemplateInputBlob: async () => undefined,
}));
vi.mock('@/lib/upload-byte-admission', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/upload-byte-admission')>(),
  abortNullableUploadByteConsumption: (...args: unknown[]) => mocks.abort(...args),
  completeUploadByteConsumptions: (...args: unknown[]) => mocks.complete(...args),
}));
vi.mock('@/lib/upload-finalization', () => ({
  finalizeUploadForConsumption: async (_client: unknown, input: { storagePath: string }) => ({
    ok: true, consumptionClaim: { uploadId: input.storagePath, leaseId: randomUUID() },
  }),
  deleteReservedObjectAndConfirm: async (client: SupabaseClient, bucket: string, key: string) => {
    const result = await client.storage.from(bucket).remove([key]);
    return !result.error;
  },
}));
vi.mock('@/lib/template-run-media-delivery', () => ({
  resolveTemplateRunMedia: async ({ outputs }: { outputs: unknown[] }) => outputs.map(() => ({ url: null })),
}));

type Row = Record<string, unknown>;
function fixture() {
  const userId = randomUUID(), runId = randomUUID();
  const slots = ['portrait', 'scene'];
  const objects = new Map<string, Blob>();
  const initial = Object.fromEntries(slots.map(key => {
    const path = `${userId}/${runId}/final/${key}/initial.png`;
    objects.set(path, new Blob(['initial']));
    return [key, `template_inputs/${path}`];
  }));
  const run: Row = {
    id: runId, user_id: userId, status: 'collecting_inputs', input_storage_paths: initial,
    input_manifest: slots.map(key => ({ key, kind: 'image', label: key })),
    graph_snapshot: { graph: { nodes: [], edges: [] }, templateTitle: 'Input test' },
    estimated_total_credits: 0, estimated_remaining_credits: 0,
  };
  const controls: { beforeCommit?: () => Promise<void>; rejection?: Row; loseReply?: boolean } = {};
  const client = {
    from(table: string) {
      let patch: Row | null = null;
      const filters: Array<[string, unknown]> = [];
      const matches = () => filters.every(([key, value]) => (
        isDeepStrictEqual(run[key], key === 'input_storage_paths' ? JSON.parse(value as string) : value)
      ));
      const answer = async (single: boolean) => {
        if (table !== 'template_runs') return { data: [], error: null };
        if (patch) {
          await controls.beforeCommit?.();
          if (controls.rejection) return { data: null, error: controls.rejection, status: 400 };
          if (!matches()) return { data: null, error: null, status: 200 };
          Object.assign(run, structuredClone(patch));
          if (controls.loseReply) return { data: null, error: { message: 'Gateway timeout', code: '' }, status: 504 };
        }
        const row = matches() || patch ? structuredClone(run) : null;
        return { data: single ? row : row ? [row] : [], error: null, status: 200 };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        order: () => query,
        update: (value: Row) => { patch = value; return query; },
        maybeSingle: () => answer(true),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => answer(false).then(resolve, reject),
      };
      return query;
    },
    storage: { from: () => ({
      download: async (key: string) => ({ data: objects.get(key) ?? null, error: objects.has(key) ? null : { message: 'Not found' } }),
      upload: async (key: string, blob: Blob) => { objects.set(key, blob); return { error: null }; },
      remove: async (keys: string[]) => { keys.forEach(key => objects.delete(key)); return { error: null }; },
    }) },
  } as unknown as SupabaseClient;
  const staging = (slot: string) => {
    const path = `${userId}/${runId}/staging/${slot}/${randomUUID()}.png`;
    objects.set(path, new Blob(['replacement']));
    return `template_inputs/${path}`;
  };
  const finalize = (slot: string, storagePath: string) => finalizeTemplateRunInputs({
    client, userId, runId, body: { inputs: [{ slotKey: slot, storagePath }] },
  });
  const finalObjects = () => [...objects.keys()].filter(key => key.includes('/final/')).sort();
  const referencedObjects = () => Object.values(run.input_storage_paths as Record<string, string>).map(value => value.slice('template_inputs/'.length)).sort();
  return { run, initial, controls, objects, staging, finalize, finalObjects, referencedObjects };
}

describe('template input finalization commit conflicts', () => {
  beforeEach(() => { mocks.abort.mockReset(); mocks.complete.mockReset().mockResolvedValue({ ok: true }); });
  it.each(['portrait', 'scene'])('does not overwrite concurrent input state when the second request changes %s', async secondSlot => {
    const f = fixture();
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    f.controls.beforeCommit = async () => { if (++arrivals === 2) release(); await ready; };
    const firstPath = f.staging('portrait'), secondPath = f.staging(secondSlot);
    const results = await Promise.allSettled([f.finalize('portrait', firstPath), f.finalize(secondSlot, secondPath)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(result => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: 'TEMPLATE_INPUT_CONFLICT' });
    expect(f.finalObjects()).toEqual(f.referencedObjects());
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    // The rejected request's staging source is still present and can be retried
    // against the newly loaded input set, including unrelated slot changes.
    const loser = results[0].status === 'rejected' ? ['portrait', firstPath] : [secondSlot, secondPath];
    f.controls.beforeCommit = undefined;
    await f.finalize(loser[0], loser[1]);
    expect(f.finalObjects()).toEqual(f.referencedObjects());
  });
  it('removes the prepared copy if the run starts before inputs can be committed', async () => {
    const f = fixture();
    f.controls.beforeCommit = async () => { f.run.status = 'queued'; };
    await expect(f.finalize('portrait', f.staging('portrait'))).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_INPUT_CONFLICT' });
    expect(f.run.input_storage_paths).toEqual(f.initial);
    expect(f.finalObjects()).toEqual(f.referencedObjects());
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('cleans its prepared copy and claim after a definitive database rejection', async () => {
    const f = fixture();
    f.controls.rejection = { code: '23514', message: 'Rejected by a constraint' };
    await expect(f.finalize('portrait', f.staging('portrait'))).rejects.toMatchObject({ code: '23514' });
    expect(f.run.input_storage_paths).toEqual(f.initial);
    expect(f.finalObjects()).toEqual(f.referencedObjects());
    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });
  it('preserves the committed copy when the database acknowledgement is lost', async () => {
    const f = fixture();
    f.controls.loseReply = true;
    await expect(f.finalize('portrait', f.staging('portrait'))).rejects.toMatchObject({ message: 'Gateway timeout' });
    expect(f.run.input_storage_paths).not.toEqual(f.initial);
    for (const key of f.referencedObjects()) expect(f.objects.has(key)).toBe(true);
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
