// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { BACKEND_JOBS_BY_NAME } from '@/lib/backend-jobs';
import { sweepRecipeFileCopies } from '@/lib/recipe-copy-sweep';

const PUBLISHER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const CREATION = '33333333-3333-4333-8333-333333333333';
const ROW = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-04T06:50:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const COPY = `${PUBLISHER}/generation-references/${CREATION}/00-reference-${ROW}.png`;
const OTHER_COPY = `${PUBLISHER}/generation-references/${CREATION}/01-reference-other.png`;
const IMPORT = `${BUYER}/recipe-imports/${PUBLISHER}/${CREATION}/00-reference-${ROW}.png`;
const INPUT_PATH = `generation_inputs/${PUBLISHER}/${CREATION}/00-reference.png`;

type Call = { op: string; table?: string; bucket?: string; args: unknown[] };

function candidate(bucketId: string, name: string, ageMs: number) {
  return { bucketId, name, createdAt: new Date(NOW.getTime() - ageMs).toISOString() };
}

/**
 * A Supabase client with the job's two reads, its ledger, the generations read
 * and storage, each recorded in one ordered list of calls.
 */
function createFakeClient(options: {
  candidates?: Record<string, unknown> | null;
  candidatesError?: { message: string } | null;
  namedAgain?: unknown[];
  ledgerUpsertError?: { message: string } | null;
  /** Imports a run start used after the read. */
  usedImports?: string[];
  removeResult?: (bucket: string, names: string[]) => { data: unknown; error: unknown };
  copyError?: unknown;
} = {}) {
  const calls: Call[] = [];

  const table = (name: string) => {
    let op = 'select';
    const args: unknown[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['eq', 'lt', 'in', 'gte']) {
      builder[method] = (...methodArgs: unknown[]) => {
        args.push([method, ...methodArgs]);
        return builder;
      };
    }
    builder.select = (...methodArgs: unknown[]) => {
      args.push(['select', ...methodArgs]);
      return builder;
    };
    builder.delete = (...methodArgs: unknown[]) => {
      op = 'delete';
      args.push(['delete', ...methodArgs]);
      return builder;
    };
    builder.upsert = (rows: unknown, upsertOptions: unknown) => {
      op = 'upsert';
      args.push(rows, upsertOptions);
      return builder;
    };
    builder.then = (resolve: (value: unknown) => unknown) => {
      calls.push({ op: `${name}.${op}`, table: name, args });
      if (op === 'upsert') return resolve({ data: null, error: options.ledgerUpsertError ?? null });
      if (op === 'delete') return resolve({ data: null, error: null, count: 0 });
      return resolve({ data: [], error: null });
    };
    return builder;
  };

  const client = {
    rpc: vi.fn(async (name: string, args: unknown) => {
      calls.push({ op: `rpc.${name}`, args: [args] });
      if (name === 'list_swept_recipe_copies_named_again') {
        return { data: options.namedAgain ?? [], error: null };
      }
      if (name === 'list_recipe_imports_used_since') {
        return { data: options.usedImports ?? [], error: null };
      }
      if (name === 'list_recipe_file_sweep_candidates') {
        return { data: options.candidates ?? null, error: options.candidatesError ?? null };
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
    from: vi.fn((name: string) => table(name)),
    storage: {
      from: (bucket: string) => ({
        remove: vi.fn(async (names: string[]) => {
          calls.push({ op: 'storage.remove', bucket, args: [names] });
          return options.removeResult?.(bucket, names)
            ?? { data: names.map((name) => ({ name })), error: null };
        }),
        copy: vi.fn(async (from: string, to: string, copyOptions: unknown) => {
          calls.push({ op: 'storage.copy', bucket, args: [from, to, copyOptions] });
          return { data: null, error: options.copyError ?? null };
        }),
      }),
    },
  };
  return { client, calls };
}

describe('the recipe-copy-sweep job', () => {
  let logs: BackendLogRecord[];
  let restoreSink: () => void;

  beforeEach(() => {
    logs = [];
    restoreSink = setBackendLogSink((record) => logs.push(record));
  });

  afterEach(() => {
    restoreSink();
    vi.unstubAllEnvs();
  });

  it('is registered on the shared scheduler every six hours', () => {
    expect(BACKEND_JOBS_BY_NAME['recipe-copy-sweep']).toMatchObject({
      route: '/api/cron/recipe-copy-sweep',
      schedule: '50 */6 * * *',
      dispatch: 'scheduler',
      dailyInvocations: 4,
      maxDurationSeconds: 300,
    });
  });

  it('asks the database for files past the grace period, imports of quiet buyers, one batch', async () => {
    const { client, calls } = createFakeClient({ candidates: { examined: 0, candidates: [] } });

    await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    const read = calls.find((call) => call.op === 'rpc.list_recipe_file_sweep_candidates');
    expect(read?.args[0]).toEqual({
      p_created_before: new Date(NOW.getTime() - 7 * DAY).toISOString(),
      p_imports_quiet_since: new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString(),
      p_limit: 200,
      p_scan_limit: 5000,
    });
    // The ledger keeps two weeks of removals, and the import uses a week.
    const prune = calls.find((call) => call.op === 'recipe_file_sweep_deletions.delete');
    expect(prune?.args).toContainEqual(['lt', 'deleted_at', new Date(NOW.getTime() - 14 * DAY).toISOString()]);
    const usesPrune = calls.find((call) => call.op === 'recipe_import_uses.delete');
    expect(usesPrune?.args).toContainEqual(['lt', 'used_at', new Date(NOW.getTime() - 7 * DAY).toISOString()]);
  });

  it('only reports while removal is off, which is the default', async () => {
    vi.stubEnv('RECIPE_COPY_SWEEP_DELETE', '');
    const { client, calls } = createFakeClient({
      candidates: {
        examined: 5,
        tooRecent: 1,
        named: 1,
        importsInUse: 0,
        unnamed: 3,
        candidates: [
          candidate('post_resource_files', COPY, 9 * DAY),
          candidate('generation_inputs', IMPORT, 8 * DAY),
          // A read that strays outside the rule is refused here too.
          candidate('post_resource_files', `${PUBLISHER}/upload-1-photo.png`, 30 * DAY),
        ],
      },
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW });

    expect(summary).toMatchObject({
      mode: 'report',
      examined: 5,
      kept: 5,
      keptTooRecent: 1,
      keptNamed: 1,
      wouldDelete: 2,
      refused: 1,
      deletedCopies: 0,
      deletedImports: 0,
      batchLimitReached: false,
      sample: [`post_resource_files/${COPY}`, `generation_inputs/${IMPORT}`],
    });
    expect(calls.map((call) => call.op)).not.toContain('storage.remove');
    expect(calls.map((call) => call.op)).not.toContain('recipe_file_sweep_deletions.upsert');
    expect(logs.find((record) => record.msg === 'recipe_copy_sweep_report')).toBeDefined();
  });

  it('records each file in the ledger before it removes it, and counts what went', async () => {
    const { client, calls } = createFakeClient({
      candidates: {
        examined: 4,
        tooRecent: 1,
        named: 0,
        unnamed: 3,
        candidates: [
          candidate('post_resource_files', COPY, 9 * DAY),
          candidate('post_resource_files', OTHER_COPY, 9 * DAY),
          candidate('generation_inputs', IMPORT, 8 * DAY),
        ],
      },
      // One copy was already gone.
      removeResult: (bucket, names) => ({
        data: names.filter((name) => name !== OTHER_COPY).map((name) => ({ name })),
        error: null,
      }),
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    expect(summary).toMatchObject({
      mode: 'delete',
      examined: 4,
      deletedCopies: 1,
      deletedImports: 1,
      alreadyGone: 1,
      failed: 0,
      kept: 1,
      restoredImports: 0,
    });
    const ops = calls.map((call) => call.op);
    const ledgerAt = ops.indexOf('recipe_file_sweep_deletions.upsert');
    expect(ledgerAt).toBeGreaterThan(-1);
    expect(ops.indexOf('storage.remove')).toBeGreaterThan(ledgerAt);
    expect(calls[ledgerAt]?.args[0]).toEqual([
      { bucket_id: 'post_resource_files', object_name: COPY, deleted_at: NOW.toISOString(), checked_at: null },
      { bucket_id: 'post_resource_files', object_name: OTHER_COPY, deleted_at: NOW.toISOString(), checked_at: null },
      { bucket_id: 'generation_inputs', object_name: IMPORT, deleted_at: NOW.toISOString(), checked_at: null },
    ]);
    expect(calls.filter((call) => call.op === 'storage.remove')).toEqual([
      { op: 'storage.remove', bucket: 'post_resource_files', args: [[COPY, OTHER_COPY]] },
      { op: 'storage.remove', bucket: 'generation_inputs', args: [[IMPORT]] },
    ]);
  });

  it('removes nothing when the ledger cannot be written', async () => {
    const { client, calls } = createFakeClient({
      candidates: { examined: 1, unnamed: 1, candidates: [candidate('post_resource_files', COPY, 9 * DAY)] },
      ledgerUpsertError: { message: 'ledger down' },
    });

    await expect(sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true }))
      .rejects.toThrow('Could not record the recipe files to remove');
    expect(calls.map((call) => call.op)).not.toContain('storage.remove');
  });

  it('fails the run when the candidates cannot be read, rather than taking that for none', async () => {
    const { client } = createFakeClient({ candidatesError: { message: 'statement timeout' } });

    await expect(sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true }))
      .rejects.toThrow('Could not read recipe file sweep candidates');
  });

  it('counts a failed removal and leaves the ledger row for the restore check', async () => {
    const { client } = createFakeClient({
      candidates: { examined: 1, unnamed: 1, candidates: [candidate('post_resource_files', COPY, 9 * DAY)] },
      removeResult: () => ({ data: null, error: { message: 'storage unavailable' } }),
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    expect(summary).toMatchObject({ deletedCopies: 0, failed: 1, kept: 1 });
    expect(logs.some((record) => record.msg === 'recipe_copy_sweep_remove_failed')).toBe(true);
  });

  it('says when the batch bound left files for a later run', async () => {
    const { client } = createFakeClient({
      candidates: { examined: 500, unnamed: 450, candidates: [candidate('post_resource_files', COPY, 9 * DAY)] },
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: false });
    expect(summary.batchLimitReached).toBe(true);
  });

  it('puts an import back at once when a run start used it after the read', async () => {
    const READ_AT = '2026-11-04T06:50:03.000Z';
    const { client, calls } = createFakeClient({
      candidates: { readAt: READ_AT, examined: 1, unnamed: 1, candidates: [candidate('generation_inputs', IMPORT, 8 * DAY)] },
      usedImports: [IMPORT],
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    expect(summary).toMatchObject({ deletedImports: 1, restoredImports: 1 });
    expect(calls.filter((call) => call.op === 'storage.copy')).toEqual([{
      op: 'storage.copy',
      bucket: 'post_resource_files',
      args: [COPY, IMPORT, { destinationBucket: 'generation_inputs' }],
    }]);
    // Asked by the database's time of the read, less a margin, in the request body.
    expect(calls.find((call) => call.op === 'rpc.list_recipe_imports_used_since')?.args[0]).toEqual({
      p_object_names: [IMPORT],
      p_since: new Date(Date.parse(READ_AT) - 5 * 60 * 1000).toISOString(),
    });
  });

  it('leaves a removed import gone when no run start used it since the read', async () => {
    const { client, calls } = createFakeClient({
      candidates: { examined: 1, unnamed: 1, candidates: [candidate('generation_inputs', IMPORT, 8 * DAY)] },
      usedImports: [],
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    expect(summary).toMatchObject({ deletedImports: 1, restoredImports: 0 });
    expect(calls.map((call) => call.op)).not.toContain('storage.copy');
  });

  it('copies a removed copy back from its saved input once a recipe names it again', async () => {
    const { client, calls } = createFakeClient({
      candidates: { examined: 0, candidates: [] },
      namedAgain: [{
        object_name: COPY,
        input_id: ROW,
        input_user_id: PUBLISHER,
        input_role: 'reference',
        input_sort_order: 0,
        input_storage_path: INPUT_PATH,
        input_media_type: 'image',
        surviving_import: null,
      }],
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: false });

    expect(summary).toMatchObject({ restoredCopies: 1, restoreFailed: 0, restoreUnavailable: 0 });
    expect(calls.filter((call) => call.op === 'storage.copy')).toEqual([{
      op: 'storage.copy',
      bucket: 'generation_inputs',
      args: [`${PUBLISHER}/${CREATION}/00-reference.png`, COPY, { destinationBucket: 'post_resource_files' }],
    }]);
    const forget = calls.find((call) => call.op === 'recipe_file_sweep_deletions.delete' && call.args.some(
      (arg) => Array.isArray(arg) && arg[0] === 'eq' && arg[2] === COPY,
    ));
    expect(forget).toBeDefined();
    // Asked about the past two weeks' removals, a batch at a time.
    expect(calls.find((call) => call.op === 'rpc.list_swept_recipe_copies_named_again')?.args[0]).toEqual({
      p_deleted_since: new Date(NOW.getTime() - 14 * DAY).toISOString(),
      p_limit: 200,
    });
  });

  it('copies a removed copy back from a surviving import of it when its saved input is gone', async () => {
    const { client, calls } = createFakeClient({
      candidates: { examined: 0, candidates: [] },
      namedAgain: [{
        object_name: COPY,
        input_id: null,
        input_user_id: null,
        input_role: null,
        input_sort_order: null,
        input_storage_path: null,
        input_media_type: null,
        surviving_import: IMPORT,
      }],
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    expect(summary).toMatchObject({ restoredCopies: 1, restoreUnavailable: 0 });
    expect(calls.filter((call) => call.op === 'storage.copy')).toEqual([{
      op: 'storage.copy',
      bucket: 'generation_inputs',
      args: [IMPORT, COPY, { destinationBucket: 'post_resource_files' }],
    }]);
  });

  it('copies nothing back from an input that is gone or does not build that path', async () => {
    const { client, calls } = createFakeClient({
      candidates: { examined: 0, candidates: [] },
      namedAgain: [
        { object_name: COPY, input_id: null, input_user_id: null, input_role: null, input_sort_order: null, input_storage_path: null, input_media_type: null, surviving_import: null },
        // An import of another copy is no source of this one.
        { object_name: COPY, input_id: null, input_user_id: null, input_role: null, input_sort_order: null, input_storage_path: null, input_media_type: null, surviving_import: `${BUYER}/recipe-imports/${PUBLISHER}/${CREATION}/01-reference-other.png` },
        {
          object_name: COPY,
          input_id: ROW,
          input_user_id: PUBLISHER,
          // Another role builds another file name.
          input_role: 'start-frame',
          input_sort_order: 0,
          input_storage_path: INPUT_PATH,
          input_media_type: 'image',
          surviving_import: null,
        },
      ],
    });

    const summary = await sweepRecipeFileCopies(client as never, { now: NOW, deleteEnabled: true });

    expect(summary).toMatchObject({ restoredCopies: 0, restoreUnavailable: 3 });
    expect(calls.map((call) => call.op)).not.toContain('storage.copy');
    expect(logs.filter((record) => record.msg === 'recipe_copy_sweep_restore_unavailable')).toHaveLength(3);
  });
});
