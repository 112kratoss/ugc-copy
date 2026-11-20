import { act, render, screen, waitFor } from '@testing-library/react';
import { Fragment, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Production, 2026-11-20 (build 788a6edf2): a signed-in load of a post page asked Supabase Auth who
// the reader was twice (`GET /auth/v1/user`) and read the reader's own profile row three times
// (`GET /rest/v1/profiles?select=…&id=…`): the page's provider (`AuthProvider`, which the page
// mounts as `OptionalAuth`), the top bar's account (`AppShellAccount`, above every route's
// provider) and the comment composer's avatar (`account-avatar.ts`) each asked for themselves.
// Here the page and the top bar are drawn as the browser draws them, with their own providers and
// a Supabase client that answers as the network does, a moment later; every check and read it is
// asked for is counted.

const POST_ID = '5a1e0000-0000-4000-8000-000000000001';
const SUPABASE_URL = 'https://project-ref.supabase.co';
const AUTH_COOKIE = 'sb-project-ref-auth-token';

const supabaseFake = vi.hoisted(() => {
  const user = {
    id: 'reader-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'ivy.reader@example.com',
    is_anonymous: false,
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const accessToken = 'reader-access-token';
  /** The reader's row, whatever columns are asked for, as PostgREST would give them. */
  const row = {
    display_name: 'Magic Booklet',
    avatar_url: null,
    credits: 22,
    promotional_credits: 0,
    saver_notice_seen_at: null,
  };
  return {
    user,
    accessToken,
    row,
    /** Every `auth.getUser` asked for: the token it named. */
    userChecks: [] as string[],
    /** Every read of the `profiles` table: its columns and the id it asked for. */
    profileReads: [] as Array<{ columns: string; id: unknown }>,
    /**
     * How long Supabase takes to answer: Auth's `/user` is the slow one (about 450 ms at the median
     * in production, `.claude/rules/web-mobile-contract.md` on the proxy's admission), a read of one
     * row by its key is quick.
     */
    authLatencyMs: 120,
    restLatencyMs: 20,
    /** A copy of the stored session, as auth-js reads one from storage for each caller. */
    session: () => ({
      access_token: accessToken,
      refresh_token: 'reader-refresh-token',
      expires_in: 3600,
      expires_at: 4_102_444_800,
      token_type: 'bearer',
      user: { ...user },
    }),
  };
});

vi.mock('@/lib/supabase', () => {
  const later = <T,>(value: T, latencyMs: number) => new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), latencyMs);
  });
  return {
    supabase: {
      auth: {
        // As auth-js: each subscriber is told the stored session once it has subscribed.
        onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
          queueMicrotask(() => callback('INITIAL_SESSION', supabaseFake.session()));
          return { data: { subscription: { unsubscribe: () => undefined } } };
        },
        getSession: async () => ({ data: { session: supabaseFake.session() }, error: null }),
        getUser: (jwt?: string) => {
          supabaseFake.userChecks.push(jwt ?? '(stored session)');
          return later({ data: { user: { ...supabaseFake.user } }, error: null }, supabaseFake.authLatencyMs);
        },
        signOut: async () => ({ error: null }),
      },
      from: (table: string) => ({
        select: (columns: string) => ({
          eq: (_column: string, id: unknown) => {
            const read = () => {
              if (table === 'profiles') supabaseFake.profileReads.push({ columns, id });
              return later({ data: table === 'profiles' ? { ...supabaseFake.row } : null, error: null }, supabaseFake.restLatencyMs);
            };
            return { single: read, maybeSingle: read };
          },
        }),
      }),
    },
  };
});

const navigation = vi.hoisted(() => ({ pathname: '/showcase/5a1e0000-0000-4000-8000-000000000001' }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => navigation.pathname,
}));

// The post page is one cached render for everyone: it never reads the request.
vi.mock('next/headers', () => ({
  headers: () => {
    throw new Error('The post page read the request headers');
  },
  cookies: () => {
    throw new Error('The post page read the request cookies');
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => {
    throw new Error("The post page read the viewer's session on the server");
  },
}));

vi.mock('@/lib/public-posts', () => ({
  getPostReferenceForShowcaseId: async () => null,
  getPublicPostDetail: async (id: string) => (id === POST_ID ? {
    id: POST_ID,
    generationId: '6e0e0000-0000-4000-8000-000000000001',
    visibility: 'public',
    mediaUrl: 'https://cdn.example.com/showcase/gen-1.jpg',
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Shared creation',
    description: 'A polished showcase description.',
    prompt: 'A creator holds the product by a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 12,
    remixCount: 3,
    shareCount: 7,
    shareVisitCount: 18,
    commentCount: 0,
    createdAt: '2026-03-28T10:00:00.000Z',
    sourceKind: 'magicbooklet',
    sourceTool: null,
    creator: { id: 'creator-1', username: 'creator-name', name: 'Creator Name', avatar: null },
    resourceBundle: null,
    canRemix: true,
  } : null),
  getPublicPostMetaDescription: (detail: { description?: string; title: string }) => detail.description || detail.title,
}));

// The rail's parts that ask nothing of Supabase are drawn bare. The engagement row says what the
// page's provider knows of the reader, so a test can tell when its check and read have landed.
vi.mock('@/app/showcase/[id]/ShowcaseDetailEngagementRow', async () => {
  const { useAuth } = await import('@/components/AuthProvider');
  return {
    default: function EngagementRowProbe() {
      const { user, credits, isLoading } = useAuth();
      return (
        <div
          data-testid="page-provider"
          data-reader={user?.id ?? ''}
          data-credits={credits ?? ''}
          data-loading={String(isLoading)}
        />
      );
    },
  };
});
vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: () => <div data-testid="showcase-detail-actions" />,
}));
vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: () => <div data-testid="post-resource-bundle-panel" />,
}));

import ShowcaseDetailPage from '@/app/showcase/[id]/page';
import DeferredAppShellAccount from '@/components/DeferredAppShellAccount';
import { PricingClient } from '@/app/pricing/PricingClient';
import { forgetAccountProfilesForTests } from '@/lib/account-avatar';
import { readOwnProfile } from '@/lib/browser-account-reads';
import { supabase } from '@/lib/supabase';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The site's API as the page's client parts meet it: an empty thread, no recipe, no block. */
function stubApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/showcase/posts/${POST_ID}/comments`)) {
      return jsonResponse({
        postId: POST_ID,
        postCreatorId: 'creator-1',
        commentCount: 0,
        comments: [],
        pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
      });
    }
    if (url.includes(`/api/posts/${POST_ID}/resource-bundle`)) return jsonResponse({ success: true, bundle: null });
    if (url.includes('/api/showcase/viewer-exclusions')) {
      return jsonResponse({ blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: [] });
    }
    if (url.includes('/api/fx-rates')) {
      return jsonResponse({ base: 'INR', rates: { INR: 1, USD: 0.012 }, updatedAt: '2026-11-20T00:00:00.000Z' });
    }
    return jsonResponse({});
  }));
}

/** The comment composer's avatar, beside its box. */
function composerAvatar() {
  const row = screen.getByRole('textbox', { name: 'Write a comment' }).closest('.flex.items-start');
  return row?.firstElementChild as HTMLElement;
}

/** Long enough for any late check or read to be asked for, and answered. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, (supabaseFake.authLatencyMs + supabaseFake.restLatencyMs) * 3);
    });
  });
}

/** What the load asked of Supabase: its checks of the session, and its reads of the reader's row. */
function asked() {
  return {
    sessionChecks: supabaseFake.userChecks.length,
    profileReads: supabaseFake.profileReads.length,
  };
}

async function postPage(): Promise<ReactNode> {
  return ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) });
}

/** The top bar's account, as the shell mounts it for a browser with a session cookie. */
function TopBarAccount() {
  return <DeferredAppShellAccount pathname={navigation.pathname} />;
}

describe('a signed-in load asks Supabase Auth about the session once and reads the reader’s row once', () => {
  beforeEach(() => {
    // A new page: nothing read in an earlier test is held.
    forgetAccountProfilesForTests();
    supabaseFake.row.credits = 22;
    supabaseFake.userChecks.length = 0;
    supabaseFake.profileReads.length = 0;
    navigation.pathname = `/showcase/${POST_ID}`;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
    document.cookie = `${AUTH_COOKIE}=base64-session; Path=/`;
    stubApi();
  });

  afterEach(() => {
    document.cookie = `${AUTH_COOKIE}=; Max-Age=0; Path=/`;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Everything the load draws from the two reads is drawn: the top bar, the page's provider, the composer. */
  async function expectReaderDrawnEverywhere() {
    expect(await screen.findByRole('link', { name: '22 credits' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open account menu for Magic Booklet' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('page-provider')).toHaveAttribute('data-credits', '22'));
    expect(screen.getByTestId('page-provider')).toHaveAttribute('data-reader', 'reader-1');
    expect(screen.getByTestId('page-provider')).toHaveAttribute('data-loading', 'false');
    await waitFor(() => expect(composerAvatar()).toHaveTextContent('MB'));
  }

  it('on a post page: the top bar, the page’s provider and the comment composer share one of each', async () => {
    render(
      <>
        <TopBarAccount />
        {await postPage()}
      </>,
    );

    await expectReaderDrawnEverywhere();
    await settle();
    // Main asked twice and read three times.
    expect(asked()).toEqual({ sessionChecks: 1, profileReads: 1 });
    expect(supabaseFake.userChecks).toEqual([supabaseFake.accessToken]);
    expect(supabaseFake.profileReads[0].id).toBe('reader-1');
  });

  it('on a post page whose top bar arrives after the page has checked the session', async () => {
    const page = await postPage();
    // In its place from the start, so the page is not drawn again when the top bar comes.
    const view = render(<>{null}{page}</>);
    await waitFor(() => expect(screen.getByTestId('page-provider')).toHaveAttribute('data-credits', '22'));

    // The top bar's own code came later (a slow chunk): it asks about the same session.
    view.rerender(
      <>
        <TopBarAccount />
        {page}
      </>,
    );

    await expectReaderDrawnEverywhere();
    await settle();
    // Main asked twice and read three times here too.
    expect(asked()).toEqual({ sessionChecks: 1, profileReads: 1 });
  });

  // A client navigation opens a page whose own provider checks the session and reads the balance as
  // it opens, as each new page's provider always did (the top bar asked once, for the document): the
  // page knows its reader no sooner and no later than before.
  it('a post page opened by a client navigation checks the session and reads the balance itself, as before', async () => {
    const view = render(
      <>
        <TopBarAccount />
        <Fragment key="first-page">{await postPage()}</Fragment>
      </>,
    );
    await expectReaderDrawnEverywhere();
    await settle();
    expect(asked()).toEqual({ sessionChecks: 1, profileReads: 1 });

    // The next page's own provider, under the same top bar.
    view.rerender(
      <>
        <TopBarAccount />
        <Fragment key="next-page">{await postPage()}</Fragment>
      </>,
    );
    await expectReaderDrawnEverywhere();
    await settle();
    // Main asked three times and read four.
    expect(asked()).toEqual({ sessionChecks: 2, profileReads: 2 });
  });

  it('never draws a balance from before it moved in a top bar that arrives after the change', async () => {
    const page = await postPage();
    const view = render(<>{null}{page}</>);
    await waitFor(() => expect(screen.getByTestId('page-provider')).toHaveAttribute('data-credits', '22'));

    // A spend on the page announces the new balance (`updateCredits`) before the top bar's code has
    // come: the read the page made a moment ago is from before it.
    supabaseFake.row.credits = 17;
    act(() => {
      window.dispatchEvent(new CustomEvent('credits_updated', { detail: { credits: 17 } }));
    });
    await waitFor(() => expect(screen.getByTestId('page-provider')).toHaveAttribute('data-credits', '17'));

    view.rerender(
      <>
        <TopBarAccount />
        {page}
      </>,
    );
    expect(await screen.findByRole('link', { name: '17 credits' })).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole('link', { name: '22 credits' })).toBeNull();
    // The session's check is still shared; the balance is read again.
    expect(asked()).toEqual({ sessionChecks: 1, profileReads: 2 });
  });

  // A full load of Pricing, as the browser makes it: the balance card is drawn with the document's
  // HTML and hydrated, and the top bar only in the browser, beside it (`DeferredAppShellAccount`,
  // `ssr: false`). Which of the two asks first depends on the machine: the top bar waits for Supabase
  // Auth's check, the card for the stored session. A version of this case that drew the card by a
  // client render (Pricing reads its own then, as after a client navigation) passed only when the
  // card asked first, and failed main's Quality run on a slow runner (2026-11-20, `5b2aea1bf`), so
  // it runs both orders.
  describe('on a full load of Pricing, the top bar and the balance card share one of each', () => {
    let root: Root | null = null;

    afterEach(() => {
      act(() => root?.unmount());
      root = null;
      document.body.innerHTML = '';
    });

    async function fullLoadOfPricing() {
      navigation.pathname = '/pricing';
      const card = <PricingClient initialCountryCode="IN" sessionCookieHint />;
      const container = document.createElement('div');
      container.innerHTML = renderToString(card);
      document.body.appendChild(container);
      await act(async () => {
        root = hydrateRoot(container, card);
      });
      render(<TopBarAccount />);

      expect(await screen.findByRole('link', { name: '22 credits' })).toBeInTheDocument();
      // The card's figure, beside the top bar's own.
      await waitFor(() => expect(screen.getByText('Available balance').parentElement).toHaveTextContent('22 credits'));
      await settle();
    }

    it('when the card asks first', async () => {
      await fullLoadOfPricing();
      // Main read it twice.
      expect(asked()).toEqual({ sessionChecks: 1, profileReads: 1 });
    });

    it('when the top bar asks first', async () => {
      // The card's read of the stored session comes after the top bar's check and read.
      const getSession = supabase.auth.getSession.bind(supabase.auth);
      const slowSession = vi.spyOn(supabase.auth, 'getSession').mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, (supabaseFake.authLatencyMs + supabaseFake.restLatencyMs) * 2);
        });
        return getSession();
      });
      try {
        await fullLoadOfPricing();
        expect(asked()).toEqual({ sessionChecks: 1, profileReads: 1 });
      } finally {
        slowSession.mockRestore();
      }
    });
  });

  // Whichever asks first on a full load: the card drawn with the document's HTML takes the read the
  // top bar made before it, as the page's provider does. Made by a client navigation, it reads the
  // balance itself as it opens, as it always did.
  describe("Pricing's balance card and a read the top bar made first", () => {
    let root: Root | null = null;

    afterEach(() => {
      act(() => root?.unmount());
      root = null;
      document.body.innerHTML = '';
    });

    it('takes it when drawn with the document', async () => {
      navigation.pathname = '/pricing';
      await readOwnProfile(supabase, supabaseFake.user.id);
      const card = <PricingClient initialCountryCode="IN" sessionCookieHint />;
      const container = document.createElement('div');
      container.innerHTML = renderToString(card);
      document.body.appendChild(container);

      await act(async () => {
        root = hydrateRoot(container, card);
      });
      await waitFor(() => expect(screen.getByText('Available balance').parentElement).toHaveTextContent('22 credits'));
      await settle();
      expect(asked()).toEqual({ sessionChecks: 0, profileReads: 1 });
    });

    it('reads its own when made by a client navigation', async () => {
      navigation.pathname = '/pricing';
      await readOwnProfile(supabase, supabaseFake.user.id);
      render(<PricingClient initialCountryCode="IN" sessionCookieHint />);

      await waitFor(() => expect(screen.getByText('Available balance').parentElement).toHaveTextContent('22 credits'));
      await settle();
      expect(asked()).toEqual({ sessionChecks: 0, profileReads: 2 });
    });
  });
});
