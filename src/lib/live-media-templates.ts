import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whether `/templates` lists any template: one row asked for, under the catalog's own filters
 * (`listActiveMediaTemplatesPage`: published, active, with an active version, by a creator;
 * `live-media-templates.test.ts` holds the two to the same filters). The image, video and
 * motion creators draw their ways into the catalog (the Templates tile beside Enhance,
 * "Browse templates" under "Start from a post") only then: the web sweep of 2026-11-17
 * followed them to "No templates are live yet". Kept apart from the template service so the
 * creators' server code does not load its media tooling. A failed read throws: it says
 * nothing about the catalog, and a cache over this must not keep it.
 */
export async function hasLiveMediaTemplates(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.from('templates').select('id')
    .eq('status', 'active').eq('is_active', true).not('active_version_id', 'is', null)
    .not('creator_user_id', 'is', null)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
