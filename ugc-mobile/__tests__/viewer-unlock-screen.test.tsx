import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; label?: string; title?: string; body?: string } & Record<string, unknown>;

const { authUser, contentProps, detailRefetch, openURL, platform, queryError, routerPush, unlockApi, unlockDetail } = vi.hoisted(() => ({
  authUser: { current: { id: 'buyer-1' } as { id: string } | null },
  contentProps: vi.fn(),
  detailRefetch: vi.fn(),
  openURL: vi.fn(),
  platform: { OS: 'ios' },
  queryError: { current: null as unknown },
  routerPush: vi.fn(),
  // One object for every render, as the real context provides.
  unlockApi: { resolveViewerUnlockFileUrl: vi.fn() },
  unlockDetail: { current: null as Record<string, unknown> | null },
}));
// What the website preference allows, as the hook reports it; each test sets it.
const reveal = vi.hoisted(() => ({ current: 'show' as 'show' | 'website' | 'pending' | 'never' }));
const useMatureReveal = vi.hoisted(() => vi.fn((_needed: boolean) => reveal.current));

vi.mock('react-native', () => ({
  Linking: { openURL },
  Platform: platform,
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  EyeOff: (props: MockProps) => React.createElement('icon', { name: 'EyeOff', ...props }),
  Play: (props: MockProps) => React.createElement('icon', { name: 'Play', ...props }),
}));

vi.mock('expo-router', () => ({
  router: { push: routerPush },
  Stack: { Screen: (props: Record<string, unknown>) => React.createElement('stack-screen', props) },
  useLocalSearchParams: () => ({ unlockId: 'unlock-1' }),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: unlockDetail.current, isLoading: false, error: queryError.current, refetch: detailRefetch }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: authUser.current, api: unlockApi }),
}));

vi.mock('@/lib/api-client', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: (props: MockProps) => React.createElement('media-preview', props),
}));

vi.mock('@/components/skeleton', () => ({
  DetailSkeleton: (props: MockProps) => React.createElement('detail-skeleton', props),
}));

vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-player', props),
}));

vi.mock('@/components/post-resource-bundle-content', async () => {
  // The references inside read whether they are covered from this context.
  const { MatureMediaCovered } = await import('@/components/mature-cover');
  return {
    PostResourceBundleContent: (props: Record<string, unknown>) => {
      contentProps({ ...props, mediaCovered: React.useContext(MatureMediaCovered) });
      return null;
    },
    ResourceRevisionSwitch: ({ selected, onSelect }: { selected: string; onSelect: (revision: string) => void }) => React.createElement(
      'view',
      {},
      ['latest', 'purchased'].map((revision) => React.createElement('pressable', {
        key: revision,
        accessibilityLabel: `Show ${revision} recipe version`,
        accessibilityState: { selected: selected === revision },
        onPress: () => onSelect(revision),
      })),
    ),
  };
});

vi.mock('@/lib/use-mature-reveal', () => ({ useMatureReveal }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.test' } }));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Pill: ({ label, ...props }: MockProps) => React.createElement('text', props, label),
  PrimaryButton: ({ label, ...props }: MockProps) => React.createElement('button', props, label),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: ({ label, ...props }: MockProps) => React.createElement('button', props, label),
  SectionTitle: ({ title, body, ...props }: MockProps) => React.createElement(
    'section-title',
    props,
    React.createElement('text', {}, title),
    React.createElement('text', {}, body),
  ),
  StatusBlock: ({ title, body, ...props }: MockProps) => React.createElement('status', { title, body, ...props }, title, body),
}));

import { ApiError } from '@/lib/api-client';
import ViewerUnlockScreen from '../app/unlock/[unlockId]';

const latestMedia = [
  { id: 'latest-1', mediaKey: 'latest-key', url: 'https://cdn/latest.jpg', mediaKind: 'image', sortOrder: 0 },
];
const purchasedMedia = [
  { id: 'purchased-1', mediaKey: 'purchased-key', url: '', mediaKind: 'image', sortOrder: 0 },
];
// As the server sends them: `attachments` is always an array (normalizeAttachments).
const latestResources = { promptText: 'Latest prompt', items: [], attachments: [] };
const purchasedResources = { promptText: 'Purchased prompt', items: [], attachments: [] };
const livePost = {
  id: 'post-1',
  title: 'Launch',
  body: '',
  mediaUrl: 'https://cdn.test/look.jpg',
  mediaKind: 'image',
  mediaPreviewUrl: '/api/media?bucket=post_media&path=still.webp',
  visibility: 'public',
  archivedAt: null,
  tombstoned: false,
};

function textValues(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')
    .flatMap((node) => typeof node.props.children === 'string' ? [node.props.children] : []);
}

function buttonLabels(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'button').map((node) => node.props.children);
}

function pressButton(tree: renderer.ReactTestRenderer, label: string) {
  renderer.act(() => {
    tree.root.find((node) => String(node.type) === 'button' && node.props.children === label).props.onPress();
  });
}

function statusBlocks(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'status')
    .map((node) => ({ title: node.props.title, body: node.props.body }));
}

function byType(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.findAll((node) => String(node.type) === type);
}

function lastContentProps() {
  return contentProps.mock.calls.at(-1)?.[0] as { mediaItems: unknown[]; resources: unknown; mediaCovered: boolean };
}

function renderScreen() {
  let tree: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<ViewerUnlockScreen />);
  });
  return tree!;
}

beforeEach(() => {
  authUser.current = { id: 'buyer-1' };
  platform.OS = 'ios';
  reveal.current = 'show';
  useMatureReveal.mockClear();
  openURL.mockClear();
  queryError.current = null;
  routerPush.mockClear();
  contentProps.mockClear();
  detailRefetch.mockClear();
  unlockDetail.current = {
    unlockId: 'unlock-1',
    postId: 'post-1',
    title: 'Latest title',
    summary: 'Latest summary',
    previewText: 'Latest preview',
    accessMode: 'paid',
    priceUsdCents: 900,
    purchasePriceUsdCents: 500,
    paidWith: 'credits',
    paidAmountSubunits: 500,
    paidCurrency: null,
    creatorDisplayName: 'Creator',
    detached: false,
    tombstoned: false,
    retired: false,
    isNsfw: false,
    postReachable: false,
    hasNewerRevision: true,
    currentResources: latestResources,
    mediaItems: latestMedia,
    purchasedRevision: {
      revisionNumber: 2,
      title: 'Purchased title',
      summary: 'Purchased summary',
      previewText: 'Purchased preview',
      accessMode: 'free',
      priceUsdCents: 0,
      resources: purchasedResources,
      mediaItems: purchasedMedia,
    },
    post: null,
  };
});

describe('viewer unlock revision switching', () => {
  it('switches metadata, resources, and proof-media scope targets together', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ViewerUnlockScreen />);
    });

    expect(textValues(tree!)).toEqual(expect.arrayContaining(['Latest title', 'Latest summary']));
    expect(contentProps).toHaveBeenLastCalledWith(expect.objectContaining({
      resources: latestResources,
      mediaItems: latestMedia,
    }));

    const purchasedButton = tree!.root.find(
      (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Show purchased recipe version'
    );
    renderer.act(() => {
      purchasedButton.props.onPress();
    });

    expect(textValues(tree!)).toEqual(expect.arrayContaining(['Purchased title', 'Purchased summary']));
    expect(textValues(tree!)).not.toContain('Latest title');
    expect(contentProps).toHaveBeenLastCalledWith(expect.objectContaining({
      resources: purchasedResources,
      mediaItems: purchasedMedia,
    }));
  });

  it('says why there are two versions beside the switch', () => {
    const line = 'The creator has updated this recipe since you bought it. You can read either version.';
    expect(textValues(renderScreen())).toContain(line);

    unlockDetail.current = { ...unlockDetail.current!, hasNewerRevision: false };
    expect(textValues(renderScreen())).not.toContain(line);
  });

  it('leads to the original post only while the server says it opens for this buyer', () => {
    unlockDetail.current = { ...unlockDetail.current!, post: livePost, postReachable: true };
    let tree = renderScreen();
    expect(buttonLabels(tree)).toContain('View original post');
    pressButton(tree, 'View original post');
    expect(routerPush).toHaveBeenCalledWith('/showcase/post-1');

    unlockDetail.current = { ...unlockDetail.current!, post: { ...livePost, visibility: 'unlisted' }, postReachable: true };
    tree = renderScreen();
    expect(buttonLabels(tree)).toContain('View original post');
  });

  it('says why, instead of a dead link, when the post went private or was archived', () => {
    for (const post of [
      { ...livePost, visibility: 'private' },
      { ...livePost, archivedAt: '2026-10-01T00:00:00.000Z' },
      null,
    ]) {
      unlockDetail.current = { ...unlockDetail.current!, post, postVisibility: post?.visibility ?? null, postReachable: false };
      const tree = renderScreen();
      expect(buttonLabels(tree)).not.toContain('View original post');
      expect(textValues(tree)).toContain('This post is no longer public. Your recipe stays available here.');
    }
  });

  it('sends a buyer on neither side of a block to a post that will not open (03-7)', () => {
    unlockDetail.current = { ...unlockDetail.current!, post: livePost, postVisibility: 'public', postReachable: false };
    const tree = renderScreen();

    expect(buttonLabels(tree)).not.toContain('View original post');
    expect(textValues(tree)).toContain("This post isn't available to you. Your recipe stays here.");
  });

  it("signs the purchase's files through the batched signing, to open in place", async () => {
    unlockApi.resolveViewerUnlockFileUrl.mockReset();
    unlockApi.resolveViewerUnlockFileUrl.mockResolvedValue('https://storage.test/signed');
    openURL.mockClear();
    renderScreen();

    const props = contentProps.mock.calls.at(-1)?.[0] as {
      resolveFileUrl: (storagePath: string) => Promise<string>;
      onOpenFile: (file: { storagePath: string; title: string; contentType: string | null }) => Promise<void>;
    };
    await expect(props.resolveFileUrl('retained/look.jpg')).resolves.toBe('https://storage.test/signed');
    expect(unlockApi.resolveViewerUnlockFileUrl).toHaveBeenCalledWith('unlock-1', 'retained/look.jpg', { disposition: 'inline' });

    await renderer.act(async () => {
      await props.onOpenFile({ storagePath: 'retained/guide.pdf', title: 'Guide', contentType: 'application/pdf' });
    });
    expect(unlockApi.resolveViewerUnlockFileUrl).toHaveBeenLastCalledWith('unlock-1', 'retained/guide.pdf', { disposition: 'inline' });
    expect(openURL).toHaveBeenCalledWith('https://storage.test/signed');
  });

  it('brings a signed-out buyer back to this unlock after sign-in', () => {
    authUser.current = null;
    const tree = renderScreen();

    pressButton(tree, 'Sign in');
    expect(routerPush).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/unlock/unlock-1' } });
  });
});

describe('what the purchase cost (03-2)', () => {
  it('names a credit unlock by the credits it took', () => {
    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'credits', paidAmountSubunits: 900 };
    expect(textValues(renderScreen())).toContain('900 credits paid');
  });

  it('names a cash purchase in the currency it was paid in on Android', () => {
    platform.OS = 'android';
    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' };
    expect(textValues(renderScreen())).toContain('₹750 paid');

    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'USD' };
    expect(textValues(renderScreen())).toContain('$9.00 paid');
  });

  it('says only "Paid" for a cash purchase on iOS, with no amount', () => {
    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' };
    const texts = textValues(renderScreen());

    expect(texts).toContain('Paid');
    expect(texts.join(' ')).not.toMatch(/₹|INR|750/);
  });

  it('calls a free unlock free', () => {
    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'free', paidAmountSubunits: null, purchasePriceUsdCents: 0 };
    expect(textValues(renderScreen())).toContain('Free unlock');
  });
});

describe('the cover', () => {
  it("draws a picture post from its still, not the original", () => {
    unlockDetail.current = { ...unlockDetail.current!, post: livePost };
    const tree = renderScreen();

    expect(byType(tree, 'media-preview').map((node) => [node.props.url, node.props.kind]))
      .toEqual([['/api/media?bucket=post_media&path=still.webp', 'image']]);
    expect(byType(tree, 'video-player')).toHaveLength(0);
  });

  it('keeps a video behind its poster, and builds the player only on Play', () => {
    unlockDetail.current = {
      ...unlockDetail.current!,
      post: { ...livePost, mediaKind: 'video', mediaUrl: 'https://cdn.test/clip.mp4', mediaPreviewUrl: '/api/media?bucket=post_media&path=poster.webp' },
    };
    const tree = renderScreen();

    expect(byType(tree, 'media-preview').map((node) => [node.props.url, node.props.kind]))
      .toEqual([['/api/media?bucket=post_media&path=poster.webp', 'image']]);
    expect(byType(tree, 'video-player')).toHaveLength(0);

    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Play video').props.onPress();
    });

    const [player] = byType(tree, 'video-player');
    expect(player?.props).toEqual(expect.objectContaining({ url: 'https://cdn.test/clip.mp4', autoPlay: true, nativeControls: true }));
    expect(byType(tree, 'media-preview')).toHaveLength(0);
  });

  it('offers Play on a plain frame for a video with no poster', () => {
    unlockDetail.current = {
      ...unlockDetail.current!,
      post: { ...livePost, mediaKind: 'video', mediaUrl: 'https://cdn.test/clip.mp4', mediaPreviewUrl: null },
    };
    const tree = renderScreen();

    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(byType(tree, 'video-player')).toHaveLength(0);
    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Play video').props.onPress();
    });
    expect(byType(tree, 'video-player')[0]?.props.url).toBe('https://cdn.test/clip.mp4');
  });
});

describe('a mature unlock', () => {
  const GUIDANCE = 'Mature content is off by default. Adults can enable it on the Magicbooklet website, then return here to show it.';
  const referencePicture = {
    type: 'reference_image', role: 'character_reference', sectionId: null, title: '@alisa', description: null, textContent: null,
    externalUrl: null, storagePath: 'references/alisa.jpg', contentType: 'image/jpeg', sizeBytes: 1200, workflowSnapshot: null,
    sortOrder: 0, isPrimary: true, remixUse: 'reference_only',
  };

  beforeEach(() => {
    unlockDetail.current = { ...unlockDetail.current!, isNsfw: true, post: livePost };
  });

  it('covers the cover, the outputs and the references, keeps the resources, and shows them in place on Show', () => {
    const tree = renderScreen();

    expect(textValues(tree)).toContain('Mature content');
    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(lastContentProps()).toEqual(expect.objectContaining({ mediaItems: [], resources: latestResources, mediaCovered: true }));
    expect(useMatureReveal).toHaveBeenLastCalledWith(true);

    pressButton(tree, 'Show');

    expect(byType(tree, 'media-preview').map((node) => node.props.url)).toEqual(['/api/media?bucket=post_media&path=still.webp']);
    expect(lastContentProps().mediaItems).toBe(latestMedia);
    expect(lastContentProps().mediaCovered).toBe(false);
    expect(textValues(tree)).not.toContain('Mature content');
  });

  it('still offers Show for the outputs of a mature unlock with no cover to draw', () => {
    unlockDetail.current = { ...unlockDetail.current!, post: null };
    const tree = renderScreen();

    expect(lastContentProps().mediaItems).toEqual([]);
    pressButton(tree, 'Show');

    expect(lastContentProps().mediaItems).toBe(latestMedia);
    expect(byType(tree, 'media-preview').map((node) => node.props.url)).toEqual([null]);
  });

  it('still offers Show when only reference pictures are mature', () => {
    unlockDetail.current = {
      ...unlockDetail.current!,
      post: null,
      mediaItems: [],
      currentResources: { ...latestResources, items: [referencePicture] },
    };
    const tree = renderScreen();

    expect(textValues(tree)).toContain('Mature content');
    expect(lastContentProps().mediaCovered).toBe(true);
    pressButton(tree, 'Show');
    expect(lastContentProps().mediaCovered).toBe(false);
  });

  it('draws no plate for a mature unlock with nothing to draw', () => {
    unlockDetail.current = { ...unlockDetail.current!, post: null, mediaItems: [] };
    const tree = renderScreen();

    expect(textValues(tree)).not.toContain('Mature content');
    expect(lastContentProps().mediaCovered).toBe(false);
    expect(useMatureReveal).toHaveBeenLastCalledWith(false);
  });

  it("sends a viewer whose preference is off to the post's page on the website, and shows nothing", () => {
    reveal.current = 'website';
    unlockDetail.current = { ...unlockDetail.current!, postReachable: true };
    const tree = renderScreen();

    expect(textValues(tree)).toContain(GUIDANCE);
    expect(buttonLabels(tree)).not.toContain('Show');
    pressButton(tree, 'Manage on website');
    expect(openURL).toHaveBeenCalledWith('https://magicbooklet.test/showcase/post-1');
    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(lastContentProps()).toEqual(expect.objectContaining({ mediaItems: [], resources: latestResources, mediaCovered: true }));
  });

  it("keeps the guidance without a link when the post's page would not open for this buyer", () => {
    reveal.current = 'website';
    const tree = renderScreen();

    expect(textValues(tree)).toContain(GUIDANCE);
    expect(buttonLabels(tree)).not.toContain('Manage on website');
    expect(buttonLabels(tree)).not.toContain('Show');
  });

  it('offers nothing while the preference is still being read', () => {
    reveal.current = 'pending';
    const tree = renderScreen();

    expect(buttonLabels(tree)).not.toContain('Show');
    expect(textValues(tree)).not.toContain(GUIDANCE);
    expect(byType(tree, 'media-preview')).toHaveLength(0);
  });

  it('covers it all again when the preference is turned off on the website', () => {
    const tree = renderScreen();
    pressButton(tree, 'Show');
    expect(byType(tree, 'media-preview')).toHaveLength(1);

    reveal.current = 'website';
    renderer.act(() => { tree.update(<ViewerUnlockScreen />); });

    expect(textValues(tree)).toContain(GUIDANCE);
    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(lastContentProps()).toEqual(expect.objectContaining({ mediaItems: [], mediaCovered: true }));
  });

  it('stays covered on Android, which shows no mature media, with the resources still open', () => {
    platform.OS = 'android';
    reveal.current = 'never';
    unlockDetail.current = { ...unlockDetail.current!, postReachable: true };
    const tree = renderScreen();

    expect(buttonLabels(tree)).not.toContain('Show');
    expect(buttonLabels(tree)).not.toContain('Manage on website');
    expect(textValues(tree)).toContain('The creator marked this post NSFW. Mature posts stay covered in this app.');
    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(lastContentProps()).toEqual(expect.objectContaining({ mediaItems: [], resources: latestResources, mediaCovered: true }));
  });
});

describe('when the unlock does not load (03-5)', () => {
  beforeEach(() => {
    unlockDetail.current = null;
  });

  it('tells a missing unlock apart, with no retry that could bring it back', () => {
    queryError.current = new ApiError('Unlock not found.', 404);
    const tree = renderScreen();

    expect(statusBlocks(tree)).toEqual([{ title: 'Recipe unavailable', body: 'It may have been removed by moderation, or belong to another account.' }]);
    expect(buttonLabels(tree)).not.toContain('Retry');
    // The notice is the page: a heading over it said "Recipe" and "This recipe could not be opened."
    expect(byType(tree, 'section-title')).toHaveLength(0);
    expect(byType(tree, 'detail-skeleton')).toHaveLength(0);
  });

  it('calls anything else a connection problem, and retries', () => {
    for (const error of [new Error('Network request failed. Please check your connection and try again.'), new ApiError('Server error', 500)]) {
      queryError.current = error;
      const tree = renderScreen();

      expect(statusBlocks(tree)).toEqual([{ title: 'Could not load your recipe', body: 'Check your connection, then try again.' }]);
      expect(byType(tree, 'section-title')).toHaveLength(0);
      expect(byType(tree, 'detail-skeleton')).toHaveLength(0);
      pressButton(tree, 'Retry');
    }
    expect(detailRefetch).toHaveBeenCalledTimes(2);
  });

  // Under the Your Recipe header the page read "Recipe" until the recipe was in (redundant-UI audit, 2026-10-21).
  // The screen shows the skeleton whenever it has no recipe and no failure, which covers a load in progress.
  it('draws only the skeleton while it loads, under the header that names the page', () => {
    const tree = renderScreen();

    expect(byType(tree, 'detail-skeleton')).toHaveLength(1);
    expect(byType(tree, 'section-title')).toHaveLength(0);
    expect(statusBlocks(tree)).toEqual([]);
  });

  it('leaves a loaded unlock on screen when a refresh fails', () => {
    queryError.current = new Error('offline');
    unlockDetail.current = {
      unlockId: 'unlock-1', postId: null, title: 'Kept title', summary: '', previewText: '', accessMode: 'free', priceUsdCents: 0,
      purchasePriceUsdCents: 0, paidWith: 'free', paidAmountSubunits: null, paidCurrency: null, creatorDisplayName: 'Creator',
      detached: false, tombstoned: false, retired: false, isNsfw: false, postReachable: false, hasNewerRevision: false,
      currentResources: latestResources, mediaItems: [], post: null,
      purchasedRevision: { revisionNumber: 1, title: 'Kept title', summary: '', previewText: '', accessMode: 'free', priceUsdCents: 0, resources: latestResources, mediaItems: [] },
    };
    const tree = renderScreen();

    expect(statusBlocks(tree)).toEqual([]);
    expect(textValues(tree)).toContain('Kept title');
  });
});

// Recipe audit B-F10 (2026-10-27): one thing, one word. The receipt spoke of
// "resources", "retained resources" and "this listing".
describe('the receipt in recipe words', () => {
  it('titles the page Recipe, as the recipe screen is titled', () => {
    const tree = renderScreen();
    expect(byType(tree, 'stack-screen')[0]?.props.options).toMatchObject({ title: 'Recipe' });
  });

  it('tells a signed-out reader who can open it', () => {
    authUser.current = null;
    const tree = renderScreen();
    expect(textValues(tree)).toContain('Only the account that unlocked it can open it.');
  });

  it('says what became of a recipe the creator stopped selling, removed, or left with', () => {
    unlockDetail.current = { ...unlockDetail.current!, retired: true };
    expect(textValues(renderScreen())).toContain('This recipe is no longer sold. Yours stays here.');

    unlockDetail.current = { ...unlockDetail.current!, retired: false, tombstoned: true };
    expect(textValues(renderScreen())).toContain('The creator removed this post. Your recipe stays here.');

    unlockDetail.current = { ...unlockDetail.current!, tombstoned: false, detached: true };
    expect(textValues(renderScreen())).toContain('The creator deleted their account. You keep the version you unlocked and its files.');
  });

  it('falls back to recipe words when the creator wrote nothing', () => {
    unlockDetail.current = {
      ...unlockDetail.current!,
      summary: '',
      previewText: '',
      purchasedRevision: { ...(unlockDetail.current!.purchasedRevision as Record<string, unknown>), summary: '', previewText: '' },
    };
    const values = textValues(renderScreen());
    expect(values).toContain('The prompt, files and notes behind this post.');
    expect(values.some((value) => /resource/i.test(value))).toBe(false);
  });

  it('names a file that will not open a file', async () => {
    unlockApi.resolveViewerUnlockFileUrl.mockReset();
    unlockApi.resolveViewerUnlockFileUrl.mockRejectedValue(new Error('Signed link expired.'));
    const tree = renderScreen();

    const props = contentProps.mock.calls.at(-1)?.[0] as {
      onOpenFile: (file: { storagePath: string; title: string; contentType: string | null }) => Promise<void>;
    };
    await renderer.act(async () => {
      await props.onOpenFile({ storagePath: 'retained/guide.pdf', title: 'Guide', contentType: 'application/pdf' });
    });
    expect(statusBlocks(tree)).toContainEqual({ title: 'File unavailable', body: 'Signed link expired.' });
  });
});

