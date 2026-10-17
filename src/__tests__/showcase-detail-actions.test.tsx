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

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'token', user: { id: 'owner-1' } },
    user: { id: 'owner-1' },
  }),
}));

vi.mock('@/lib/post-lifecycle-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-lifecycle-client')>()),
  ...clientMocks,
}));

import FeedbackViewport from '@/components/FeedbackViewport';
import { resetFeedbackState } from '@/components/feedback-state';
import ShowcaseDetailActions from '@/app/showcase/[id]/ShowcaseDetailActions';

function renderOwnerTools(overrides: Partial<React.ComponentProps<typeof ShowcaseDetailActions>> = {}) {
  return render(
    <>
      <ShowcaseDetailActions
        postId="post-1"
        generationId="gen-1"
        title="Sunset study"
        creatorUsername="creator"
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

  // A post is public or private since 2026-10-17 (decision 12). A page drawn
  // for a post saved as unlisted before then reads it as private, and making
  // it public keeps the viewer on the post, refreshed.
  it('offers the same public or private menu as Studio and refreshes after a public change', async () => {
    clientMocks.requestPostVisibilityChange.mockResolvedValue({
      visibility: 'public',
      ownerPath: '/post/post-1/edit',
      showcasePath: '/showcase/post-1',
      resourceBundleStatus: 'published',
    });
    renderOwnerTools({ visibility: 'unlisted', bundle: { accessMode: 'paid', status: 'draft', salesCount: 0 } });

    const trigger = screen.getByRole('button', { name: 'Visibility of Sunset study: Private' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitemradio', { name: /unlisted/i })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /public/i }));

    await waitFor(() => {
      expect(clientMocks.requestPostVisibilityChange).toHaveBeenCalledWith({
        post: expect.objectContaining({ id: 'post-1', generationId: 'gen-1', visibility: 'unlisted' }),
        visibility: 'public',
        accessToken: 'token',
      });
    });
    await waitFor(() => {
      expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    });
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Visibility of Sunset study: Public' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Post is public.');
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
