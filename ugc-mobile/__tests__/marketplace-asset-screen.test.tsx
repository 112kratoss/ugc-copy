// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerPush = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
const showActionSheet = vi.hoisted(() => vi.fn());
// The last attempt, as React Query keeps it: the hook shows an attempt's
// refusal only on the bundle it was made for.
const mutationState = vi.hoisted(() => ({ error: null as unknown, variables: undefined as unknown }));

const authState = vi.hoisted(() => ({
  api: { resolvePostResourceFileUrl: vi.fn() },
  credits: 2000 as number | null,
  marketplaceSpendableCredits: 2000 as number | null,
  updateCredits: vi.fn(),
  user: { id: 'user-1' } as { id: string } | null,
}));

const queryState = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  error: null as unknown,
  isLoading: false,
}));

vi.mock('expo-router', () => ({
  router: { push: routerPush },
  useLocalSearchParams: () => ({ assetId: 'asset-1' }),
}));

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Pill: (props: MockProps) => React.createElement('pill', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: (props: MockProps) => React.createElement('media-preview', props),
}));

vi.mock('@/components/post-resource-bundle-content', () => ({
  PostResourceBundleContent: (props: MockProps) => React.createElement('bundle-content', props),
}));

vi.mock('@/components/skeleton', () => ({
  DetailSkeleton: (props: MockProps) => React.createElement('detail-skeleton', props),
}));

vi.mock('@/lib/action-sheet', () => ({ showActionSheet }));

vi.mock('@/lib/copy-to-clipboard', () => ({ copyToClipboard: vi.fn() }));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));

vi.mock('@/lib/pricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/pricing')>()),
  formatCreditAmount: (amount: number) => String(amount),
}));

vi.mock('@/lib/unlock-cache', () => ({ refreshUnlockedBundleCaches: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate, isPending: false, error: mutationState.error, variables: mutationState.variables }),
  useQuery: () => ({ data: queryState.data, error: queryState.error, isError: Boolean(queryState.error), isLoading: queryState.isLoading, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import MarketplaceAssetScreen from '../app/marketplace/[assetId]';
import { ApiError } from '../lib/api-client';

function paidDetail(priceUsdCents = 900) {
  return {
    accessMode: 'paid',
    lockedPreview: null,
    post: { id: 'post-1', mediaItems: [], mediaKind: null, mediaUrl: null },
    postId: 'post-1',
    previewText: 'Preview',
    priceUsdCents,
    resourceKinds: ['prompt'],
    resources: null,
    seller: { name: 'fluffy' },
    summary: 'Summary',
    title: 'Moody Pack',
    viewerCanAccess: false,
  };
}

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(MarketplaceAssetScreen));
  });
  return tree;
}

const PROMOTIONAL_NOTE = "Welcome and referral credits can't be spent on recipes.";

/** A text node's words, however JSX split them into children. */
function textOf(node: renderer.ReactTestInstance) {
  return ([] as unknown[]).concat(node.props.children).join('');
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map(textOf);
}

function balanceLine(tree: renderer.ReactTestRenderer) {
  const line = tree.root.findAll((node) => String(node.type) === 'text' && textOf(node).startsWith('Costs '))[0];
  if (!line) throw new Error('No balance line');
  return line;
}

beforeEach(() => {
  routerPush.mockClear();
  mutate.mockClear();
  showActionSheet.mockClear();
  authState.credits = 2000;
  authState.marketplaceSpendableCredits = 2000;
  authState.user = { id: 'user-1' };
  queryState.data = paidDetail();
  queryState.error = null;
  queryState.isLoading = false;
  mutationState.error = null;
  mutationState.variables = undefined;
});

describe('marketplace asset screen (HIG S18)', () => {
  it('confirms a paid unlock before spending, then spends only on the confirmed action', () => {
    const tree = renderScreen();
    const buy = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    if (!buy) throw new Error('No unlock button');
    expect(buy.props.label).toBe('Unlock for 900 credits');

    renderer.act(() => { (buy.props.onPress as () => void)(); });
    expect(mutate).not.toHaveBeenCalled();
    expect(showActionSheet).toHaveBeenCalledTimes(1);

    const request = showActionSheet.mock.calls[0]?.[0] as { message: string; actions: Array<{ label: string; onPress?: () => void }> };
    expect(request.message).toBe('900 credits will come off your balance.');
    request.actions[0]?.onPress?.();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('offers the credits path instead of a doomed unlock when the balance is short', () => {
    authState.credits = 100;
    authState.marketplaceSpendableCredits = 100;
    const tree = renderScreen();

    const buy = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    expect(buy?.props.disabled).toBe(true);

    const texts = tree.root.findAll((node) => String(node.type) === 'text');
    expect(texts.some((node) => String(node.props.children).includes('more credits'))).toBe(true);

    const getCredits = tree.root.findAll((node) => String(node.type) === 'secondary-button'
      && node.props.label === 'Get credits')[0];
    if (!getCredits) throw new Error('No Get credits button');
    renderer.act(() => { (getCredits.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/pricing');
  });

  it('shows the balance the unlock can spend, and why a total that covers the price does not', () => {
    // 1,200 credits, every one of them welcome or referral credits.
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 0;
    const tree = renderScreen();

    expect(textOf(balanceLine(tree))).toBe('Costs 900 credits · Balance 0');
    expect(balanceLine(tree).props.color).toBe('warning');
    expect(texts(tree)).toContain(`You need 900 more credits. ${PROMOTIONAL_NOTE}`);
    // Said once, with the shortfall.
    expect(texts(tree).filter((text) => text.includes(PROMOTIONAL_NOTE))).toHaveLength(1);

    const buy = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    expect(buy?.props.disabled).toBe(true);
    const getCredits = tree.root.findAll((node) => String(node.type) === 'secondary-button'
      && node.props.label === 'Get credits');
    expect(getCredits).toHaveLength(1);
  });

  it('says this balance leaves out welcome and referral credits even when it covers the price', () => {
    authState.credits = 2000;
    authState.marketplaceSpendableCredits = 1500;
    const tree = renderScreen();

    expect(textOf(balanceLine(tree))).toBe('Costs 900 credits · Balance 1500');
    expect(balanceLine(tree).props.color).toBe('success');
    expect(texts(tree)).toContain(PROMOTIONAL_NOTE);

    const buy = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    expect(buy?.props.disabled).toBe(false);
    expect(tree.root.findAll((node) => String(node.type) === 'secondary-button'
      && node.props.label === 'Get credits')).toHaveLength(0);
  });

  it('shows the whole balance, with no note, when every credit can be spent', () => {
    const tree = renderScreen();

    expect(textOf(balanceLine(tree))).toBe('Costs 900 credits · Balance 2000');
    expect(texts(tree).some((text) => text.includes(PROMOTIONAL_NOTE))).toBe(false);
  });

  it('signs a signed-out buyer in and brings them back to this unlock', () => {
    authState.user = null;
    const tree = renderScreen();

    const signIn = tree.root.findAll((node) => String(node.type) === 'primary-button'
      && node.props.label === 'Sign in to unlock')[0];
    if (!signIn) throw new Error('No sign-in button');
    renderer.act(() => { (signIn.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/marketplace/asset-1' } });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("signs the bundle's files to open in place, through the batched signing", async () => {
    authState.api.resolvePostResourceFileUrl.mockResolvedValue('https://storage.test/signed');
    const tree = renderScreen();

    const content = tree.root.findAll((node) => String(node.type) === 'bundle-content')[0];
    if (!content) throw new Error('No bundle content');
    await expect((content.props.resolveFileUrl as (path: string) => Promise<string>)('refs/look.jpg'))
      .resolves.toBe('https://storage.test/signed');
    expect(authState.api.resolvePostResourceFileUrl).toHaveBeenCalledWith('post-1', 'refs/look.jpg', { disposition: 'inline' });
  });

  it('keeps a free unlock one tap, with no confirmation sheet', () => {
    queryState.data = { ...paidDetail(0), accessMode: 'free' };
    const tree = renderScreen();

    const get = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    if (!get) throw new Error('No free unlock button');
    expect(get.props.label).toBe('Get free recipe');

    renderer.act(() => { (get.props.onPress as () => void)(); });
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

// Decision 1 (2026-10-17): the noun is "Recipe" and "Unlock" stays the verb on
// the buttons; the creator reads their own recipe as its owner, as Details and
// the web panel say.
describe('marketplace asset screen recipe words', () => {
  function sectionTitle(tree: renderer.ReactTestRenderer) {
    return tree.root.findAll((node) => String(node.type) === 'section-title')[0]?.props as Record<string, unknown>;
  }

  function statusTitles(tree: renderer.ReactTestRenderer) {
    return tree.root.findAll((node) => String(node.type) === 'status-block').map((node) => node.props.title);
  }

  it('names the page a recipe and says what is in it, with Unlock left the verb', () => {
    const tree = renderScreen();

    expect(sectionTitle(tree).eyebrow).toBe('Recipe details');
    expect(texts(tree)).toContain('In this recipe');
    expect(tree.root.findAll((node) => String(node.type) === 'primary-button')[0]?.props.label).toBe('Unlock for 900 credits');
  });

  it('tells a buyer the recipe is unlocked and on their account', () => {
    queryState.data = { ...paidDetail(), viewerCanAccess: true, viewerHasPurchased: true, viewerIsOwner: false };
    const tree = renderScreen();

    expect(texts(tree)).toEqual(expect.arrayContaining(['In this recipe', 'Unlocked', 'This recipe is on your account.']));
    // "Your recipe" is the creator's own (glossary, 2026-10-27).
    expect(texts(tree)).not.toContain('Your recipe');
    expect(texts(tree)).not.toContain('Owner access');
    expect(texts(tree).some((text) => /resource/i.test(text))).toBe(false);
  });

  it('tells the creator they read it as its owner, not that they unlocked it', () => {
    queryState.data = { ...paidDetail(), viewerCanAccess: true, viewerHasPurchased: false, viewerIsOwner: true };
    const tree = renderScreen();

    expect(texts(tree)).toContain('Owner access');
    expect(texts(tree)).not.toContain('Unlocked');
  });

  // Under the Recipe header the page read "Recipe" while it loaded and after a failed read, over the failure's own
  // notice (redundant-UI audit, 2026-10-21): the header names the page, so a heading waits for the recipe's title.
  it('calls a recipe that is gone unavailable, and a failed read a recipe to retry, in the notice alone', () => {
    queryState.data = null;
    queryState.error = new ApiError('Not found', 404);
    const gone = renderScreen();
    expect(statusTitles(gone)).toEqual(['Recipe unavailable']);
    expect(gone.root.findAll((node) => String(node.type) === 'status-block')[0]?.props.body).toBe('This recipe may be unlisted, private, or removed.');
    expect(sectionTitle(gone)).toBeUndefined();
    expect(gone.root.findAll((node) => String(node.type) === 'detail-skeleton')).toHaveLength(0);

    queryState.error = new Error('Network request failed.');
    const failed = renderScreen();
    expect(statusTitles(failed)).toEqual(['Could not load recipe']);
    expect(sectionTitle(failed)).toBeUndefined();
    expect(failed.root.findAll((node) => String(node.type) === 'detail-skeleton')).toHaveLength(0);
    expect(failed.root.findAll((node) => String(node.type) === 'secondary-button').map((node) => node.props.label)).toEqual(['Retry recipe']);
  });

  // React Query keeps a loaded recipe and sets the error when a refresh fails (a return to the app past the
  // 45 s stale time, offline), and the notice was drawn above the recipe and its live Unlock button.
  it('keeps a loaded recipe on screen, with no failure notice, when a refresh fails', () => {
    for (const error of [new Error('Network request failed.'), new ApiError('Not found', 404)]) {
      queryState.error = error;
      const tree = renderScreen();
      expect(statusTitles(tree)).toEqual([]);
      expect(sectionTitle(tree).title).toBe(paidDetail().title);
      expect(tree.root.findAll((node) => String(node.type) === 'primary-button')[0]?.props.label).toBe('Unlock for 900 credits');
    }
  });

  it('draws only the skeleton while the recipe loads', () => {
    queryState.data = null;
    queryState.isLoading = true;
    const tree = renderScreen();
    expect(tree.root.findAll((node) => String(node.type) === 'detail-skeleton')).toHaveLength(1);
    expect(sectionTitle(tree)).toBeUndefined();
    expect(statusTitles(tree)).toEqual([]);
  });
});

// Recipe audit 2026-10-27: B-F19 (the creator's blurb printed twice), B-F3
// (Remix sold with the recipe never named), B-F10 (one action, many words),
// S3 (a price that moved under the buyer).
describe('marketplace asset screen after the recipe audit', () => {
  function textCount(tree: renderer.ReactTestRenderer, value: string) {
    return texts(tree).filter((text) => text === value).length;
  }

  it('prints the creator\'s line once when the preview repeats the summary', () => {
    queryState.data = { ...paidDetail(), summary: 'Three looks from one prompt.', previewText: 'Three looks from one prompt.' };
    const tree = renderScreen();

    expect(textCount(tree, 'Three looks from one prompt.')).toBe(1);
  });

  it('prints a preview that says something else under the summary, and no filler without one', () => {
    queryState.data = { ...paidDetail(), summary: 'Three looks.', previewText: 'Includes the prompt.' };
    const both = renderScreen();
    expect(texts(both)).toEqual(expect.arrayContaining(['Three looks.', 'Includes the prompt.']));

    queryState.data = { ...paidDetail(), summary: 'Three looks.', previewText: '' };
    const summaryOnly = renderScreen();
    expect(texts(summaryOnly).filter((text) => text.startsWith('This recipe includes'))).toEqual([]);
  });

  it('names the Remix a recipe comes with, before and after unlocking', () => {
    queryState.data = { ...paidDetail(), allowRemix: true };
    const locked = renderScreen();
    expect(locked.root.findAll((node) => String(node.type) === 'pill').map((node) => node.props.label)).toContain('Remix included');

    queryState.data = { ...paidDetail(), allowRemix: true, viewerCanAccess: true, viewerHasPurchased: true };
    const unlocked = renderScreen();
    expect(unlocked.root.findAll((node) => String(node.type) === 'pill').map((node) => node.props.label)).toContain('Remix included');

    queryState.data = { ...paidDetail(), allowRemix: false };
    const without = renderScreen();
    expect(without.root.findAll((node) => String(node.type) === 'pill').map((node) => node.props.label)).not.toContain('Remix included');
  });

  it('asks a signed-out reader to sign in to unlock the recipe', () => {
    authState.user = null;
    const tree = renderScreen();

    expect(texts(tree)).toContain('Sign in to unlock this recipe.');
    expect(texts(tree).some((text) => /resource/i.test(text))).toBe(false);
  });

  it('says the price moved, not that the unlock failed, when the creator repriced it', () => {
    mutationState.variables = { postId: 'post-1', resourceId: 'asset-1', accessMode: 'paid', priceUsdCents: 900 };
    mutationState.error = Object.assign(new Error('The price changed to 1200 credits.'), {
      status: 409,
      code: 'RESOURCE_PRICE_CHANGED',
      details: { success: false, code: 'RESOURCE_PRICE_CHANGED', error: 'The price changed to 1200 credits.', priceCredits: 1200 },
    });
    const tree = renderScreen();

    const notice = tree.root.findAll((node) => String(node.type) === 'status-block')[0];
    expect(notice?.props).toMatchObject({ title: 'Price changed', body: 'The price changed to 1,200 credits.' });
  });
});

