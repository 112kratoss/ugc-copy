import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { RECIPE_IMPORT_FOLDER } from '@/lib/recipe-file-paths';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const LIST_PAGE_SIZE = 100;

/**
 * Deletes a buyer's run-start imports of a recipe's copies once a Razorpay refund or dispute has deleted
 * their purchase of it (owner, 2026-11-04): `generation_inputs/<buyer>/recipe-imports/<seller>/<creation>/`.
 * Only that path calls it (`razorpay-webhook-service.ts`). A store refund (RevenueCat,
 * `reconcile_mobile_purchase_adjustment`) and a moderation retraction (`moderation_retracted_at`) end
 * the purchase without it: their imports stay in storage, inert, since no JWT reads a `recipe-imports/`
 * object and every server use re-checks the unlock (`reuseRecipeFile`).
 * An import is a cache a start can make again while the unlock holds, so nothing of the buyer's is
 * lost; their runs keep their own kept inputs, which are withheld at read time instead
 * (`recipe_file_readable_by`, `withholdUnreadableRecipeFileInputs`) so a restored purchase opens them
 * again. Nothing rests on this deletion: storage and every server read refuse an import to its buyer
 * once the unlock is gone. Never throws; a failure is logged and the read-time checks stand.
 */
export async function releaseRecipeImportsForRefundedOrder(params: {
  adminSupabase: SupabaseClient;
  orderId: string;
}): Promise<void> {
  const { adminSupabase } = params;
  try {
    const { data: order, error: orderError } = await adminSupabase
      .from('post_resource_bundle_orders')
      .select('buyer_user_id, bundle_id')
      .eq('id', params.orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    const { buyer_user_id: buyerUserId, bundle_id: bundleId } = (order ?? {}) as { buyer_user_id?: string | null; bundle_id?: string | null };
    if (!buyerUserId || !bundleId) return;

    const { data: bundle, error: bundleError } = await adminSupabase
      .from('post_resource_bundles')
      .select('owner_user_id, post_id')
      .eq('id', bundleId)
      .maybeSingle();
    if (bundleError) throw bundleError;
    const { owner_user_id: sellerUserId, post_id: postId } = (bundle ?? {}) as { owner_user_id?: string | null; post_id?: string | null };
    if (!sellerUserId || !postId) return;

    const { data: post, error: postError } = await adminSupabase
      .from('posts')
      .select('generation_id, deleted_generation_id')
      .eq('id', postId)
      .maybeSingle();
    if (postError) throw postError;
    const typedPost = (post ?? {}) as { generation_id?: string | null; deleted_generation_id?: string | null };
    const creationId = typedPost.generation_id ?? typedPost.deleted_generation_id;
    if (!creationId) return;

    const folder = `${buyerUserId}/${RECIPE_IMPORT_FOLDER}/${sellerUserId}/${creationId}`;
    const bucket = adminSupabase.storage.from(GENERATION_INPUTS_BUCKET);
    // Removed page by page: each pass lists what is left.
    for (let pass = 0; pass < 20; pass += 1) {
      const { data: files, error: listError } = await bucket.list(folder, { limit: LIST_PAGE_SIZE });
      if (listError) throw listError;
      const names = (files ?? []).map((file) => file.name).filter((name): name is string => Boolean(name));
      if (names.length === 0) return;
      const { error: removeError } = await bucket.remove(names.map((name) => `${folder}/${name}`));
      if (removeError) throw removeError;
      if (names.length < LIST_PAGE_SIZE) return;
    }
  } catch (error) {
    logBackendError('recipe_imports_release_after_refund_failed', { error });
  }
}
