import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OWNER_PAGE_EDIT_MEMORY_MS,
  clearOwnerPageEditsForTests,
  rememberOwnerCreatorProfile,
  rememberOwnerPostVisibility,
  useOwnerCreatorProfile,
  useOwnerPostVisibility,
} from '@/lib/owner-page-edits';
import type { EditableCreatorProfile } from '@/lib/profile';

function PostVisibility({ postId, owner, testId }: { postId: string; owner: boolean; testId?: string }) {
  return <span data-testid={testId ?? 'visibility'}>{useOwnerPostVisibility(postId, owner) ?? 'as cached'}</span>;
}

function CreatorProfile({ creatorId, owner }: { creatorId: string; owner: boolean }) {
  const profile = useOwnerCreatorProfile(creatorId, owner);
  return <span data-testid="profile">{profile ? JSON.stringify(profile) : 'as cached'}</span>;
}

const savedProfile: EditableCreatorProfile = {
  id: 'creator-1',
  username: 'creator-name',
  displayName: 'New Name',
  bio: 'New bio',
  avatarUrl: 'https://cdn.example.com/avatars/creator-1.webp',
  coverUrl: '',
  websiteUrl: 'https://creator.example.com',
  twitterHandle: '',
  instagramHandle: 'new.art',
  tiktokHandle: '',
  location: 'Pune',
  credits: 120,
  promotionalCredits: 20,
  marketplaceSpendableCredits: 100,
};

describe('what an owner has just saved on a cached page', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearOwnerPageEditsForTests();
  });

  it("is the post's owner's alone, and that post's alone", () => {
    rememberOwnerPostVisibility('post-1', 'public');
    render(
      <>
        <PostVisibility postId="post-1" owner testId="owner" />
        <PostVisibility postId="post-1" owner={false} testId="someone-else" />
        <PostVisibility postId="post-2" owner testId="another-post" />
      </>,
    );

    expect(screen.getByTestId('owner')).toHaveTextContent('public');
    expect(screen.getByTestId('someone-else')).toHaveTextContent('as cached');
    expect(screen.getByTestId('another-post')).toHaveTextContent('as cached');
  });

  it('is never read on the server, so no cached page can carry it', () => {
    rememberOwnerPostVisibility('post-1', 'public');
    rememberOwnerCreatorProfile(savedProfile);

    expect(renderToString(<PostVisibility postId="post-1" owner />)).toContain('as cached');
    expect(renderToString(<CreatorProfile creatorId="creator-1" owner />)).toContain('as cached');
  });

  it('moves a page already drawn, and is forgotten ten minutes after the save', () => {
    vi.useFakeTimers();
    render(<PostVisibility postId="post-1" owner />);
    expect(screen.getByTestId('visibility')).toHaveTextContent('as cached');

    act(() => rememberOwnerPostVisibility('post-1', 'unlisted'));
    expect(screen.getByTestId('visibility')).toHaveTextContent('unlisted');

    act(() => vi.advanceTimersByTime(OWNER_PAGE_EDIT_MEMORY_MS - 1));
    expect(screen.getByTestId('visibility')).toHaveTextContent('unlisted');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('visibility')).toHaveTextContent('as cached');
  });

  it('counts the ten minutes from the latest save', () => {
    vi.useFakeTimers();
    render(<PostVisibility postId="post-1" owner />);

    act(() => rememberOwnerPostVisibility('post-1', 'unlisted'));
    act(() => vi.advanceTimersByTime(OWNER_PAGE_EDIT_MEMORY_MS / 2));
    act(() => rememberOwnerPostVisibility('post-1', 'public'));
    act(() => vi.advanceTimersByTime(OWNER_PAGE_EDIT_MEMORY_MS / 2));
    expect(screen.getByTestId('visibility')).toHaveTextContent('public');

    act(() => vi.advanceTimersByTime(OWNER_PAGE_EDIT_MEMORY_MS / 2));
    expect(screen.getByTestId('visibility')).toHaveTextContent('as cached');
  });

  it("keeps a saved profile's public fields only, worded as the page's own read words them", () => {
    // A name left blank reads as the handle, as `getCreatorProfilePageData` gives it.
    rememberOwnerCreatorProfile({ ...savedProfile, displayName: '  ' });
    render(<CreatorProfile creatorId="creator-1" owner />);

    expect(JSON.parse(screen.getByTestId('profile').textContent ?? '')).toEqual({
      id: 'creator-1',
      username: 'creator-name',
      displayName: 'creator-name',
      bio: 'New bio',
      avatarUrl: 'https://cdn.example.com/avatars/creator-1.webp',
      coverUrl: null,
      websiteUrl: 'https://creator.example.com',
      twitterHandle: null,
      instagramHandle: 'new.art',
      tiktokHandle: null,
      location: 'Pune',
    });
  });

  it("gives the profile to the creator only", () => {
    rememberOwnerCreatorProfile(savedProfile);
    render(<CreatorProfile creatorId="creator-1" owner={false} />);

    expect(screen.getByTestId('profile')).toHaveTextContent('as cached');
  });
});
