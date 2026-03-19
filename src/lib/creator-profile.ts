import 'server-only';

import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import { getCreatorDisplayName, normalizeUsername } from '@/lib/profile';
import type { ShowcaseFeedItem, ShowcaseItemCategory } from '@/lib/showcase';

interface CreatorProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
}

interface CreatorGenerationRow {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  model: string;
  prompt: string | null;
  title: string | null;
  category: ShowcaseItemCategory | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
}

export interface CreatorProfilePageData {
  profile: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
  };
  stats: {
    publicCreations: number;
    totalSaves: number;
    totalRemixes: number;
  };
  items: ShowcaseFeedItem[];
}

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad') {
    return category;
  }

  return 'image';
}

function resolveShowcaseUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  showcaseAssetPath: string
): string {
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
}

async function resolveItemUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generation: CreatorGenerationRow
): Promise<string | null> {
  if (generation.showcase_asset_path) {
    return resolveShowcaseUrl(adminSupabase, generation.showcase_asset_path);
  }

  if (!generation.output_url) {
    return null;
  }

  if (generation.output_url.startsWith('http')) {
    return generation.output_url;
  }

  return resolveStoredMediaUrl(adminSupabase, generation.output_url);
}

export async function getCreatorProfilePageData(rawUsername: string): Promise<CreatorProfilePageData | null> {
  const username = normalizeUsername(rawUsername);
  if (!username) {
    return null;
  }

  const adminSupabase = createServiceClient();
  const { data: profile, error: profileError } = await adminSupabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url')
    .eq('username', username)
    .maybeSingle();

  if (profileError) {
    console.error('Failed to fetch creator profile:', profileError);
    throw profileError;
  }

  if (!profile) {
    return null;
  }

  const { data: generations, error: generationsError } = await adminSupabase
    .from('generations')
    .select('id, output_url, showcase_asset_path, model, prompt, title, category, save_count, remix_count, created_at')
    .eq('user_id', profile.id)
    .eq('is_public', true)
    .eq('status', 'succeeded')
    .not('output_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(24);

  if (generationsError) {
    console.error('Failed to fetch creator generations:', generationsError);
    throw generationsError;
  }

  const visibleRows = (generations ?? []) as CreatorGenerationRow[];
  const resolvedItems = await Promise.all(
    visibleRows.map(async (generation): Promise<ShowcaseFeedItem | null> => {
      const url = await resolveItemUrl(adminSupabase, generation);
      if (!url) {
        return null;
      }

      return {
        id: generation.id,
        url,
        model: generation.model,
        title: generation.title || 'Untitled Creation',
        prompt: generation.prompt || '',
        category: resolveItemCategory(generation.category),
        saveCount: generation.save_count || 0,
        remixCount: generation.remix_count || 0,
        createdAt: generation.created_at,
        creator: {
          id: profile.id,
          username: profile.username,
          name: getCreatorDisplayName({
            displayName: profile.display_name,
            username: profile.username,
          }),
          avatar: profile.avatar_url,
        },
      };
    })
  );

  const items = resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);

  return {
    profile: {
      id: profile.id,
      username: profile.username ?? username,
      displayName: getCreatorDisplayName({
        displayName: profile.display_name,
        username: profile.username,
      }),
      bio: profile.bio,
      avatarUrl: profile.avatar_url,
    },
    stats: {
      publicCreations: items.length,
      totalSaves: items.reduce((sum, item) => sum + item.saveCount, 0),
      totalRemixes: items.reduce((sum, item) => sum + item.remixCount, 0),
    },
    items,
  };
}
