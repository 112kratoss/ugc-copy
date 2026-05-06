import 'server-only';

import { getCreatorDisplayName } from '@/lib/profile';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import type { ShowcaseCreator, ShowcaseItemCategory } from '@/lib/showcase';

type PublicGenerationRow = {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  model: string;
  prompt: string | null;
  title: string | null;
  description: string | null;
  category: ShowcaseItemCategory | null;
  save_count: number | null;
  remix_count: number | null;
  share_count: number | null;
  share_visit_count: number | null;
  created_at: string;
  user_id: string | null;
};

type ProfileSummary = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export interface PublicGenerationDetail {
  id: string;
  url: string;
  model: string;
  title: string;
  description: string;
  prompt: string;
  category: ShowcaseItemCategory;
  saveCount: number;
  remixCount: number;
  shareCount: number;
  shareVisitCount: number;
  createdAt: string;
  creator: ShowcaseCreator;
}

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad') {
    return category;
  }

  return 'image';
}

function resolvePublicShowcaseUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  showcaseAssetPath: string
): string {
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
}

async function resolvePublicGenerationUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generation: Pick<PublicGenerationRow, 'showcase_asset_path' | 'output_url'>
): Promise<string | null> {
  if (generation.showcase_asset_path) {
    return resolvePublicShowcaseUrl(adminSupabase, generation.showcase_asset_path);
  }

  if (!generation.output_url) {
    return null;
  }

  if (generation.output_url.startsWith('http')) {
    return generation.output_url;
  }

  return resolveStoredMediaUrl(adminSupabase, generation.output_url);
}

async function fetchPublicGenerationRow(id: string): Promise<PublicGenerationRow | null> {
  const adminSupabase = createServiceClient();

  const selectWithAllColumns = 'id, output_url, showcase_asset_path, model, prompt, title, description, category, save_count, remix_count, share_count, share_visit_count, created_at, user_id';
  const selectWithoutShareColumns = 'id, output_url, showcase_asset_path, model, prompt, title, description, category, save_count, remix_count, created_at, user_id';
  const selectWithoutShareAndAsset = 'id, output_url, model, prompt, title, description, category, save_count, remix_count, created_at, user_id';

  type PublicGenerationAttempt = {
    data: PublicGenerationRow | null;
    error: { code?: string } | null;
  };

  const attempt = async (
    selectClause: string,
    includeAsset: boolean,
    includeShareCounts: boolean
  ): Promise<PublicGenerationAttempt> => {
    const result = await adminSupabase
      .from('generations')
      .select(selectClause)
      .eq('id', id)
      .eq('is_public', true)
      .is('archived_at', null)
      .eq('status', 'succeeded')
      .maybeSingle();

    if (!result.data || result.error) {
      return {
        data: null,
        error: result.error,
      };
    }

    const row = result.data as Partial<PublicGenerationRow>;

    return {
      data: {
        ...row,
        showcase_asset_path: includeAsset ? row.showcase_asset_path ?? null : null,
        share_count: includeShareCounts ? row.share_count ?? 0 : 0,
        share_visit_count: includeShareCounts ? row.share_visit_count ?? 0 : 0,
      } as PublicGenerationRow,
      error: null,
    };
  };

  let result = await attempt(selectWithAllColumns, true, true);

  if (result.error?.code === '42703') {
    result = await attempt(selectWithoutShareColumns, true, false);
  }

  if (result.error?.code === '42703') {
    result = await attempt(selectWithoutShareAndAsset, false, false);
  }

  if (result.error) {
    console.error('Failed to fetch public generation detail:', result.error);
    throw result.error;
  }

  return (result.data as PublicGenerationRow | null) ?? null;
}

export async function getPublicGenerationDetail(id: string): Promise<PublicGenerationDetail | null> {
  const generation = await fetchPublicGenerationRow(id);
  if (!generation) {
    return null;
  }

  const adminSupabase = createServiceClient();
  const url = await resolvePublicGenerationUrl(adminSupabase, generation);
  if (!url) {
    return null;
  }

  let creator: ShowcaseCreator = {
    id: null,
    username: null,
    name: 'Anonymous',
    avatar: null,
  };

  if (generation.user_id) {
    const { data: profile, error: profileError } = await adminSupabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('id', generation.user_id)
      .maybeSingle();

    if (profileError) {
      console.error('Failed to fetch public generation creator profile:', profileError);
    } else if (profile) {
      creator = {
        id: (profile as ProfileSummary).id,
        username: (profile as ProfileSummary).username,
        name: getCreatorDisplayName({
          displayName: (profile as ProfileSummary).display_name,
          username: (profile as ProfileSummary).username,
        }),
        avatar: (profile as ProfileSummary).avatar_url,
      };
    }
  }

  const title = generation.title?.trim() || 'Untitled Creation';
  const prompt = generation.prompt?.trim() || '';
  const description = generation.description?.trim() || prompt || `Explore ${title} on magicbooklet.`;

  return {
    id: generation.id,
    url,
    model: generation.model,
    title,
    description,
    prompt,
    category: resolveItemCategory(generation.category),
    saveCount: generation.save_count ?? 0,
    remixCount: generation.remix_count ?? 0,
    shareCount: generation.share_count ?? 0,
    shareVisitCount: generation.share_visit_count ?? 0,
    createdAt: generation.created_at,
    creator,
  };
}
