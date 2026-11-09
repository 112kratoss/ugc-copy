import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DeferredCreatorProfileCard from '@/app/profile/DeferredCreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

// The editor's code arrives only when the test says so.
const editorDownload = vi.hoisted(() => {
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { finished, finish: () => finish() };
});

vi.mock('@/app/creations/CreatorProfileCard', async () => {
  await editorDownload.finished;
  return {
    default: ({ initialProfile }: { initialProfile: EditableCreatorProfile | null }) => (
      <form aria-label="Profile editor">{initialProfile?.displayName}</form>
    ),
  };
});

const profile: EditableCreatorProfile = {
  id: 'user-1',
  username: 'test-creator',
  displayName: 'Test Creator',
  bio: 'Short clips.',
  avatarUrl: '',
  coverUrl: '',
  websiteUrl: '',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
  location: '',
  credits: 10,
};

describe('DeferredCreatorProfileCard', () => {
  // Between the idle wait and the editor's code arriving the page drew
  // nothing at all (`dynamic` had no loading component).
  it('keeps the skeleton up while the editor code downloads, then draws the editor', async () => {
    render(<DeferredCreatorProfileCard initialProfile={profile} loadError={null} />);

    const skeleton = await screen.findByRole('region', { name: 'Loading the profile editor' });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveTextContent('Test Creator');
    // Past the idle wait (jsdom has no requestIdleCallback: 650 ms), the
    // editor's code is asked for and the skeleton stays while it downloads.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(screen.getByRole('region', { name: 'Loading the profile editor' })).toHaveTextContent('Test Creator');
    expect(screen.queryByRole('form', { name: 'Profile editor' })).not.toBeInTheDocument();

    await act(async () => {
      editorDownload.finish();
    });

    expect(await screen.findByRole('form', { name: 'Profile editor' })).toHaveTextContent('Test Creator');
    expect(screen.queryByRole('region', { name: 'Loading the profile editor' })).not.toBeInTheDocument();
  });
});
