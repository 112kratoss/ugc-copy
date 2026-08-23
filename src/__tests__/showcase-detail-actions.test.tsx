import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  requestPostVisibilityChange: vi.fn(),
  requestPostArchive: vi.fn(),
  requestPostRestore: vi.fn(),
  requestPostDelete: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
  usePathname: () => '/showcase/post-1',
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'token', user: { id: 'owner-1' } },
    user: { id: 'owner-1' },
  }),
}));

vi.mock('@/app/components/PublicShareButton', () => ({
  default: () => <button type="button">Share</button>,
}));

vi.mock('@/lib/post-lifecycle-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-lifecycle-client')>()),
  ...clientMocks,
}));

import FeedbackViewport from '@/app/components/FeedbackViewport';
import { resetFeedbackState } from '@/app/components/feedback-state';
import ShowcaseDetailActions from '@/app/showcase/[id]/ShowcaseDetailActions';

function renderOwnerTools(overrides: Partial<React.ComponentProps<typeof ShowcaseDetailActions>> = {}) {
  return render(
    <>
      <ShowcaseDetailActions
        postId="post-1"
        generationId="gen-1"
        title="Sunset study"
        description="A study of light."
        creatorUsername="creator"
        canRemix={false}
        visibility="public"
        viewerIsOwner
        hasResourceBundle
        bundle={{ accessMode: 'paid', status: 'published', salesCount: 0 }}
        {...overrides}
      />
      <FeedbackViewport />
    </>,
  );
}

describe('ShowcaseDetailActions owner tools', () => {
  beforeEach(() => {
    clientMocks.requestPostVisibilityChange.mockReset();
    clientMocks.requestPostArchive.mockReset();
    clientMocks.requestPostDelete.mockReset();
    routerMocks.push.mockReset();
    routerMocks.refresh.mockReset();
  });

  afterEach(() => {
    resetFeedbackState();
  });

  it('offers the same three-state visibility menu as Studio and refreshes after a public change', async () => {
    clientMocks.requestPostVisibilityChange.mockResolvedValue({
      visibility: 'unlisted',
      ownerPath: '/post/post-1/edit',
      showcasePath: '/showcase/post-1',
      resourceBundleStatus: 'draft',
    });
    renderOwnerTools();

    const trigger = screen.getByRole('button', { name: 'Visibility of Sunset study: Public' });
    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /unlisted/i }));

    // The recipe is listed, so policy asks before the post leaves public —
    // and nothing moves until the answer.
    const dialog = await screen.findByRole('alertdialog', { name: 'Make this post unlisted?' });
    expect(dialog).toHaveAccessibleDescription(
      'Its recipe comes off the marketplace and goes back to draft. Making the post public again does not relist it — save it from the editor to relist.',
    );
    expect(clientMocks.requestPostVisibilityChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Visibility of Sunset study: Public' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make unlisted' }));

    await waitFor(() => {
      expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledWith({
        post: expect.objectContaining({ id: 'post-1', generationId: 'gen-1', visibility: 'public' }),
        visibility: 'unlisted',
        accessToken: 'token',
      });
    });
    await waitFor(() => {
      expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    });
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Visibility of Sunset study: Unlisted' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Post is unlisted.');
  });

  it('leaves the public page for the editor once a post is private', async () => {
    clientMocks.requestPostVisibilityChange.mockResolvedValue({
      visibility: 'private',
      ownerPath: '/post/post-1/edit',
      showcasePath: null,
      resourceBundleStatus: 'draft',
    });
    renderOwnerTools();

    fireEvent.click(screen.getByRole('button', { name: 'Visibility of Sunset study: Public' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /private/i }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Make this post private?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }));

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/post/post-1/edit');
    });
    expect(routerMocks.refresh).not.toHaveBeenCalled();
  });

  it('changes visibility in one click when no recipe is listed', async () => {
    clientMocks.requestPostVisibilityChange.mockResolvedValue({
      visibility: 'private',
      ownerPath: '/post/post-1/edit',
      showcasePath: null,
      resourceBundleStatus: null,
    });
    renderOwnerTools({ bundle: null, hasResourceBundle: false });

    fireEvent.click(screen.getByRole('button', { name: 'Visibility of Sunset study: Public' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /private/i }));

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/post/post-1/edit');
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('confirms in the shared dialog before archiving, then goes to the archived list', async () => {
    clientMocks.requestPostArchive.mockResolvedValue(undefined);
    renderOwnerTools();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive this post?' });
    expect(clientMocks.requestPostArchive).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(clientMocks.requestPostArchive).toHaveBeenCalledWith({ postId: 'post-1', accessToken: 'token' });
    });
    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/creations?view=posts&visibility=archived');
    });
  });

  it('cancelling the delete confirmation makes no request', async () => {
    renderOwnerTools();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this post permanently?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(clientMocks.requestPostDelete).not.toHaveBeenCalled();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('returns to Post Library after a delete', async () => {
    clientMocks.requestPostDelete.mockResolvedValue({ deleted: true, tombstoned: false });
    renderOwnerTools({ bundle: null, hasResourceBundle: false });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/creations?view=posts');
    });
  });

  it('hides the owner tools from other viewers', () => {
    renderOwnerTools({ viewerIsOwner: false });
    expect(screen.queryByText('Owner tools')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /visibility of/i })).not.toBeInTheDocument();
  });
});
