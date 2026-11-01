import { describe, expect, expectTypeOf, it } from 'vitest';

import { buildImmersiveShowcaseItems } from '../lib/immersive-preview-view-model';
import { mediaItemAspectRatio } from '../lib/media-zoom-transition';
import {
  FALLBACK_PROFILE_MEDIA,
  OWN_PROFILE_SHARE_SOURCE,
  generationToProfileMediaCard,
  getOwnerPostScopeCounts,
  getProfileCreationsScopeOptions,
  getProfileMediaEmptyBody,
  getProfileMediaEmptyTitle,
  getProfilePostsScopeOptions,
  PROFILE_MEDIA_EMPTY_BODY,
  getProfileStats,
  getWalletCardContent,
  UNKNOWN_PROFILE_STAT_VALUE,
  ownProfileShareUrl,
  ownerPostToProfileMediaCard,
  showcaseToSavedProfileMediaCard,
  type ProfileCreationsScope,
  type ProfilePostsScope,
  type ProfileScopeOption,
} from '../lib/profile-view-model';
import type { GenerationListItem, OwnerPostListItem, ShowcaseFeedItem, ShowcaseMediaItem } from '../lib/types';

describe('profile view model media cards', () => {
  it('keeps a creation whose only source is gone on the grid with an explicit label', () => {
    const item: GenerationListItem = {
      id: 'gen-gone',
      output_url: null,
      status: 'succeeded',
      created_at: '2026-03-05T10:00:00.000Z',
      completed_at: '2026-03-05T10:02:00.000Z',
      model: 'kling-2.6/motion-control',
      category: 'motion',
      media: null,
      source_unavailable_at: '2026-09-08T06:15:00.000Z',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      id: 'gen-gone',
      mediaUrl: null,
      previewUrl: null,
      previewStatusLabel: 'File no longer available',
      isGridReady: true,
    });
  });

  it('draws a post whose media source is gone as a labelled plate and never hands out the dead address', () => {
    const item = {
      id: 'post-gone',
      title: 'Expired image',
      visibility: 'public',
      createdAt: '2026-06-09T10:00:00.000Z',
      updatedAt: '2026-06-09T10:00:00.000Z',
      category: 'image',
      postFormat: 'media',
      mediaUrl: 'https://tempfile.provider.example/expired.png',
      mediaKind: 'image',
      mediaItems: [{
        id: 'media-gone',
        mediaKey: 'media-0',
        url: 'https://tempfile.provider.example/expired.png',
        mediaKind: 'image',
        previewStatus: 'failed',
        gridReady: false,
        sourceUnavailableAt: '2026-09-08T06:15:00.000Z',
      }],
    } as unknown as OwnerPostListItem;

    expect(ownerPostToProfileMediaCard(item)).toMatchObject({
      id: 'post-gone',
      mediaUrl: null,
      previewUrl: null,
      previewStatusLabel: 'File no longer available',
      isGridReady: true,
    });
  });

  it('maps generation previewUrl so video creation tiles can render persisted posters', () => {
    const item: GenerationListItem = {
      id: 'gen-video-1',
      output_url: 'https://cdn.example.com/video.mp4',
      preview_url: 'https://cdn.example.com/video-poster.webp',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      media: {
        id: 'gen-video-1',
        kind: 'video',
        url: 'https://cdn.example.com/video.mp4',
        previewUrl: 'https://cdn.example.com/video-poster.webp',
        thumbhash: 'video-thumbhash',
        cacheKey: 'generated_videos/video.preview.hash.webp',
        expiresAt: '2026-06-10T11:00:00.000Z',
        width: null,
        height: null,
        durationSeconds: 5,
        status: 'ready',
        gridReady: true,
      },
      title: 'Street motion',
      prompt: 'A creator walks through a market.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      mediaKind: 'video',
      previewUrl: 'https://cdn.example.com/video-poster.webp',
      previewState: 'videoPoster',
      isGridReady: true,
      previewThumbhash: 'video-thumbhash',
      previewCacheKey: 'generated_videos/video.preview.hash.webp',
    });
  });

  it('maps ugc-ad generations as video media cards', () => {
    const item: GenerationListItem = {
      id: 'gen-ugc-ad-1',
      output_url: 'https://cdn.example.com/ugc-ad.mp4',
      preview_url: 'https://cdn.example.com/ugc-ad-poster.webp',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'ugc-ad-model',
      category: 'ugc-ad',
      title: 'UGC ad',
      prompt: 'A creator ad spot.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      mediaKind: 'video',
      previewState: 'videoPoster',
      isGridReady: true,
    });
  });

  it('keeps a finished image generation in the grid without painting the source as its poster', () => {
    const item: GenerationListItem = {
      id: 'gen-image-1',
      output_url: 'https://cdn.example.com/image.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Image still',
      prompt: 'A product still.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      previewUrl: null,
      previewState: 'artFallback',
      previewStatusLabel: 'Tap to view media',
      isGridReady: true,
    });
  });

  it('keeps a finished video in the grid when its poster job failed, without streaming the clip', () => {
    const item: GenerationListItem = {
      id: 'gen-video-missing-poster',
      output_url: 'https://cdn.example.com/video.mp4',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      title: 'Video only',
      prompt: 'A video generation.',
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      previewUrl: null,
      previewState: 'videoFallback',
      previewStatusLabel: 'Tap to view media',
      isGridReady: true,
    });
  });

  it('ignores a poster the route echoed from the source when no derivative is ready', () => {
    const item: GenerationListItem = {
      id: 'gen-image-echoed-poster',
      output_url: 'https://cdn.example.com/image.jpg',
      preview_url: 'https://cdn.example.com/image.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Image still',
      prompt: 'A product still.',
      media: {
        id: 'gen-image-echoed-poster',
        kind: 'image',
        url: 'https://cdn.example.com/image.jpg',
        previewUrl: 'https://cdn.example.com/image.jpg',
        thumbhash: null,
        cacheKey: 'generated_images/image.jpg',
        expiresAt: null,
        width: null,
        height: null,
        durationSeconds: null,
        status: 'failed',
        gridReady: false,
      },
    };

    expect(generationToProfileMediaCard(item)).toMatchObject({
      previewUrl: null,
      previewState: 'artFallback',
      isGridReady: true,
    });
  });

  it('keeps unfinished and missing-media generations out while allowing archived tiles', () => {
    const base: GenerationListItem = {
      id: 'gen-base',
      output_url: 'https://cdn.example.com/image.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      completed_at: '2026-06-10T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Image still',
      prompt: 'A product still.',
    };

    expect(generationToProfileMediaCard({ ...base, id: 'failed', status: 'failed' }).isGridReady).toBe(false);
    expect(generationToProfileMediaCard({ ...base, id: 'processing', status: 'processing' }).isGridReady).toBe(false);
    expect(generationToProfileMediaCard({ ...base, id: 'archived', archived_at: '2026-06-11T00:00:00.000Z' }).isGridReady).toBe(true);
    expect(generationToProfileMediaCard({ ...base, id: 'missing', output_url: null }).isGridReady).toBe(false);
  });

  // Restore refuses it, and the web names it (audit 01-5).
  it('draws a creation moderation removed as a labelled plate, in the Archived scope, never its media', () => {
    const card = generationToProfileMediaCard({
      id: 'removed',
      output_url: 'https://cdn.example.com/removed.jpg',
      preview_url: 'https://cdn.example.com/removed.preview.webp',
      media: {
        id: 'removed', kind: 'image', url: 'https://cdn.example.com/removed.jpg',
        previewUrl: 'https://cdn.example.com/removed.preview.webp', gridReady: true, status: 'ready',
      } as GenerationListItem['media'],
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Removed still',
      archived_at: '2026-10-01T00:00:00.000Z',
      moderation_removed_at: '2026-10-01T00:00:00.000Z',
    });

    expect(card).toMatchObject({
      mediaUrl: null,
      previewUrl: null,
      previewState: 'artFallback',
      previewStatusLabel: 'Removed by moderation',
      moderationRemoved: true,
      isArchived: true,
      isGridReady: true,
    });
  });

  // A template's output has no prompt, so its tile read "Untitled creation" (audit 01-3).
  it("names a template's output by its template, and notes a run that ended without succeeding", () => {
    const base: GenerationListItem = {
      id: 'step',
      output_url: 'https://cdn.example.com/step.jpg',
      status: 'succeeded',
      created_at: '2026-06-10T10:00:00.000Z',
      model: 'template-workflow',
      category: 'image',
      prompt: null,
      origin: 'template',
      template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Product reveal', runStatus: 'cancelled' },
    };

    expect(generationToProfileMediaCard(base)).toMatchObject({
      title: 'Product reveal',
      templateNote: 'From template · run cancelled',
    });
    expect(generationToProfileMediaCard({
      ...base,
      template: { runId: 'run-1', templateId: 'template-1', templateTitle: null, runStatus: 'succeeded' },
    })).toMatchObject({ title: 'Template result', templateNote: null });
  });

  // The library sends a run's first file only, so the others were out of reach (audit 01-2).
  it('marks a run of several files with how many, and a run of one or a removed run with nothing', () => {
    const base: GenerationListItem = {
      id: 'takes',
      output_url: 'https://cdn.example.com/takes-0.jpg',
      status: 'succeeded',
      created_at: '2026-10-14T10:00:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      title: 'Four takes',
    };

    expect(generationToProfileMediaCard({ ...base, output_count: 4 }).outputCount).toBe(4);
    expect(generationToProfileMediaCard({ ...base, output_count: 1 }).outputCount).toBeNull();
    expect(generationToProfileMediaCard(base).outputCount).toBeNull();
    expect(generationToProfileMediaCard({
      ...base,
      output_count: 4,
      archived_at: '2026-10-01T00:00:00.000Z',
      moderation_removed_at: '2026-10-01T00:00:00.000Z',
    }).outputCount).toBeNull();
  });

  it('marks owner posts without usable preview content as not grid-ready', () => {
    const base: OwnerPostListItem = {
      id: 'post-base',
      title: 'Manual post',
      createdAt: '2026-06-10T10:00:00.000Z',
      visibility: 'public',
      mediaUrl: null,
      mediaKind: null,
      commentCount: 0,
      body: '',
      prompt: '',
      description: '',
      category: 'image',
      postFormat: 'media',
      bundle: null,
    };

    // An image carried on `posts.output_url` is grid-ready even with no
    // post_media descriptor. Publishing a generation produces exactly that shape
    // -- output_url set, zero post_media rows, so no preview is ever generated --
    // and requiring a descriptor here hid those posts from the mobile grid
    // permanently while the web profile still listed them. This matches the
    // showcase path, which treats a bare image mediaUrl as gridReady.
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'image-post',
      mediaUrl: 'https://cdn.example.com/post.jpg',
      mediaKind: 'image',
    })).toMatchObject({
      previewState: 'image',
      isGridReady: true,
    });
    // A video still needs a poster, so a bare mediaUrl is not enough.
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'video-post',
      mediaUrl: 'https://cdn.example.com/post.mp4',
      mediaKind: 'video',
    }).isGridReady).toBe(false);
    // Decision 10 (2026-10-17): a text post is labelled "Text", beside Image,
    // Video and Motion; "Prompt" names a real prompt only.
    expect(ownerPostToProfileMediaCard({
      ...base,
      id: 'text-post',
      body: 'A reusable note for framing a beauty product post.',
      category: 'text',
      postFormat: 'text',
    })).toMatchObject({
      previewState: 'text',
      isGridReady: true,
      badge: 'Text',
      mediaTypeLabel: 'Text',
    });
    expect(ownerPostToProfileMediaCard({ ...base, id: 'empty-media-post' }).isGridReady).toBe(false);
    // Archived posts stay renderable: the Posts tab shows them under their
    // own scope instead of dropping them, which used to leave no place to
    // restore from despite the archive dialog promising one.
    const archivedCard = ownerPostToProfileMediaCard({
      ...base,
      id: 'archived-post',
      mediaUrl: 'https://cdn.example.com/post.jpg',
      mediaKind: 'image',
      archivedAt: '2026-06-11T00:00:00.000Z',
    });
    expect(archivedCard.isGridReady).toBe(true);
    expect(archivedCard.isArchived).toBe(true);
  });
});

describe('the shape a Saved tile hands the zoom', () => {
  function savedVideo(media: Partial<ShowcaseMediaItem>): ShowcaseFeedItem {
    return {
      id: 'saved-video',
      mediaUrl: 'https://cdn.example.com/cats.mp4',
      mediaKind: 'video',
      model: 'kling-3.0-video',
      title: 'kungfu cats',
      prompt: 'Two cats spar in a wet street',
      body: '',
      category: 'video',
      postFormat: 'media',
      saveCount: 6,
      remixCount: 0,
      commentCount: 0,
      createdAt: '2026-09-01T10:00:00.000Z',
      creator: { id: 'creator-1', username: 'fluffy', name: 'fluffy', avatar: null },
      generationId: null,
      asset: null,
      canRemix: false,
      isSaved: true,
      mediaItems: [{
        id: 'saved-video:0',
        url: 'https://cdn.example.com/cats.mp4',
        previewUrl: 'https://cdn.example.com/cats.poster.webp',
        mediaKind: 'video',
        contentType: 'video/mp4',
        originalName: null,
        width: null,
        height: null,
        durationSeconds: 5,
        sortOrder: 0,
        ...media,
      }],
    };
  }

  /** What the reel reports once it mounts: the shape the flight is corrected to. */
  function reelShape(item: ShowcaseFeedItem) {
    return mediaItemAspectRatio(buildImmersiveShowcaseItems('profile-saved', [item])[0].mediaItems[0]);
  }

  it('is the media’s own shape, not the grid cell’s crop', () => {
    const item = savedVideo({ width: 720, height: 1280 });

    expect(showcaseToSavedProfileMediaCard(item).aspectRatio).toBe(720 / 1280);
  });

  it('reads the dimensions the way the reel does, so the flight is never corrected mid-air', () => {
    // A record and its descriptor that disagree (a rotated source): the reel
    // reads the descriptor first, and the tile must land on that same shape.
    const item = savedVideo({
      width: 1920,
      height: 1080,
      preview: {
        id: 'saved-video:0',
        kind: 'video',
        url: 'https://cdn.example.com/cats.mp4',
        previewUrl: 'https://cdn.example.com/cats.poster.webp',
        thumbhash: null,
        cacheKey: 'cats.poster',
        expiresAt: null,
        width: 1080,
        height: 1920,
        durationSeconds: 5,
        status: 'ready',
        gridReady: true,
      },
    });

    expect(showcaseToSavedProfileMediaCard(item).aspectRatio).toBe(reelShape(item));
    expect(reelShape(item)).toBe(1080 / 1920);
  });

  it('admits it does not know rather than guessing, so the flight falls back to the tile', () => {
    expect(showcaseToSavedProfileMediaCard(savedVideo({})).aspectRatio).toBeNull();
  });
});

describe('profile hero stats', () => {
  it('reports plain counts when every page is loaded', () => {
    expect(getProfileStats({ generationsCount: 3, postsCount: 2, savedCount: 1 })).toEqual([
      { label: 'Creations', value: '3' },
      { label: 'Posts', value: '2' },
      { label: 'Saved', value: '1' },
    ]);
  });

  it('marks a count as partial while that tab has more pages', () => {
    expect(getProfileStats({
      generationsCount: 24,
      generationsHasMore: true,
      postsCount: 2,
      postsHasMore: false,
      savedCount: 48,
      savedHasMore: true,
    })).toEqual([
      { label: 'Creations', value: '24+' },
      { label: 'Posts', value: '2' },
      { label: 'Saved', value: '48+' },
    ]);
  });
});

describe('profile stats from server totals', () => {
  it('draws the server total over whatever has been paged in, with no plus sign', () => {
    expect(getProfileStats({
      totals: { creations: 142, posts: 19, saved: 0 },
      generationsCount: 24,
      generationsHasMore: true,
      postsCount: 2,
      savedCount: 0,
      savedLoaded: false,
    })).toEqual([
      { label: 'Creations', value: '142' },
      { label: 'Posts', value: '19' },
      { label: 'Saved', value: '0' },
    ]);
  });

  it('draws a dash, never 0, for a library that has not answered and has no total', () => {
    expect(getProfileStats({
      totals: null,
      generationsCount: 0,
      generationsLoaded: false,
      postsCount: 0,
      postsLoaded: false,
      savedCount: 3,
      savedLoaded: true,
    })).toEqual([
      { label: 'Creations', value: UNKNOWN_PROFILE_STAT_VALUE },
      { label: 'Posts', value: UNKNOWN_PROFILE_STAT_VALUE },
      { label: 'Saved', value: '3' },
    ]);
  });
});

describe('the Posts scope counts', () => {
  it('reads Active and Archived from the server’s totals when the profile has them', () => {
    // The header's Posts stat is `stats.posts`; the chips under it agree with it
    // instead of counting the 24 tiles loaded so far.
    expect(getOwnerPostScopeCounts({ posts: 190, archivedPosts: 7 }, { active: 24, archived: 1 }))
      .toEqual({ active: 190, archived: 7 });
  });

  it('counts the loaded tiles without totals', () => {
    expect(getOwnerPostScopeCounts(null, { active: 2, archived: 1 })).toEqual({ active: 2, archived: 1 });
    expect(getOwnerPostScopeCounts(undefined, { active: 0, archived: 0 })).toEqual({ active: 0, archived: 0 });
  });
});

describe('the scope chips', () => {
  it('puts Failed between Active and Archived while a run failed', () => {
    expect(getProfileCreationsScopeOptions('active', { active: 27, failed: 7, archived: 2 })).toEqual([
      { value: 'active', label: 'Active (27)' },
      { value: 'failed', label: 'Failed (7)' },
      { value: 'archived', label: 'Archived (2)' },
    ]);
  });

  it('leaves Failed out when nothing failed, and Posts have no Failed to offer', () => {
    expect(getProfileCreationsScopeOptions('active', { active: 3, failed: 0, archived: 1 }).map((option) => option.value))
      .toEqual(['active', 'archived']);
    expect(getProfilePostsScopeOptions({ active: 3, archived: 1 })).toEqual([
      { value: 'active', label: 'Active (3)' },
      { value: 'archived', label: 'Archived (1)' },
    ]);
  });

  it('keeps Failed while it is the one chosen, after its last run is cleared', () => {
    expect(getProfileCreationsScopeOptions('failed', { active: 3, failed: 0, archived: 1 })).toEqual([
      { value: 'active', label: 'Active (3)' },
      { value: 'failed', label: 'Failed (0)' },
      { value: 'archived', label: 'Archived (1)' },
    ]);
  });

  it('names the chips without a count when none is known', () => {
    expect(getProfileCreationsScopeOptions('active').map((option) => option.label)).toEqual(['Active', 'Archived']);
    expect(getProfilePostsScopeOptions().map((option) => option.label)).toEqual(['Active', 'Archived']);
  });

  it('gives Posts no Failed scope, in their chips or their empty state', () => {
    // Held by the mobile typecheck, not at run time: each tab's scopes are its
    // own type, so handing Posts a Failed scope no longer compiles.
    expectTypeOf<'failed'>().not.toExtend<ProfilePostsScope>();
    expectTypeOf(getProfilePostsScopeOptions()).toEqualTypeOf<ProfileScopeOption<ProfilePostsScope>[]>();
    expectTypeOf(getProfileCreationsScopeOptions('failed')).not.toExtend<readonly ProfileScopeOption<ProfilePostsScope>[]>();
    expectTypeOf<['Posts', 'failed']>().not.toExtend<Parameters<typeof getProfileMediaEmptyTitle>>();
    expectTypeOf<['Posts', 'failed']>().not.toExtend<Parameters<typeof getProfileMediaEmptyBody>>();
    // And none of that is vacuous: Creations hold Failed, Posts their own two.
    expectTypeOf(getProfileCreationsScopeOptions('failed')).toEqualTypeOf<ProfileScopeOption<ProfileCreationsScope>[]>();
    expectTypeOf<['Creations', 'failed']>().toExtend<Parameters<typeof getProfileMediaEmptyTitle>>();
    expectTypeOf<['Posts', 'archived']>().toExtend<Parameters<typeof getProfileMediaEmptyBody>>();
  });

  it('names the empty Failed scope apart from the empty library', () => {
    expect(getProfileMediaEmptyTitle('Creations', 'failed')).toBe('No failed creations');
    expect(getProfileMediaEmptyTitle('Creations', 'archived')).toBe('No archived creations');
    expect(getProfileMediaEmptyTitle('Creations')).toBe('No creations yet');
    expect(getProfileMediaEmptyTitle('Posts', 'archived')).toBe('No archived posts');
  });

  it('never promises an empty Failed scope that it will fill', () => {
    expect(getProfileMediaEmptyBody('Creations', 'failed')).toBe('A run that fails shows here. Open it to see what went wrong.');
    expect(getProfileMediaEmptyBody('Creations', 'archived')).toBe(PROFILE_MEDIA_EMPTY_BODY);
    expect(getProfileMediaEmptyBody('Creations')).toBe(PROFILE_MEDIA_EMPTY_BODY);
    expect(getProfileMediaEmptyBody('Saved')).toBe(PROFILE_MEDIA_EMPTY_BODY);
  });

  it("marks a failed run's card, the Failed scope's row, and no other", () => {
    const run = (status: string) => generationToProfileMediaCard({ id: `run-${status}`, status, output_url: null, category: 'image', title: 'Try' } as GenerationListItem);

    expect(run('failed').runFailed).toBe(true);
    expect(run('succeeded').runFailed).toBe(false);
    expect(run('processing').runFailed).toBe(false);
  });
});

describe('the signed-out sample tiles', () => {
  it('open where each kind of item is found or made, and the Post sample never opens Your Sales', () => {
    expect(FALLBACK_PROFILE_MEDIA.map(({ label, href }) => [label, href])).toEqual([
      ['Saved', '/showcase'],
      ['Creation', '/(tabs)/creator'],
      ['Post', '/post/new'],
    ]);
  });
});

// 03-2: the Wallet card draws the payout state's withdrawable balance, not the
// lifetime earnings a payout request never lowers.
describe('the Wallet card', () => {
  it('shows the balance that can be withdrawn, and says so', () => {
    expect(getWalletCardContent({ data: { availableUsd: '$4.25' }, isError: false })).toEqual({
      value: '$4.25',
      caption: 'Available to withdraw',
      accessibilityLabel: 'Wallet, $4.25 available to withdraw',
    });
  });

  it('draws the unknown dash until the payout state answers', () => {
    for (const data of [undefined, null]) {
      expect(getWalletCardContent({ data, isError: false })).toEqual({
        value: UNKNOWN_PROFILE_STAT_VALUE,
        caption: 'Available to withdraw',
        accessibilityLabel: 'Wallet, balance loading',
      });
    }
  });

  it('says the balance is unavailable when the read fails, over any balance read before it', () => {
    const unavailable = {
      value: UNKNOWN_PROFILE_STAT_VALUE,
      caption: 'Balance unavailable',
      accessibilityLabel: 'Wallet, balance unavailable',
    };
    expect(getWalletCardContent({ data: undefined, isError: true })).toEqual(unavailable);
    expect(getWalletCardContent({ data: { availableUsd: '$40.00' }, isError: true })).toEqual(unavailable);
  });
});

describe('sharing your own profile', () => {
  it('files the share as the owner’s own and marks the link with it', () => {
    expect(OWN_PROFILE_SHARE_SOURCE).toBe('profile');
    expect(ownProfileShareUrl('https://magicbooklet.com/', 'luna-dreams'))
      .toBe('https://magicbooklet.com/creators/luna-dreams?s=profile');
    expect(ownProfileShareUrl('https://magicbooklet.com', 'a b')).toBe('https://magicbooklet.com/creators/a%20b?s=profile');
  });
});
