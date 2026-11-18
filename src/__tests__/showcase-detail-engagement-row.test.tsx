import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  ShowcaseDetailCommentCountProvider,
  ShowcaseDetailComments,
} from '@/app/showcase/[id]/ShowcaseDetailCommentCount';
import ShowcaseDetailEngagementRow from '@/app/showcase/[id]/ShowcaseDetailEngagementRow';
import { ownerFirstPaintRules } from '@/app/showcase/[id]/owner-first-paint';
import NsfwPostReveal from '@/components/NsfwPostReveal';
import { dismissToast, readFeedbackSnapshot, resetFeedbackState, subscribeToFeedback } from '@/components/feedback-state';
import { SAVER_NOTICE_MESSAGE, resetSaverNoticeForTests } from '@/components/saver-notice';
import { requestShowcaseRemix } from '@/lib/showcase-remix-client';

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

    expect(screen.getByRole('button', { name: 'Remix' })).toBeInTheDocument();
    // The count is its own button, which opens the remixes posted from the post.
    expect(screen.getByRole('button', { name: '2 remixes' })).toHaveAttribute('aria-haspopup', 'dialog');
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
    expect(screen.queryByRole('button', { name: 'Remix' })).toBeNull();
  });

  // The recipe is often on screen already, right under the pill, and the jump
  // then moved nothing (owner, 2026-11-12): the click rings the recipe.
  it('rings the recipe section when the locked Remix is pressed', () => {
    const animate = vi.fn();
    render(
      <>
        <ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'paid', priceLabel: '900 credits' } })} />
        <section id="recipe" ref={(node) => { if (node) node.animate = animate; }} />
      </>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Unlock the recipe to remix Shared creation, 900 credits' }));

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1]).toMatchObject({ id: 'recipe-jump' });
    // No credit is spent and no remix asked for by this click.
    expect(requestShowcaseRemix).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(expect.stringContaining('/resource-bundle/'), expect.anything());
  });

  // "Remix · Free" was a link to the recipe a few pixels below it, so the click
  // looked dead (owner, 2026-11-12). It takes the free recipe on its way and
  // opens the remix, as the feed card's and the app's Remix do.
  it('takes a free recipe on the way and opens the remix in one click', async () => {
    const freeRow = rowProps({ canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } });
    render(<ShowcaseDetailEngagementRow {...freeRow} />);

    const remix = screen.getByRole('button', { name: 'Get the free recipe and remix Shared creation' });
    expect(remix).toHaveTextContent('Remix · Free');
    expect(remix.querySelector('[data-remix-lock]')).toBeNull();
    expect(screen.queryByRole('link', { name: /remix/i })).toBeNull();

    fireEvent.click(remix);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/create-image?remix=1'));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-free', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });
    // The recipe is taken before the remix is asked for: the remix endpoint
    // refuses a post whose recipe the viewer does not hold.
    const claimOrder = vi.mocked(fetch).mock.invocationCallOrder[
      vi.mocked(fetch).mock.calls.findIndex(([input]) => String(input).endsWith('/unlock-free'))
    ];
    expect(claimOrder).toBeLessThan(vi.mocked(requestShowcaseRemix).mock.invocationCallOrder[0]);
    expect(requestShowcaseRemix).toHaveBeenCalledWith({ accessToken: 'token-1', postId: 'post-1' });
  });

  it('says why when the free recipe cannot be taken, and starts no remix', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/unlock-free')) {
        return { ok: false, status: 429, json: async () => ({ error: 'Too many recipes. Try again shortly.' }) } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    }));
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Get the free recipe and remix Shared creation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many recipes. Try again shortly.');
    expect(requestShowcaseRemix).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  // The recipe is the viewer's once the claim lands, whatever the remix then
  // answers: the page is re-read so its Remix and recipe panel say so.
  it('re-reads the page when the recipe was taken but the remix did not start', async () => {
    vi.mocked(requestShowcaseRemix).mockRejectedValueOnce(new Error('Too many remixes. Try again shortly.'));
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Get the free recipe and remix Shared creation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many remixes. Try again shortly.');
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('sends a signed-out viewer to login before taking a free recipe', () => {
    useAuthMock.mockReturnValue({ user: null, session: null });
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Get the free recipe and remix Shared creation' }));

    expect(pushMock).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?returnUrl=/));
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(expect.stringContaining('/unlock-free'), expect.anything());
  });

  it('keeps the open Remix for a viewer who may remix', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps({ canRemix: true, recipeRemix: null })} />);

    expect(screen.getByRole('button', { name: 'Remix' })).toBeInTheDocument();
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

  // The locked Remix pill leads to the recipe, which under an NSFW gate is on
  // the page only after the reveal: before it, the pill would scroll nowhere.
  it('holds the locked Remix pill until an NSFW gate opens', async () => {
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
        <ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'paid', priceLabel: '900 credits' } })} />
      </NsfwPostReveal>,
    );

    expect(screen.queryByRole('link', { name: /unlock the recipe to remix/i })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reveal post' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Reveal post' }));

    expect(await screen.findByRole('link', { name: /unlock the recipe to remix/i })).toHaveAttribute('href', '#recipe');
  });

  // Review of #847: the post's creator was offered their own creation's Remix to claim ("Remix ·
  // Free") or to unlock ("Remix · 900 credits") until their own read of the recipe landed. The
  // server's HTML draws their open Remix beside it, and the page's rule shows each its own.
  describe("the creator's open Remix in the server's HTML", () => {
    // Third case, review of #847's second round: a recipe that gates the Remix without including it
    // (`allowRemix` false, as a recipe of reference pictures on an upload reads) gives everyone else
    // no Remix at all, and the creator's appeared only after hydration, moving Save along the row.
    // A signed-in reader's own read of the recipe says whether they have it, so before the first paint
    // they get the open Remix, inert, where a visitor's is locked behind the recipe, as the page then
    // draws it until that read lands (owner, 2026-11-18: "Yes, hold it").
    it.each([
      ['free', { access: 'free', priceLabel: 'Free' } as const, ['Remix · Free'], ['Remix']],
      ['paid', { access: 'paid', priceLabel: '900 credits' } as const, ['Remix · 900 credits'], ['Remix']],
      ['no-Remix', null, [], []],
    ])("is shown to the creator in place of a %s recipe's Remix for everyone else, before the first paint, inert, and hydrates as drawn", (_kind, recipeRemix, visitors, readers) => {
      const props = rowProps({
        canRemix: false,
        recipeRemix,
        remixCount: 0,
        creatorRemixMark: 'user-1',
        creatorCanRemix: true,
      });
      const rules = document.createElement('style');
      rules.textContent = ownerFirstPaintRules('user-1');
      document.head.appendChild(rules);
      const root = document.documentElement;
      const container = document.createElement('div');
      container.innerHTML = renderToString(<ShowcaseDetailEngagementRow {...props} />);
      document.body.appendChild(container);
      onTestFinished(() => {
        rules.remove();
        container.remove();
        root.removeAttribute('data-auth-user');
        root.removeAttribute('data-auth-hint');
      });
      // The Remix controls a browser shows.
      const remixes = () => Array.from(container.querySelectorAll('a, button'))
        .filter((control) => window.getComputedStyle(control).display !== 'none')
        .map((control) => control.textContent?.trim() ?? '')
        .filter((text) => /^Remix\b/.test(text));

      // A visitor.
      expect(remixes()).toEqual(visitors);
      // Another account, inert until the page's script has their read of the recipe.
      root.setAttribute('data-auth-hint', 'signed-in');
      root.setAttribute('data-auth-user', 'user-2');
      expect(remixes()).toEqual(readers);
      if (readers.length > 0) expect(container.querySelector('[data-post-remix-checking="user-1"]')).toBeDisabled();
      // The creator: their own creation, to remix and nothing to take or pay, inert until the
      // page's script has named them.
      root.setAttribute('data-auth-user', 'user-1');
      expect(remixes()).toEqual(['Remix']);
      expect(container.querySelector('[data-post-remix-owner="user-1"]')).toBeDisabled();

      const consoleError = vi.spyOn(console, 'error');
      render(<ShowcaseDetailEngagementRow {...props} />, { container, hydrate: true });
      expect(consoleError).not.toHaveBeenCalled();
    });

    // Review of #847's third round: a post with no creation has nothing to remix (the server answers
    // its Remix "Only generation-backed posts can be remixed"), so its creator gets no Remix, while
    // anyone else may still be offered one; theirs must not show to the creator, nor go late. (Since
    // 2026-11-17 the page gives such a post no Remix for anyone, so it never draws this row. Another
    // account is set here by the root's account mark alone, without the session hint a signed-in
    // reader's browser also carries: that reader's rule of 2026-11-18 hides what is marked as everyone
    // else's pitch, as this row's Remix is.)
    it.each([
      ['a free recipe\'s locked Remix', { canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } } as const, ['Remix · Free']],
      ['the open Remix', { canRemix: true, recipeRemix: null }, ['Remix']],
    ])("keeps %s from the creator of a post with no creation, before the first paint, and hydrates as drawn", (_offer, offer, others) => {
      const props = rowProps({ ...offer, remixCount: 0, creatorRemixMark: 'user-1', creatorCanRemix: false });
      const rules = document.createElement('style');
      rules.textContent = ownerFirstPaintRules('user-1');
      document.head.appendChild(rules);
      const root = document.documentElement;
      const container = document.createElement('div');
      container.innerHTML = renderToString(<ShowcaseDetailEngagementRow {...props} />);
      document.body.appendChild(container);
      onTestFinished(() => {
        rules.remove();
        container.remove();
        root.removeAttribute('data-auth-user');
      });
      const remixes = () => Array.from(container.querySelectorAll('a, button'))
        .filter((control) => window.getComputedStyle(control).display !== 'none')
        .map((control) => control.textContent?.trim() ?? '')
        .filter((text) => /^Remix\b/.test(text));

      expect(remixes()).toEqual(others);
      root.setAttribute('data-auth-user', 'user-2');
      expect(remixes()).toEqual(others);
      root.setAttribute('data-auth-user', 'user-1');
      expect(remixes()).toEqual([]);

      const consoleError = vi.spyOn(console, 'error');
      render(<ShowcaseDetailEngagementRow {...props} />, { container, hydrate: true });
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('draws one Remix once the viewer is known, and none twice where both would read the same', () => {
      const { unmount } = render(
        <ShowcaseDetailEngagementRow {...rowProps({ canRemix: false, recipeRemix: { access: 'free', priceLabel: 'Free' } })} />,
      );
      expect(screen.getAllByRole('button', { name: /remix/i }).map((button) => button.textContent?.trim()))
        .toEqual(['Remix · Free', '2 remixes']);
      unmount();

      // A post whose Remix is open to everyone: the creator's is the same one.
      render(<ShowcaseDetailEngagementRow {...rowProps({ creatorRemixMark: 'user-1', creatorCanRemix: true })} />);
      const remix = screen.getByRole('button', { name: 'Remix' });
      expect(remix).not.toHaveAttribute('data-post-remix-owner');
    });

    // Review of #847's second round: while the session check ran on the creator's cookie their open
    // Remix took a press, and with no account named yet it sent them to sign in.
    it('holds the open Remix inert, and undimmed, while the session check runs, then lets it start the remix', async () => {
      useAuthMock.mockReturnValue({ user: null, session: null });
      const { rerender } = render(<ShowcaseDetailEngagementRow {...rowProps({ remixHeld: true })} />);
      const remix = screen.getByRole('button', { name: 'Remix' });
      expect(remix).toBeDisabled();
      expect(remix).not.toHaveClass('opacity-60');
      fireEvent.click(remix);
      expect(pushMock).not.toHaveBeenCalled();
      expect(requestShowcaseRemix).not.toHaveBeenCalled();

      // The check names the creator.
      useAuthMock.mockReturnValue({ user: { id: 'user-1' }, session: { access_token: 'token-1' } });
      rerender(<ShowcaseDetailEngagementRow {...rowProps({ remixHeld: false })} />);
      expect(remix).toBeEnabled();
      fireEvent.click(remix);
      await waitFor(() => expect(requestShowcaseRemix).toHaveBeenCalledWith({ accessToken: 'token-1', postId: 'post-1' }));
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/create-image?remix=1'));
    });
  });
});

describe('NsfwPostReveal', () => {
  // A mature post's settings describe what its cover hides: the gate draws them with the
  // revealed post, in the line the page draws for any other (owner, 2026-11-03), as the app's
  // iOS reveal does.
  it("draws the revealed post's settings, and nothing of them before or after", async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
      if (url === '/api/content-preferences') return reply({ showMature: true });
      if (url === '/api/posts/post-1/reveal') {
        return reply({
          success: true,
          detail: {
            title: 'Shared creation',
            body: '',
            mediaItems: [],
            generationSetup: [
              { label: 'Aspect ratio', value: '9:16' },
              { label: 'Mode', value: 'Fast' },
              { label: 'Resolution', value: '1080P' },
            ],
          },
        });
      }
      return reply([]);
    }));
    render(<NsfwPostReveal postId="post-1" />);

    expect(screen.queryByTestId('post-generation-setup')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reveal post' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Reveal post' }));

    const line = await screen.findByTestId('post-generation-setup');
    expect(line.querySelector('[aria-hidden="true"]')?.textContent).toBe('9:16·Fast·1080P');
    expect(screen.getByText('Generation settings: Aspect ratio: 9:16, Mode: Fast, Resolution: 1080P')).toHaveClass('sr-only');
    expect(screen.getByText('Fast')).toHaveAttribute('title', 'Mode');

    fireEvent.click(screen.getByRole('button', { name: 'Hide this post' }));
    expect(screen.queryByTestId('post-generation-setup')).not.toBeInTheDocument();
  });
});
