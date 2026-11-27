import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeferredCreatorProfileCard from '@/app/profile/DeferredCreatorProfileCard';
import type { EditableCreatorProfile } from '@/lib/profile';

// What comes under the profile editor (Connected apps on /profile/edit, the one place to disconnect
// an agent) waits in the editor's own boundary, so an editor that failed to draw took it down too,
// and the page with it: `src/app` had no error.tsx (review of #841; the root one, added 2026-11-27,
// would still replace the whole page). The card's boundary keeps the
// failure to the editor: an error card whose Try again reloads the page, and what comes under it
// still drawn. A reload, as Alerts' card does: it fetches the chunk names of the deployment that is
// live now, where Turbopack's runtime in production hands an in-place retry the same failed load.
// The editor here throws as it draws, which the boundary meets as it meets a rejected import of its
// code (a module mock whose factory throws is not steady under vitest, as the Alerts half's test
// found); tests/e2e/profile-edit-arrival.spec.ts fails the code's own request in a browser.

vi.mock('@/app/creations/CreatorProfileCard', () => ({
  default: () => {
    throw new Error('Loading chunk app_creations_CreatorProfileCard_tsx failed.');
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
  const reload = vi.fn();
  // Where Sentry's global handler hears an error (jsdom has no reportError of its own).
  const reportError = vi.fn();

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    reload.mockReset();
    reportError.mockReset();
    vi.stubGlobal('location', { reload });
    vi.stubGlobal('reportError', reportError);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  it('draws an error card over what comes under the editor, and Try again reloads the page', async () => {
    render(
      <DeferredCreatorProfileCard initialProfile={profile} loadError={null}>
        <section aria-label="Connected apps" />
      </DeferredCreatorProfileCard>
    );
    // Past the idle wait (jsdom has no requestIdleCallback: 650 ms).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    const card = await screen.findByRole('alert');
    expect(card).toHaveTextContent('The profile editor did not load.');
    expect(card).toHaveTextContent('Try again reloads the page.');
    const below = screen.getByRole('region', { name: 'Connected apps' });
    expect(card.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Loading the profile editor' })).not.toBeInTheDocument();
    // Caught and logged, not thrown out of the page, and handed on to reportError as Next's own
    // boundary would have, so Sentry hears it.
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load the profile editor:',
      expect.objectContaining({ message: 'Loading chunk app_creations_CreatorProfileCard_tsx failed.' }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Loading chunk app_creations_CreatorProfileCard_tsx failed.' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reload).toHaveBeenCalledTimes(1);
    // No retry in place: the card and what is under it stay until the reload.
    expect(screen.getByRole('alert')).toHaveTextContent('The profile editor did not load.');
    expect(screen.getByRole('region', { name: 'Connected apps' })).toBe(below);
  });
});
