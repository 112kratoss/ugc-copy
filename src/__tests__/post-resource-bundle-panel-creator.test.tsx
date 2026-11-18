import { fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownerFirstPaintRules } from '@/app/showcase/[id]/owner-first-paint';
import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import type { PostResourceBundleLockedPreview } from '@/lib/post-resource-bundles';

/**
 * The recipe panel on its creator's own post, before their own read of the recipe lands. The page
 * is drawn once for everyone, with the recipe as a visitor reads it, and the panel drew that: "Free
 * recipe" and "Get free recipe" for 0.4 to 1.6 s (sweep of 2026-11-17, build 988d55079), until
 * their read started it again as "Your recipe" with "Owner preview". The page knows them before
 * that read (`ownership` in useShowcasePostViewer) and hands the panel `creatorHold`, and in its
 * server HTML `creatorMark`, for the page's rule (`ownerFirstPaintRules`).
 */

const { mockRouter, authState } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), refresh: vi.fn() },
  authState: {
    session: null as { access_token: string } | null,
    credits: null as number | null,
    marketplaceSpendableCredits: null as number | null,
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    marketplaceSpendableCredits: authState.marketplaceSpendableCredits,
    updateCredits: vi.fn(),
  }),
}));

const promptPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['prompt'],
  attachmentPreviews: [],
  itemCounts: { prompt: 1 },
  itemPreviews: [{ type: 'prompt', title: 'Prompt', role: 'primary', remixUse: 'none' }],
  hasPrompt: true,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-10-20T10:00:00.000Z',
};

type PanelProps = ComponentProps<typeof PostResourceBundlePanel>;

/** The recipe as the page holds it: a visitor's, locked. */
const freeRecipe: PanelProps = {
  postId: 'post-1',
  title: 'Harbour recipe',
  summary: 'The exact prompt behind this frame.',
  previewText: '',
  priceLabel: 'Free',
  priceUsdCents: 0,
  priceNote: null,
  isFree: true,
  viewerCanAccess: false,
  viewerIsOwner: false,
  resourceKinds: ['prompt'],
  lockedPreview: promptPreview,
  salesCount: 0,
  freeUnlockCount: 2,
  initialResources: null,
};

const paidRecipe: PanelProps = {
  ...freeRecipe,
  priceLabel: '$9.00',
  priceUsdCents: 900,
  isFree: false,
  salesCount: 1,
  freeUnlockCount: 0,
};

/** What the panel says to someone it offers the recipe to. */
const OFFER = /Free recipe|Get free recipe|Get the full recipe|Unlock the full recipe|Pay \$|Use [\d,]+ credits|Sign in to see your credit balance/;

/** What a browser shows of an element: its text, less whatever a style rule hides. */
function shownText(element: Element): string {
  if (window.getComputedStyle(element).display === 'none') return '';
  return Array.from(element.childNodes)
    .map((node) => (node instanceof Element ? shownText(node) : node.textContent ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

beforeEach(() => {
  authState.session = null;
  authState.credits = null;
  authState.marketplaceSpendableCredits = null;
});

afterEach(() => {
  document.documentElement.removeAttribute('data-auth-user');
  document.documentElement.removeAttribute('data-auth-hint');
  vi.restoreAllMocks();
});

describe("PostResourceBundlePanel: the creator's own recipe before their read lands", () => {
  it.each([
    ['free', freeRecipe],
    ['paid', paidRecipe],
  ])('reads a %s one as theirs, offers nothing, and holds its body', (_kind, recipe) => {
    // Their session as the page knows it: any balance, which a paid offer would print.
    authState.session = { access_token: 'token-1' };
    authState.credits = 5;
    authState.marketplaceSpendableCredits = 5;
    const { container } = render(<PostResourceBundlePanel {...recipe} creatorHold="opening" />);

    expect(screen.getByText('Your recipe')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Opening your recipe…');
    expect(container.textContent).not.toMatch(OFFER);
    expect(container.textContent).not.toContain('credits available');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Its name, as the page's other readers see it.
    expect(screen.getByRole('heading', { name: 'Harbour recipe' })).toBeInTheDocument();
  });

  it('says so when their read failed, and asks it again on Try again', () => {
    const onRetryCreatorRead = vi.fn();
    render(<PostResourceBundlePanel {...freeRecipe} creatorHold="failed" onRetryCreatorRead={onRetryCreatorRead} />);

    expect(screen.getByText('Your recipe')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The recipe could not be opened.');
    expect(screen.queryByText('Opening your recipe…')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(OFFER);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryCreatorRead).toHaveBeenCalledTimes(1);
  });

  it('draws the recipe once their read brings it, the hold or not', () => {
    render(
      <PostResourceBundlePanel
        {...freeRecipe}
        viewerCanAccess
        viewerIsOwner
        initialResources={{
          promptText: 'Harbour at dawn, 35mm.',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        }}
        creatorHold="opening"
      />
    );

    expect(screen.getByText('Your recipe')).toBeInTheDocument();
    expect(screen.getByText('Harbour at dawn, 35mm.')).toBeInTheDocument();
    expect(screen.getByText(/^Owner preview\./)).toBeInTheDocument();
    expect(screen.queryByText('Opening your recipe…')).not.toBeInTheDocument();
  });

  it('offers the recipe as before to anyone else', () => {
    render(<PostResourceBundlePanel {...freeRecipe} />);

    expect(screen.getByText('Free recipe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get free recipe' })).toBeInTheDocument();
    expect(screen.queryByText('Your recipe')).not.toBeInTheDocument();
    expect(screen.queryByText('Opening your recipe…')).not.toBeInTheDocument();
  });

  // The page is drawn ahead of time for every viewer, and no cookie can be read on the server.
  describe("in the server's HTML", () => {
    it.each([
      ['free', freeRecipe, /^Recipe Free recipe 2 opened .*Get the full recipe free with one click\..*Get free recipe$/],
      ['paid', paidRecipe, /^Recipe \$9\.00 · 900 credits 1 sold .*Unlock the full recipe for \$9\.00 · 900 credits\..*Pay \$9\.00.*Use 900 credits.*Sign in to see your credit balance$/],
    ])("draws a %s recipe both ways: the root element's mark shows the creator theirs and anyone else the offer, before the first paint, and hydrates as drawn", async (_kind, recipe, offered) => {
      const panel = <PostResourceBundlePanel {...recipe} creatorMark="user-1" />;
      const rules = document.createElement('style');
      rules.textContent = ownerFirstPaintRules('user-1');
      document.head.appendChild(rules);
      const container = document.createElement('div');
      container.innerHTML = renderToString(panel);
      document.body.appendChild(container);
      const root = document.documentElement;
      const section = () => container.querySelector('#recipe') as HTMLElement;

      // A visitor: the offer, as before.
      expect(shownText(section())).toMatch(offered);
      // Another account: held until their own read of the recipe says whether they have it, offered
      // nothing and called theirs nowhere (owner, 2026-11-18: "Yes, hold it").
      root.setAttribute('data-auth-hint', 'signed-in');
      root.setAttribute('data-auth-user', 'user-2');
      expect(shownText(section())).toMatch(/^Recipe Checking… .*Harbour recipe Checking your recipes…$/);
      expect(shownText(section())).not.toMatch(OFFER);
      expect(shownText(section())).not.toContain('Your recipe');
      // A session cookie the root element could not name an account from: held the same way.
      root.removeAttribute('data-auth-user');
      expect(shownText(section())).toMatch(/^Recipe Checking… .*Harbour recipe Checking your recipes…$/);
      // The creator: theirs, offered nothing, held.
      root.setAttribute('data-auth-user', 'user-1');
      expect(shownText(section())).toMatch(/^Recipe Your recipe .*Harbour recipe Opening your recipe…$/);
      expect(shownText(section())).not.toMatch(OFFER);

      const recoverableErrors: unknown[] = [];
      let hydrated: ReturnType<typeof hydrateRoot> | null = null;
      await act(async () => {
        hydrated = hydrateRoot(container, panel, { onRecoverableError: (error) => recoverableErrors.push(error) });
      });
      expect(recoverableErrors).toEqual([]);

      await act(async () => {
        hydrated?.unmount();
      });
      container.remove();
      rules.remove();
    });

    it("draws no hold for anyone but the creator where no mark is given", () => {
      const html = renderToString(<PostResourceBundlePanel {...freeRecipe} />);

      expect(html).toContain('Get free recipe');
      expect(html).not.toContain('Opening your recipe');
      expect(html).not.toContain('Checking your recipes');
      expect(html).not.toContain('Your recipe');
      expect(html).not.toContain('data-post-recipe-');
    });
  });
});

/**
 * The recipe panel for anyone else signed in, before their own read of the recipe lands. The page is
 * drawn with the recipe as a visitor reads it, and a reader who had it was offered it ("Free recipe",
 * "Get free recipe") until that read said "Unlocked" (sweep of 2026-11-18). The page hands the panel
 * `readerChecking` while the read is out (owner, 2026-11-18: "Yes, hold it").
 */
describe("PostResourceBundlePanel: a signed-in reader's recipe before their read lands", () => {
  it.each([
    ['free', freeRecipe],
    ['paid', paidRecipe],
  ])('holds a %s one, offered nowhere and called theirs nowhere', (_kind, recipe) => {
    // Their session as the page knows it: any balance, which a paid offer would print.
    authState.session = { access_token: 'token-2' };
    authState.credits = 5;
    authState.marketplaceSpendableCredits = 5;
    const { container } = render(<PostResourceBundlePanel {...recipe} readerChecking />);

    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking your recipes…');
    expect(container.textContent).not.toMatch(OFFER);
    expect(container.textContent).not.toMatch(/Your recipe|Unlocked|Opening your recipe/);
    expect(container.textContent).not.toContain('credits available');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Its name, as the page's other readers see it.
    expect(screen.getByRole('heading', { name: 'Harbour recipe' })).toBeInTheDocument();
  });

  it('draws the recipe once their read brings it as theirs, the hold or not', () => {
    render(
      <PostResourceBundlePanel
        {...freeRecipe}
        viewerCanAccess
        initialResources={{
          promptText: 'Harbour at dawn, 35mm.',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        }}
        readerChecking
      />
    );

    expect(screen.getByText('Unlocked')).toBeInTheDocument();
    expect(screen.getByText('Harbour at dawn, 35mm.')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(screen.queryByText('Checking your recipes…')).not.toBeInTheDocument();
  });

  it("gives way to the creator's own hold", () => {
    render(<PostResourceBundlePanel {...freeRecipe} creatorHold="opening" readerChecking />);

    expect(screen.getByText('Your recipe')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Opening your recipe…');
    expect(screen.queryByText('Checking your recipes…')).not.toBeInTheDocument();
  });
});
