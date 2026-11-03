import { describe, expect, it, vi } from 'vitest';

import {
  SEEDANCE_ASSET_NOT_YOURS_MESSAGE,
  checkSeedanceAssetsUsable,
} from '@/lib/seedance-asset-provenance';

// Owner, 2026-11-04: a Seedance asset id is a bearer handle at the provider. One prepared from a
// recipe file runs only for its preparer, while the copy is still theirs to reuse; nobody else ever
// runs it. One prepared from a file of the preparer's own runs for anyone it is handed to, as before.

const BUYER = 'buyer-1';
const COPY = 'post_resource_files/seller-1/generation-references/gen-1/00-reference-image-row-1.png';

type Row = { asset_id: string; owner_user_id: string; recipe_file: string | null };

function setUp(options: {
  rows?: Row[];
  readError?: { message: string };
  reuse?: 'entitled' | 'not-eligible' | 'failed';
  held?: { outcome: 'copy'; copySource: string } | { outcome: 'not-eligible' } | null;
} = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const client = {
    from: vi.fn(() => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => (options.readError
          ? { data: null, error: options.readError }
          : { data: (options.rows ?? []).filter((row) => ids.includes(row.asset_id)), error: null }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row);
        return { data: null, error: null };
      },
    })),
  };
  const checkRecipeCopyReuse = vi.fn(async () => ({ outcome: options.reuse ?? 'entitled' }));
  const findHeldRecipeCopy = vi.fn(async () => options.held ?? null);
  return {
    inserts,
    checkRecipeCopyReuse,
    findHeldRecipeCopy,
    dependencies: {
      createServiceClient: (() => client) as never,
      checkRecipeCopyReuse: checkRecipeCopyReuse as never,
      findHeldRecipeCopy: findHeldRecipeCopy as never,
    },
  };
}

const check = (stub: ReturnType<typeof setUp>, assetIds: string[], pairedSources?: Map<string, string>, viewerUserId = BUYER) => (
  checkSeedanceAssetsUsable({ viewerUserId, assetIds, pairedSources, dependencies: stub.dependencies })
);

describe('which Seedance asset ids a run may send', () => {
  it('lets anyone run an asset prepared from its preparer’s own file', async () => {
    const stub = setUp({ rows: [{ asset_id: 'asset-own', owner_user_id: 'creator-1', recipe_file: null }] });

    await expect(check(stub, ['asset-own'])).resolves.toEqual({ ok: true });
    expect(stub.checkRecipeCopyReuse).not.toHaveBeenCalled();
  });

  it('runs an asset prepared from a recipe copy for its preparer while the copy is theirs to reuse', async () => {
    const stub = setUp({ rows: [{ asset_id: 'asset-copy', owner_user_id: BUYER, recipe_file: COPY }] });

    await expect(check(stub, ['asset-copy'])).resolves.toEqual({ ok: true });
    expect(stub.checkRecipeCopyReuse).toHaveBeenCalledWith(expect.objectContaining({ source: COPY, viewerUserId: BUYER }));
  });

  it('refuses it after a refund, a block or an archive took the copy back', async () => {
    const stub = setUp({ rows: [{ asset_id: 'asset-copy', owner_user_id: BUYER, recipe_file: COPY }], reuse: 'not-eligible' });

    await expect(check(stub, ['asset-copy'])).resolves.toEqual({ ok: false, status: 400, message: SEEDANCE_ASSET_NOT_YOURS_MESSAGE });
  });

  it('fails retryably when the copy cannot be read, rather than taking that for either answer', async () => {
    const stub = setUp({ rows: [{ asset_id: 'asset-copy', owner_user_id: BUYER, recipe_file: COPY }], reuse: 'failed' });

    await expect(check(stub, ['asset-copy'])).resolves.toMatchObject({ ok: false, status: 500 });
  });

  it('never runs a recipe file’s asset for anyone but its preparer, a remixer of their run included', async () => {
    const stub = setUp({ rows: [{ asset_id: 'asset-copy', owner_user_id: BUYER, recipe_file: COPY }] });

    await expect(check(stub, ['asset-copy'], undefined, 'remixer-1')).resolves.toMatchObject({ ok: false, status: 400 });
    expect(stub.checkRecipeCopyReuse).not.toHaveBeenCalled();
  });

  it('refuses an asset prepared from a recipe file whose copy is on no record', async () => {
    const stub = setUp({ rows: [{ asset_id: 'asset-unknown-copy', owner_user_id: BUYER, recipe_file: '' }] });

    await expect(check(stub, ['asset-unknown-copy'])).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('fails retryably when the records cannot be read', async () => {
    const stub = setUp({ readError: { message: 'statement timeout' } });

    await expect(check(stub, ['asset-own'])).resolves.toMatchObject({ ok: false, status: 500 });
  });

  describe('an asset prepared before the records existed', () => {
    it('is recorded by the first start that sends it beside its file, as that file reads now, and judged so', async () => {
      const stub = setUp({ held: { outcome: 'copy', copySource: COPY }, reuse: 'not-eligible' });

      await expect(check(stub, ['asset-old'], new Map([['asset-old', 'uploads/seller-1/copy.png']]))).resolves.toMatchObject({ ok: false, status: 400 });
      expect(stub.inserts).toEqual([{
        asset_id: 'asset-old',
        owner_user_id: BUYER,
        source: 'uploads/seller-1/copy.png',
        recipe_file: COPY,
        recorded_from: 'start',
      }]);
    });

    it('is recorded as the caller’s own when its file is theirs', async () => {
      const stub = setUp({ held: null });

      await expect(check(stub, ['asset-old'], new Map([['asset-old', 'uploads/buyer-1/mine.png']]))).resolves.toEqual({ ok: true });
      expect(stub.inserts).toEqual([expect.objectContaining({ asset_id: 'asset-old', recipe_file: null })]);
    });

    it('is let through when sent bare, with no file to say what it runs', async () => {
      const stub = setUp();

      await expect(check(stub, ['asset-bare'])).resolves.toEqual({ ok: true });
      expect(stub.inserts).toEqual([]);
    });
  });

  it('asks nothing of a run that sends no asset', async () => {
    const stub = setUp();

    await expect(check(stub, [])).resolves.toEqual({ ok: true });
  });
});
