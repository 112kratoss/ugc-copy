import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth';
import { readGenerationSetup, type GenerationSetupEntry } from '@/lib/generation-setup/generation-setup';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { IncompleteAnswerError, ONE_TIME_POST_READ } from '@/lib/one-time-post-read';
import { shouldReadPostGenerationSetup } from '@/lib/post-details-view-model';

export interface PostGenerationSetup {
  /** The settings Details draws under Made with: none where the post has none, or until they arrive. */
  entries: GenerationSetupEntry[];
  /** The post's read is on its way and should bring them, so the line's place is held. */
  pending: boolean;
}

/**
 * The creation's settings for a post's Details (owner, 2026-11-03). Every card
 * carries them from the read that hydrated it, so Details draws the card's. A
 * card without them (Home's first page kept from an earlier launch, or one whose
 * settings the server could not read) has Details read the post once it is on
 * screen, by the app's one-time post read. An answer that still cannot tell them
 * fails rather than being kept as none. The read has a key of its own: the
 * feeds seed the post's own query with the card they opened, and Details would
 * have read that.
 */
export function usePostGenerationSetup(item: ImmersivePreviewItem, active: boolean): PostGenerationSetup {
  const { api } = useAuth();
  const reads = shouldReadPostGenerationSetup(item);
  const postId = reads ? item.showcasePostId : null;
  const query = useQuery({
    queryKey: ['post-generation-setup', postId],
    queryFn: async () => {
      const setup = readGenerationSetup((await api.getShowcasePost(postId!)).item?.generationSetup);
      if (!setup) throw new IncompleteAnswerError('The post came back without its settings.');
      return setup;
    },
    enabled: active && Boolean(postId),
    ...ONE_TIME_POST_READ,
  });

  if (item.previewKind === 'text') return { entries: [], pending: false };
  const brought = item.details?.generationSetup;
  if (brought) return { entries: brought, pending: false };
  if (!reads) return { entries: [], pending: false };
  return { entries: query.data ?? [], pending: query.isPending };
}
