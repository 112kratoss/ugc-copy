import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ShowcaseDetailCommentCountProvider,
  ShowcaseDetailComments,
} from '@/app/showcase/[id]/ShowcaseDetailCommentCount';
import ShowcaseDetailEngagementRow from '@/app/showcase/[id]/ShowcaseDetailEngagementRow';
import NsfwPostReveal from '@/components/NsfwPostReveal';
import { dismissToast, readFeedbackSnapshot, resetFeedbackState, subscribeToFeedback } from '@/components/feedback-state';
import { SAVER_NOTICE_MESSAGE, resetSaverNoticeForTests } from '@/components/saver-notice';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const pushMock = routerMock.push;
const useAuthMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: () => <button type="button">Share</button>,
}));

vi.mock('@/lib/showcase-remix-client', () => ({
  requestShowcaseRemix: vi.fn(async () => ({ redirectTo: '/create-image?remix=1' })),
}));

// The thread reports its count the way `PostComments` does: through the
// `onCommentCountChange` it is handed, after a post or a delete lands.
vi.mock('@/components/PostComments', () => ({
  default: ({ onCommentCountChange }: { onCommentCountChange?: (count: number) => void }) => (
    <div>
      <button type="button" onClick={() => onCommentCountChange?.(1)}>Post a comment</button>
      <button type="button" onClick={() => onCommentCountChange?.(0)}>Delete the comment</button>
    </div>
  ),
}));

function rowProps(overrides: Partial<Parameters<typeof ShowcaseDetailEngagementRow>[0]> = {}) {
  return {
    postId: 'post-1',
    generationId: 'gen-1',
    title: 'Shared creation',
    shareDescription: 'A description.',
    canRemix: true,
    saveCount: 4,
    commentCount: 0,
    remixCount: 2,
    shareVisitCount: 9,
    showComments: true,
    ...overrides,
  };
}

describe('ShowcaseDetailEngagementRow', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      user: { id: 'viewer-1' },
      session: { access_token: 'token-1' },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ success: true, isSaved: true, saveCount: 5 }) } as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetSaverNoticeForTests();
    resetFeedbackState();
    window.localStorage.clear();
  });

  it('renders the verbs with compact counts and the comment anchor', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps()} />);

    expect(screen.getByRole('button', { name: /remix · 2/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save shared creation/i })).toHaveTextContent('4');
    expect(screen.getByRole('link', { name: /comment/i })).toHaveAttribute('href', '#comments');
    expect(screen.getByTitle('9 visits')).toBeInTheDocument();
  });

  it('saves optimistically through the showcase save endpoint', async () => {
    // This viewer was told on an earlier page, as the page was drawn knowing,
    // so the save may name them.
    useAuthMock.mockReturnValue({
      user: { id: 'viewer-1' },
      session: { access_token: 'token-1' },
      saverNoticeRecord: { userId: 'viewer-1', seen: true },
    });
    render(<ShowcaseDetailEngagementRow {...rowProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /save shared creation/i }));

    // Optimistic flip lands before the network settles.
    expect(screen.getByRole('button', { name: /remove save from shared creation/i })).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/showcase/save', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ postId: 'post-1', shouldSave: true, sourceSurface: 'detail-page', creatorSeesSaver: true }),
      }));
    });

    // The server's authoritative count replaces the optimistic one.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove save from shared creation/i })).toHaveTextContent('5');
    });
  });

  it('tells a viewer at their first save, keeps the creator out of their saves until the notice goes, then names them', async () => {
    // The root layout's FeedbackViewport, which draws the toast.
    const unsubscribe = subscribeToFeedback(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (String(input) === '/api/profile/saver-notice') {
        return { ok: true, json: async () => ({ seen: init?.method === 'POST' }) } as Response;
      }
      const { shouldSave } = JSON.parse(String(init?.body)) as { shouldSave: boolean };
      return { ok: true, json: async () => ({ success: true, isSaved: shouldSave, saveCount: shouldSave ? 5 : 4 }) } as Response;
    }));
    const saveBodies = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input) === '/api/showcase/save')
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    const tapSave = async (count: number) => {
      fireEvent.click(screen.getByRole('button', { name: /^save shared creation/i }));
      await waitFor(() => expect(saveBodies()).toHaveLength(count));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove save from shared creation/i })).not.toBeDisabled();
      });
    };
    const tapUnsave = async (count: number) => {
      fireEvent.click(screen.getByRole('button', { name: /remove save from shared creation/i }));
      await waitFor(() => expect(saveBodies()).toHaveLength(count));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^save shared creation/i })).not.toBeDisabled();
      });
    };

    try {
      render(<ShowcaseDetailEngagementRow {...rowProps()} />);

      await tapSave(1);
      expect(readFeedbackSnapshot().toasts.map((toast) => toast.message)).toEqual([SAVER_NOTICE_MESSAGE]);
      // While the notice is up, a save is not one made after it.
      await tapUnsave(2);
      await tapSave(3);

      act(() => dismissToast(readFeedbackSnapshot().toasts[0].id, 'closed'));
      await tapUnsave(4);
      await tapSave(5);

      expect(saveBodies()).toEqual([
        { postId: 'post-1', shouldSave: true, sourceSurface: 'detail-page', saverNotYetTold: true },
        { postId: 'post-1', shouldSave: false, sourceSurface: 'detail-page' },
        { postId: 'post-1', shouldSave: true, sourceSurface: 'detail-page', saverNotYetTold: true },
        { postId: 'post-1', shouldSave: false, sourceSurface: 'detail-page' },
        { postId: 'post-1', shouldSave: true, sourceSurface: 'detail-page', creatorSeesSaver: true },
      ]);
      expect(readFeedbackSnapshot().toasts).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  // A creator sells the remix with the recipe (S1): the page drew no Remix at
  // all for a viewer without it, and nothing said the recipe would bring it
  // (B-F3). It is a locked Remix now, as the feed's is, that goes to the recipe.
  it('draws a locked Remix with its price that leads to the recipe, where the recipe sells it', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'paid', priceLabel: '900 credits' } })} />);

    const remix = screen.getByRole('link', { name: 'Unlock the recipe to remix Shared creation, 900 credits' });
    expect(remix).toHaveAttribute('href', '#recipe');
    expect(remix).toHaveTextContent('Remix · 900 credits');
    expect(remix.querySelector('[data-remix-lock]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /remix/i })).toBeNull();
  });

  it('says a free recipe brings the remix with it', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } })} />);

    const remix = screen.getByRole('link', { name: 'Get the free recipe to remix Shared creation' });
    expect(remix).toHaveAttribute('href', '#recipe');
    expect(remix).toHaveTextContent('Remix · Free');
    expect(remix.querySelector('[data-remix-lock]')).toBeNull();
  });

  it('keeps the open Remix for a viewer who may remix', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: true, recipeRemix: null })} />);

    expect(screen.getByRole('button', { name: /remix/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /remix/i })).toBeNull();
  });

  it('sends a signed-out viewer to login instead of saving', () => {
    useAuthMock.mockReturnValue({ user: null, session: null });

    render(<ShowcaseDetailEngagementRow {...rowProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /save shared creation/i }));

    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('/login?returnUrl='));
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith('/api/showcase/save', expect.anything());
  });

  // The page is rendered on the server: the row kept the count the post had
  // then, while the thread's own heading moved with every comment.
  it("follows the thread's count after a comment is posted or deleted", () => {
    render(
      <ShowcaseDetailCommentCountProvider initialCount={0}>
        <ShowcaseDetailEngagementRow {...rowProps({ commentCount: 0 })} />
        <ShowcaseDetailComments postId="post-1" postCreatorId="creator-1" commentCount={0} />
      </ShowcaseDetailCommentCountProvider>,
    );

    expect(screen.getByRole('link')).toHaveTextContent('Comment');

    fireEvent.click(screen.getByRole('button', { name: 'Post a comment' }));
    expect(screen.getByRole('link')).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: 'Delete the comment' }));
    expect(screen.getByRole('link')).toHaveTextContent('Comment');
  });

  it('prints the count it was given outside the provider', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps({ commentCount: 3 })} />);

    expect(screen.getByRole('link')).toHaveTextContent('3');
  });

  // An NSFW post's thread stays hidden until the post is revealed; a link to
  // it before then would point at nothing.
  it('leaves out the Comment link while an NSFW gate is closed, and brings it back on reveal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
      if (url === '/api/content-preferences') return reply({ showMature: true });
      if (url === '/api/posts/post-1/reveal') {
        return reply({ success: true, detail: { title: 'Shared creation', body: '', mediaItems: [] } });
      }
      return reply([]);
    }));
    render(
      <NsfwPostReveal postId="post-1">
        <ShowcaseDetailEngagementRow {...rowProps()} />
      </NsfwPostReveal>,
    );

    expect(screen.queryByRole('link', { name: /comment/i })).not.toBeInTheDocument();
    // Save and Share stay reachable under the gate.
    expect(screen.getByRole('button', { name: /save shared creation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reveal post' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Reveal post' }));

    expect(await screen.findByRole('link', { name: /comment/i })).toHaveAttribute('href', '#comments');
  });
});
