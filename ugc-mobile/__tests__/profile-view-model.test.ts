import { describe, expect, it } from 'vitest';

import {
  FALLBACK_PROFILE_MEDIA,
  getProfileHandle,
  getProfileInitials,
  getProfileMediaEmptyTitle,
  getProfileMediaSectionTitle,
  getProfileMediaSwipeTarget,
  getProfileName,
  getProfileStats,
  generationToProfileMediaCard,
  ownerPostToProfileMediaCard,
  savedShowcaseToProfileMediaCards,
} from '../lib/profile-view-model';

describe('profile view model', () => {
  it('derives a creator name, handle, and initials from profile data', () => {
    const profile = {
      id: 'user-1',
      username: 'luna_dreams',
      displayName: 'Luna Dreams',
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
      credits: 6,
    };

    expect(getProfileName(profile, 'luna@example.com')).toBe('Luna Dreams');
    expect(getProfileHandle(profile, 'luna@example.com')).toBe('@luna_dreams');
    expect(getProfileInitials(profile, 'luna@example.com')).toBe('LD');
  });

  it('falls back to the email identity when profile fields are empty', () => {
    expect(getProfileName(null, 'creator@example.com')).toBe('creator');
    expect(getProfileHandle(null, 'creator@example.com')).toBe('@creator');
    expect(getProfileInitials(null, 'creator@example.com')).toBe('C');
  });

  it('ignores numeric slug fragments when deriving profile initials', () => {
    const profile = {
      id: 'user-1',
      username: 'creator-28677503',
      displayName: null,
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
      credits: 6,
    };

    expect(getProfileInitials(profile, 'test@gmail.com')).toBe('C');
  });

  it('summarizes profile counts across generations, posts, and saved showcase items', () => {
    expect(getProfileStats({
      generationsCount: 4,
      postsCount: 2,
      savedCount: 3,
    })).toEqual([
      { label: 'Creations', value: '4' },
      { label: 'Posts', value: '2' },
      { label: 'Saved', value: '3' },
    ]);
  });

  it('labels the profile media tabs with matching section and empty-state copy', () => {
    expect(getProfileMediaSectionTitle('Saved')).toBe('Saved Media');
    expect(getProfileMediaSectionTitle('Creations')).toBe('Creations');
    expect(getProfileMediaSectionTitle('Posts')).toBe('Posts');

    expect(getProfileMediaEmptyTitle('Saved')).toBe('No saved media yet');
    expect(getProfileMediaEmptyTitle('Creations')).toBe('No creations yet');
    expect(getProfileMediaEmptyTitle('Posts')).toBe('No posts yet');
  });

  it('selects the next profile media tab from swipe direction without wrapping', () => {
    expect(getProfileMediaSwipeTarget('Saved', 'left')).toBe('Creations');
    expect(getProfileMediaSwipeTarget('Creations', 'left')).toBe('Posts');
    expect(getProfileMediaSwipeTarget('Posts', 'left')).toBe('Posts');

    expect(getProfileMediaSwipeTarget('Posts', 'right')).toBe('Creations');
    expect(getProfileMediaSwipeTarget('Creations', 'right')).toBe('Saved');
    expect(getProfileMediaSwipeTarget('Saved', 'right')).toBe('Saved');
  });

  it('normalizes owner posts and saved showcase cards for profile media tabs', () => {
    expect(ownerPostToProfileMediaCard({
      id: 'post-1',
      title: 'Portal Pack',
      createdAt: '2026-05-13T10:00:00.000Z',
      visibility: 'public',
      mediaUrl: null,
      mediaKind: 'image',
      body: 'Reusable launch hooks for creators.',
      category: 'text',
      postFormat: 'text',
      bundle: {
        id: 'bundle-1',
        accessMode: 'paid',
        status: 'published',
        priceUsdCents: 900,
        salesCount: 2,
        earningsUsdCents: 1800,
        resourceKinds: ['prompt'],
      },
    })).toMatchObject({
      id: 'post-1',
      title: 'Portal Pack',
      label: 'Post',
      meta: 'public',
      previewKind: 'text',
      previewText: 'Reusable launch hooks for creators.',
      badge: '$9',
      countLabel: '0',
      artVariant: 'portal',
      viewerSource: 'profile-posts',
      sourceId: 'post-1',
    });

    const savedCards = savedShowcaseToProfileMediaCards([
      {
        id: 'saved-1',
        mediaUrl: null,
        mediaKind: 'image',
        model: 'manual',
        title: 'Saved Island',
        prompt: 'Prompt',
        body: '',
        category: 'image',
        postFormat: 'media',
        saveCount: 10,
        remixCount: 1,
        createdAt: '2026-05-13T10:00:00.000Z',
        creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
        isSaved: true,
        generationId: null,
        asset: null,
        canRemix: false,
      },
      {
        id: 'unsaved-1',
        mediaUrl: null,
        mediaKind: null,
        model: 'manual',
        title: 'Unsaved',
        prompt: 'Prompt',
        body: '',
        category: 'text',
        postFormat: 'text',
        saveCount: 0,
        remixCount: 0,
        createdAt: '2026-05-13T10:00:00.000Z',
        creator: { id: 'creator-2', username: null, name: 'Nova', avatar: null },
        isSaved: false,
        generationId: null,
        asset: null,
        canRemix: false,
      },
    ]);

    expect(savedCards).toHaveLength(1);
    expect(savedCards[0]).toMatchObject({
      id: 'saved-1',
      title: 'Saved Island',
      label: 'Saved',
      avatarUrl: null,
      avatarLabel: 'Luna',
      countLabel: '10',
      artVariant: 'tree',
      viewerSource: 'profile-saved',
      sourceId: 'saved-1',
    });
    expect(FALLBACK_PROFILE_MEDIA).toHaveLength(3);
  });

  it('keeps text generations visible as text preview tiles', () => {
    expect(generationToProfileMediaCard({
      id: 'text-1',
      output_url: null,
      status: 'succeeded',
      created_at: '2026-05-13T11:00:00.000Z',
      model: 'copy-model',
      category: 'text',
      title: 'Caption set',
      prompt: 'Write three launch captions',
    })).toMatchObject({
      id: 'text-1',
      title: 'Caption set',
      mediaKind: null,
      previewKind: 'text',
      previewText: 'Write three launch captions',
      artVariant: 'tree',
      viewerSource: 'profile-creations',
      sourceId: 'text-1',
    });
  });

  it('treats motion creations as video-backed profile previews', () => {
    expect(generationToProfileMediaCard({
      id: 'motion-1',
      output_url: 'https://example.com/motion.mp4',
      status: 'succeeded',
      created_at: '2026-05-13T11:00:00.000Z',
      model: 'motion-model',
      category: 'motion',
      title: 'Runner loop',
      prompt: 'Make the subject sprint through neon lights',
    })).toMatchObject({
      id: 'motion-1',
      mediaKind: 'video',
      mediaUrl: 'https://example.com/motion.mp4',
      artVariant: 'runner',
      viewerSource: 'profile-creations',
      sourceId: 'motion-1',
    });
  });
});
