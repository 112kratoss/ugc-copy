import 'server-only';

import { unstable_cache } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * How long the read may take before it answers no. The flag only decides whether a link is
 * drawn, and a page waits for it (a creator's remix waits for it before its sign-in check),
 * so a slow or unreachable database costs a page at most this, never supabase-js's retries.
 */
export const LIVE_TEMPLATES_READ_TIMEOUT_MS = 2_000;

/**
 * Whether `/templates` lists any template: one row asked for, under the catalog's own filters
 * (`listActiveMediaTemplatesPage`: published, active, with an active version, by a creator;
 * `live-media-templates.test.ts` holds the two to the same filters). The image, video and
 * motion creators, the launchpad and the owner's templates draw their ways into the catalog
 * only then: the web sweep of 2026-11-17 followed them to "No templates are live yet". Sent
 * once, with no retries, and given up at `LIVE_TEMPLATES_READ_TIMEOUT_MS`. A failed read
 * throws: it says nothing about the catalog, and the cache below must not keep it.
 */
export async function hasLiveMediaTemplates(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.from('templates').select('id')
    .eq('status', 'active').eq('is_active', true).not('active_version_id', 'is', null)
    .not('creator_user_id', 'is', null)
    .limit(1)
    .retry(false)
    .abortSignal(AbortSignal.timeout(LIVE_TEMPLATES_READ_TIMEOUT_MS));
  if (error) throw error;
  return (data ?? []).length > 0;
}

// Asked of the catalog at most once in five minutes for all the pages' traffic, as fresh as
// `/templates` itself (`revalidate = 300` there): a template published or taken down shows up
// in the two at about the same time.
const loadCachedTemplatesLive = unstable_cache(
  () => hasLiveMediaTemplates(createServiceClient()),
  ['creator-templates-live'],
  { revalidate: 300 },
);

/**
 * Whether `/templates` lists a template, for the pages that link to it: the creators (the
 * Templates tile beside Enhance, "Browse templates" under "Start from a post"), the launchpad's
 * catalog card and the owner's "Browse templates" on `/templates/mine`. False when the catalog
 * cannot be read: a way in that may lead to an empty page is left out, and the next request
 * asks again. Never throws.
 */
export async function loadTemplatesLive(): Promise<boolean> {
  try {
    return await loadCachedTemplatesLive();
  } catch (error) {
    logBackendError('creator_templates_live_load_failed', { error });
    return false;
  }
}
