import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeferredCreatorProfileCard from '@/app/profile/DeferredCreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

// What comes under the profile editor (Connected apps on /profile/edit, the one place to disconnect
// an agent) waits in the editor's own boundary, so an editor that failed to draw took it down too,
// and the page with it: `src/app` has no error.tsx (review of #841). The card's boundary keeps the
// failure to the editor: an error card with Try again, and what comes under it still drawn. The
// editor here throws as it draws, which the boundary meets as it meets a rejected import of its
// code (a module mock whose factory throws is not steady under vitest, as the Alerts half's test
// found); tests/e2e/profile-edit-arrival.spec.ts fails the code's own request in a browser.

const editor = vi.hoisted(() => ({ broken: true }));

vi.mock('@/app/creations/CreatorProfileCard', () => ({
  default: ({ initialProfile }: { initialProfile: EditableCreatorProfile | null }) => {
    if (editor.broken) throw new Error('Loading chunk app_creations_CreatorProfileCard_tsx failed.');
    return <form aria-label="Profile editor">{initialProfile?.displayName}</form>;
  },
}));

const profile: EditableCreatorProfile = {
  id: 'user-1',
  username: 'test-creator',
  displayName: 'Test Creator',
  bio: '',
  avatarUrl: '',
  coverUrl: '',
  websiteUrl: '',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
  location: '',
  credits: 10,
};

describe('DeferredCreatorProfileCard when the editor does not draw', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  // Where Sentry's global handler hears an error (jsdom has no reportError of its own).
  const reportError = vi.fn();

  beforeEach(() => {
    editor.broken = true;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportError.mockReset();
    vi.stubGlobal('reportError', reportError);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  it('draws an error card with Try again over what comes under the editor, and Try again draws the editor', async () => {
    render(
      <DeferredCreatorProfileCard initialProfile={profile} loadError={null}>
        <section aria-label="Connected apps" />
      </DeferredCreatorProfileCard>
    );
    // Past the idle wait (jsdom has no requestIdleCallback: 650 ms).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The profile editor did not load.');
    expect(screen.getByRole('region', { name: 'Connected apps' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Profile editor' })).not.toBeInTheDocument();
    // Caught and logged, not thrown out of the page, and handed on to reportError as Next's own
    // boundary would have, so Sentry hears it.
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load the profile editor:',
      expect.objectContaining({ message: 'Loading chunk app_creations_CreatorProfileCard_tsx failed.' }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Loading chunk app_creations_CreatorProfileCard_tsx failed.' }),
    );

    editor.broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    const form = await screen.findByRole('form', { name: 'Profile editor' });
    expect(form).toHaveTextContent('Test Creator');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const below = screen.getByRole('region', { name: 'Connected apps' });
    expect(form.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
