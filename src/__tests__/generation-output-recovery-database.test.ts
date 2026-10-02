import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ fetch: vi.fn(), stage: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/mobile-notifications', () => ({ notifyGenerationStatus: (...args: unknown[]) => provider.notify(...args) }));
vi.mock('@/lib/staged-remote-media', () => ({ stageAllowlistedRemoteMedia: (...args: unknown[]) => provider.stage(...args) }));
vi.mock('@/lib/generation-video-preview', () => ({ createGenerationVideoPosterFromFile: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/generation-media-preview', () => ({ createGenerationImagePreviewFromFile: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/provider-fetch', async (original) => ({
  ...await original<typeof import('@/lib/provider-fetch')>(),
  fetchWithProviderRetry: (...args: unknown[]) => provider.fetch(...args),
}));
vi.mock('@/lib/completed-remix-notification', () => ({ notifyCompletedRemix: vi.fn() }));

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('generation output recovery with real queue and settlement SQL', () => {
  let db: Client;
  let userId: string;
  let generationId: string;
  let predictionId: string;
  let client: SupabaseClient;
  let temporaryDirectory: string;
  let upload: ReturnType<typeof vi.fn<
    (path: string, stream: AsyncIterable<Uint8Array>) => Promise<{ error: Error | null }>
  >>;

  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('KIE_AI_API_KEY', 'local-test-key');
    vi.resetModules();
    provider.fetch.mockReset();
    provider.notify.mockReset().mockResolvedValue(null);
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'generation-import-audit-'));
    const path = join(temporaryDirectory, 'output.png');
    await writeFile(path, 'synthetic-media-bytes');
    provider.stage.mockReset().mockImplementation(async () => ({
      filePath: path, sourceName: 'output.png', contentType: 'image/png', cleanup: async () => {},
    }));
    upload = vi.fn(async (_path: string, stream: AsyncIterable<Uint8Array>) => {
      for await (const chunk of stream) expect(chunk.byteLength).toBeGreaterThan(0);
      return { error: null as Error | null };
    });
    db = new Client({ connectionString });
    await db.connect();
    await db.query('begin');
    await db.query("set local statement_timeout='10s'");
    userId = randomUUID(); generationId = randomUUID(); predictionId = `audit-output-${randomUUID()}`;
    await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [userId, `${userId}@example.invalid`]);
    await db.query('update public.profiles set credits=500 where id=$1', [userId]);
    await db.query('set local role service_role');
    client = {
      storage: { from: () => ({ upload }) },
      from(table: string) {
        if (table === 'profiles') return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
        if (table !== 'generations') throw new Error(`Unexpected table ${table}`);
        let key = ''; let value: unknown;
        const query = {
          select: () => query,
          in: () => query,
          eq: (column: string, next: unknown) => { key = column; value = next; return query; },
          single: async () => {
            if (!['prediction_id', 'id'].includes(key)) throw new Error('Unexpected filter');
            const { rows } = await db.query(`select * from public.generations where ${key}=$1`, [value]);
            return { data: rows[0] ?? null, error: null };
          },
          maybeSingle: () => query.single(),
        };
        return query;
      },
      async rpc(name: string, args: Record<string, unknown>) {
        if (!['enqueue_generation_completion_job', 'claim_generation_completion_jobs', 'finish_generation_completion_job',
          'enqueue_generation_output_import_job', 'claim_generation_output_import_jobs', 'finish_generation_output_import_job', 'settle_generation_succeeded', 'settle_generation_failed'].includes(name)) {
          throw new Error(`Unexpected RPC ${name}`);
        }
        const keys = Object.keys(args);
        if (!keys.every(key => /^p_[a-z_]+$/.test(key))) throw new Error('Unexpected argument');
        const call = `public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')})`;
        const setof = name === 'claim_generation_completion_jobs' || name === 'claim_generation_output_import_jobs';
        const { rows } = await db.query(setof ? `select * from ${call}` : `select ${call} result`,
          Object.values(args).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value));
        return { data: setof ? rows : rows[0].result, error: null };
      },
    } as unknown as SupabaseClient;
  });
  afterEach(async () => {
    try { await db?.query('rollback'); } finally { await db?.end(); if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });

  async function seed(veo: boolean) {
    await db.query(`insert into public.generations(id,user_id,prediction_id,status,cost,category,model,prompt,refunded)
      values($1,$2,$3,'processing',120,$4,$5,'local output recovery fixture',false)`,
    [generationId, userId, predictionId, veo ? 'video' : 'image', veo ? 'veo3' : 'nano-banana-pro']);
  }
  function payload(veo: boolean, urls: string[], malformed = false) {
    return { data: veo
      ? { taskId: predictionId, successFlag: 1, response: { resultUrls: urls } }
      : { taskId: predictionId, state: 'success', resultJson: malformed ? '{broken' : JSON.stringify({ resultUrls: urls }) } };
  }
  async function state() {
    return (await db.query(`select status,output_url,refunded,
      (select credits from public.profiles where id=$2) credits,
      (select status from public.generation_completion_jobs where prediction_id=$3) job_status,
      (select count(*)::int from public.generation_output_import_jobs where generation_id=$1) imports
      from public.generations where id=$1`, [generationId, userId, predictionId])).rows[0];
  }
  async function process() {
    const { processGenerationCompletionJobs } = await import('@/lib/generation-completion-jobs');
    return processGenerationCompletionJobs({ supabase: client, creditSupabase: client, lockedBy: 'output-recovery-test', limit: 1, predictionId });
  }
  async function enqueue(body: Record<string, unknown>) {
    await client.rpc('enqueue_generation_completion_job', { p_prediction_id: predictionId, p_payload: body });
  }

  for (const veo of [false, true]) {
    const kind = veo ? 'Veo' : 'market';
    it(`${kind}: retries an incomplete success and accepts a later complete callback`, async () => {
      await seed(veo);
      provider.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 200, ...payload(veo, []) }), { status: 200 }));
      await enqueue(payload(veo, []));
      expect(await process()).toMatchObject({ completed: 0, retried: 1 });
      expect(await state()).toMatchObject({ status: 'processing', output_url: null, refunded: false, credits: 500, job_status: 'pending', imports: 0 });
      await enqueue(payload(veo, ['https://provider.invalid/output.mp4']));
      expect(await process()).toMatchObject({ completed: 1, retried: 0 });
      expect(await state()).toMatchObject({ status: 'processing', output_url: null, refunded: false, credits: 500, job_status: 'succeeded', imports: 1 });
    });
    it(`${kind}: polls fresh output when the saved callback remains incomplete`, async () => {
      await seed(veo);
      provider.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 200, ...payload(veo, ['https://provider.invalid/recovered.mp4']) }), { status: 200 }));
      await enqueue(payload(veo, [], true));
      expect(await process()).toMatchObject({ completed: 1 });
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      expect(await state()).toMatchObject({ status: 'processing', output_url: null, refunded: false, credits: 500, imports: 1 });
    });
    it(`${kind}: exhausted incomplete results use the existing single-refund policy`, async () => {
      await seed(veo);
      provider.fetch.mockImplementation(async () => new Response(JSON.stringify({ code: 200, ...payload(veo, []) }), { status: 200 }));
      await enqueue(payload(veo, []));
      await db.query('update public.generation_completion_jobs set attempt_count=4 where prediction_id=$1', [predictionId]);
      expect(await process()).toMatchObject({ failed: 1, completed: 0 });
      expect(await state()).toMatchObject({ status: 'failed', output_url: null, refunded: true, credits: 620, job_status: 'failed', imports: 0 });
      expect(await process()).toMatchObject({ claimed: 0 });
      expect(await state()).toMatchObject({ credits: 620 });
      // Whoever started the render is told it was given up on, once.
      expect(provider.notify).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({ id: generationId, user_id: userId }), 'failed');
    });
    it(`${kind}: a reported failure refunds once and tells the creator once, however often it is redelivered`, async () => {
      await seed(veo);
      const failed = { data: veo
        ? { taskId: predictionId, successFlag: 3, errorMessage: 'provider failure' }
        : { taskId: predictionId, state: 'fail', failMsg: 'provider failure' } };
      await enqueue(failed);
      expect(await process()).toMatchObject({ completed: 1, failed: 0 });
      expect(await state()).toMatchObject({ status: 'failed', output_url: null, refunded: true, credits: 620, job_status: 'succeeded', imports: 0 });
      await enqueue(failed);
      await process();
      expect(await state()).toMatchObject({ status: 'failed', refunded: true, credits: 620 });
      // The callback carried the verdict, so the provider was never asked.
      expect(provider.fetch).not.toHaveBeenCalled();
      expect(provider.notify).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({ id: generationId, user_id: userId }), 'failed');
    });
    it(`${kind}: polling cannot settle a success without output`, async () => {
      await seed(veo);
      provider.fetch.mockResolvedValue(new Response(JSON.stringify({ code: 200, ...payload(veo, [], true) }), { status: 200 }));
      const { syncGenerationStatusByPredictionId } = await import('@/lib/generation-status-sync');
      await expect(syncGenerationStatusByPredictionId({ supabase: client, creditSupabase: client, predictionId })).rejects.toThrow(/output/i);
      expect(await state()).toMatchObject({ status: 'processing', output_url: null, refunded: false, credits: 500, imports: 0 });
    });
  }

  it('retries a partially uploaded output list before settling the generation', async () => {
    await seed(false);
    await db.query("update public.generations set model='grok-imagine-image' where id=$1", [generationId]);
    await client.rpc('enqueue_generation_output_import_job', {
      p_generation_id: generationId,
      p_output_urls: ['https://provider.invalid/a.png', 'https://provider.invalid/b.png'],
    });
    const normalUpload = upload.getMockImplementation()!;
    upload.mockImplementation(async (path: string, stream: AsyncIterable<Uint8Array>) => {
      const result = await normalUpload(path, stream);
      return path.includes('_1.png') ? { error: new Error('synthetic storage outage') } : result;
    });
    const { processGenerationOutputImportJobs } = await import('@/lib/generation-output-import-jobs-processor');
    expect(await processGenerationOutputImportJobs({ client, lockedBy: 'partial-import', limit: 1 }))
      .toEqual({ claimed: 1, completed: 0, retried: 1, exhausted: 0 });
    expect(await state()).toMatchObject({ status: 'processing', output_url: null, credits: 500, refunded: false });
    expect((await db.query('select status,attempt_count from public.generation_output_import_jobs where generation_id=$1', [generationId])).rows[0])
      .toEqual({ status: 'pending', attempt_count: 1 });
    upload.mockImplementation(normalUpload);
    await db.query('update public.generation_output_import_jobs set next_attempt_at=now() where generation_id=$1', [generationId]);
    expect(await processGenerationOutputImportJobs({ client, lockedBy: 'retry-import', limit: 1 }))
      .toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });
    expect(await state()).toMatchObject({ status: 'succeeded', credits: 500, refunded: false });
    const row = (await db.query('select workflow_settings from public.generations where id=$1', [generationId])).rows[0];
    expect(row.workflow_settings.outputs).toHaveLength(2);
    expect(upload).toHaveBeenCalledTimes(4);
  });

  it('recovers a lost settlement response without uploading or charging twice', async () => {
    await seed(false);
    await client.rpc('enqueue_generation_output_import_job', { p_generation_id: generationId, p_output_urls: ['https://provider.invalid/a.png'] });
    const rpc = client.rpc.bind(client);
    let lostResponse = false;
    const interrupted = {
      ...client,
      async rpc(name: string, args: Record<string, unknown>) {
        const result = await rpc(name, args);
        if (name === 'settle_generation_succeeded' && !lostResponse) {
          lostResponse = true;
          return { data: null, error: new Error('synthetic response lost after commit') };
        }
        return result;
      },
    } as unknown as SupabaseClient;
    const { processGenerationOutputImportJobs } = await import('@/lib/generation-output-import-jobs-processor');
    expect(await processGenerationOutputImportJobs({ client: interrupted, lockedBy: 'lost-response', limit: 1 }))
      .toMatchObject({ retried: 1, completed: 0 });
    expect(await state()).toMatchObject({ status: 'succeeded', credits: 500, refunded: false });
    await db.query('update public.generation_output_import_jobs set next_attempt_at=now() where generation_id=$1', [generationId]);
    expect(await processGenerationOutputImportJobs({ client, lockedBy: 'recovery', limit: 1 }))
      .toMatchObject({ completed: 1, retried: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect((await db.query('select status from public.generation_output_import_jobs where generation_id=$1', [generationId])).rows[0].status)
      .toBe('succeeded');
  });

  for (const kind of ['video', 'motion', 'veo'] as const) {
    for (const failure of ['download', 'upload'] as const) {
      it(`${kind}: queues status output and recovers a ${failure} outage before settlement`, async () => {
        await seed(true);
        await db.query('update public.generations set model=$2,creation_mode=$3,workflow_settings=$4 where id=$1',
          [generationId, kind === 'motion' ? 'kling-2.6/motion-control' : kind === 'veo' ? 'veo3' : 'kling-3.0-video',
            kind === 'motion' ? 'motion' : null, kind === 'veo' ? { model: 'veo-3.1' } : null]);
        const temporaryUrl = 'https://provider.invalid/temporary.mp4';
        const fetch = vi.fn(async (url: unknown) => String(url).startsWith('https://api.kie.ai/')
          ? new Response(JSON.stringify({ code: 200, ...payload(kind === 'veo', [temporaryUrl]) }))
          : new Response('synthetic media outage', { status: 503 }));
        const { getVideoGenerationStatusForRoute } = await import('@/lib/video-generation-status-service');
        const { getMotionGenerationStatusForRoute } = await import('@/lib/motion-generation-status-service');
        const run = kind === 'motion' ? getMotionGenerationStatusForRoute : getVideoGenerationStatusForRoute;
        const notify = vi.fn();
        const poll = () => run({ request: new Request('http://localhost/api/status'), predictionId, userId,
          supabase: client, createAdminSupabase: () => client, kieApiKey: 'local-test-key',
          dependencies: {
            fetchWithProviderTimeout: fetch,
            withBackendJobLock: async (_client, _options, task) => ({ acquired: true, value: await task() }),
            tryAcquireGenerationProviderStatusThrottle: async () => true,
            notifyGenerationStatus: notify,
          },
        });
        const contract = kind === 'motion' ? mobileApiContract.endpoints.getMotionGeneration : mobileApiContract.endpoints.getVideoGeneration;
        const { getGenerationRouteResponse } = await import('@/lib/generation-route-adapter-service');
        const response = await getGenerationRouteResponse({
          request: new Request('http://localhost/api/status'),
          getGenerationForRoute: poll,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject(contract.responseVariants.importPending);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(upload).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(await state()).toMatchObject({ status: 'processing', output_url: null, credits: 500, refunded: false, imports: 1 });
        expect(provider.notify).not.toHaveBeenCalled();
        const stage = async () => ({ filePath: join(temporaryDirectory, 'output.png'), sourceName: 'output.mp4', contentType: 'video/mp4', cleanup: async () => {} });
        provider.stage.mockImplementation(stage);
        const normalUpload = upload.getMockImplementation()!;
        if (failure === 'download') provider.stage.mockRejectedValueOnce(new Error('synthetic download outage'));
        else upload.mockImplementationOnce(async (path, stream) => { await normalUpload(path, stream); return { error: new Error('synthetic storage outage') }; });
        const { processGenerationOutputImportJobs } = await import('@/lib/generation-output-import-jobs-processor');
        expect(await processGenerationOutputImportJobs({ client, lockedBy: 'poll-import', limit: 1 })).toMatchObject({ retried: 1, completed: 0 });
        expect(await state()).toMatchObject({ status: 'processing', output_url: null, credits: 500, refunded: false });
        expect(provider.notify).not.toHaveBeenCalled();
        const beforeReplay = (await db.query('select id,attempt_count from public.generation_output_import_jobs where generation_id=$1', [generationId])).rows[0];
        expect(await poll()).toMatchObject({ ok: true, body: contract.responseVariants.importPending });
        expect((await db.query('select id,attempt_count from public.generation_output_import_jobs where generation_id=$1', [generationId])).rows[0]).toEqual(beforeReplay);
        await db.query('update public.generation_output_import_jobs set next_attempt_at=now() where generation_id=$1', [generationId]);
        expect(await processGenerationOutputImportJobs({ client, lockedBy: 'poll-recovery', limit: 1 })).toMatchObject({ retried: 0, completed: 1 });
        expect(await state()).toMatchObject({ status: 'succeeded', output_url: `generated_videos/${userId}/generated_${predictionId}.mp4`, credits: 500, refunded: false, imports: 1 });
        expect(provider.notify).toHaveBeenCalledExactlyOnceWith(client, expect.objectContaining({ id: generationId, user_id: userId }), 'succeeded');
      });
    }
  }

});
