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
  // nothing at all (`dynamic` had no loading component). And what the page
  // draws under the editor (Connected apps on /profile/edit) was drawn under
  // the much shorter skeleton, then pushed off the screen by the editor
  // (2026-11-17): it is drawn with the editor now, never before it.
  it('keeps the skeleton up while the editor code downloads, then draws the editor and what comes under it', async () => {
    render(
      <DeferredCreatorProfileCard initialProfile={profile} loadError={null}>
        <section aria-label="Connected apps" />
      </DeferredCreatorProfileCard>
    );

    const skeleton = await screen.findByRole('region', { name: 'Loading the profile editor' });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveTextContent('Test Creator');
    expect(screen.queryByRole('region', { name: 'Connected apps' })).not.toBeInTheDocument();
    // Past the idle wait (jsdom has no requestIdleCallback: 650 ms), the
    // editor's code is asked for and the skeleton stays while it downloads.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(screen.getByRole('region', { name: 'Loading the profile editor' })).toHaveTextContent('Test Creator');
    expect(screen.queryByRole('form', { name: 'Profile editor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Connected apps' })).not.toBeInTheDocument();

    await act(async () => {
      editorDownload.finish();
    });

    const editor = await screen.findByRole('form', { name: 'Profile editor' });
    expect(editor).toHaveTextContent('Test Creator');
    expect(screen.queryByRole('region', { name: 'Loading the profile editor' })).not.toBeInTheDocument();
    const below = screen.getByRole('region', { name: 'Connected apps' });
    expect(editor.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
