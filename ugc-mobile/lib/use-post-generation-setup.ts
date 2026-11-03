import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { readGenerationSetup, type GenerationSetupEntry } from '@/lib/generation-setup/generation-setup';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { shouldReadPostGenerationSetup } from '@/lib/post-details-view-model';

export interface PostGenerationSetup {
  /** The settings Details draws under Made with: none where the post has none, or until they arrive. */
  entries: GenerationSetupEntry[];
  /** The post's read is on its way and should bring them, so the line's place is held. */
  pending: boolean;
}

/** A refusal (gone, private, blocked) answers the same again; a dropped connection may not. */
function retryUnlessRefused(failureCount: number, error: unknown) {
  return failureCount < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/**
 * The creation's settings for a post's Details (owner, 2026-11-03). A post read
 * by id brings them; a feed page leaves them out, so Details reads the post
 * once it is on screen and keeps the answer, as a post's settings never change.
 * The read has a key of its own: the feeds seed the post's own query with the
 * card they opened, which carries none, and Details would have read that.
 */
export function usePostGenerationSetup(item: ImmersivePreviewItem, active: boolean): PostGenerationSetup {
  const { api } = useAuth();
  const reads = shouldReadPostGenerationSetup(item);
  const postId = reads ? item.showcasePostId : null;
  const query = useQuery({
    queryKey: ['post-generation-setup', postId],
    queryFn: async () => readGenerationSetup((await api.getShowcasePost(postId!)).item?.generationSetup) ?? [],
    enabled: active && Boolean(postId),
    staleTime: Infinity,
    retry: retryUnlessRefused,
  });

  if (item.previewKind === 'text') return { entries: [], pending: false };
  const brought = item.details?.generationSetup;
  if (brought) return { entries: brought, pending: false };
  if (!reads) return { entries: [], pending: false };
  return { entries: query.data ?? [], pending: query.isPending };
}
