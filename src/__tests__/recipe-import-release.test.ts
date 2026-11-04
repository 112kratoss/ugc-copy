import { describe, expect, it, vi } from 'vitest';

import { releaseRecipeImportsForRefundedOrder } from '@/lib/recipe-import-release';

// Owner, 2026-11-04: a refund deletes the buyer's purchase of a recipe, and with it their run starts'
// imports of its copies. Their kept inputs are held at read time instead, so nothing rests on this.

const FOLDER = 'buyer-1/recipe-imports/seller-1/gen-1';

function setUp(options: { post?: Record<string, unknown> | null; files?: string[]; listError?: { message: string } } = {}) {
  const rows: Record<string, Record<string, unknown> | null> = {
    post_resource_bundle_orders: { buyer_user_id: 'buyer-1', bundle_id: 'bundle-1' },
    post_resource_bundles: { owner_user_id: 'seller-1', post_id: 'post-1' },
    posts: options.post === undefined ? { generation_id: 'gen-1', deleted_generation_id: null } : options.post,
  };
  const list = vi.fn(async () => (options.listError
    ? { data: null, error: options.listError }
    : { data: (options.files ?? ['00-reference-image-row-1.png']).map((name) => ({ name })), error: null }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const storageFrom = vi.fn(() => ({ list, remove }));
  const adminSupabase = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }) }),
    }),
    storage: { from: storageFrom },
  };
  return { adminSupabase: adminSupabase as never, list, remove, storageFrom };
}

describe('releasing a refunded buyer’s imports of a recipe’s copies', () => {
  it('deletes the imports in the buyer’s folder for that recipe’s creation', async () => {
    const stub = setUp({ files: ['00-reference-image-row-1.png', '01-reference-video-row-2.mp4'] });

    await releaseRecipeImportsForRefundedOrder({ adminSupabase: stub.adminSupabase, orderId: 'order-1' });

    expect(stub.storageFrom).toHaveBeenCalledWith('generation_inputs');
    expect(stub.list).toHaveBeenCalledWith(FOLDER, { limit: 100 });
    expect(stub.remove).toHaveBeenCalledWith([`${FOLDER}/00-reference-image-row-1.png`, `${FOLDER}/01-reference-video-row-2.mp4`]);
  });

  it('finds the creation of a post whose creation was deleted since', async () => {
    const stub = setUp({ post: { generation_id: null, deleted_generation_id: 'gen-1' } });

    await releaseRecipeImportsForRefundedOrder({ adminSupabase: stub.adminSupabase, orderId: 'order-1' });

    expect(stub.list).toHaveBeenCalledWith(FOLDER, { limit: 100 });
  });

  it('removes nothing where there is nothing, and never throws on a failure', async () => {
    const empty = setUp({ files: [] });
    await releaseRecipeImportsForRefundedOrder({ adminSupabase: empty.adminSupabase, orderId: 'order-1' });
    expect(empty.remove).not.toHaveBeenCalled();

    const failing = setUp({ listError: { message: 'storage outage' } });
    await expect(releaseRecipeImportsForRefundedOrder({ adminSupabase: failing.adminSupabase, orderId: 'order-1' })).resolves.toBeUndefined();
    expect(failing.remove).not.toHaveBeenCalled();
  });
});
