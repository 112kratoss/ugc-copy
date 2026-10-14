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

vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-player', props),
}));

vi.mock('@/components/post-resource-bundle-content', () => ({
  PostResourceBundleContent: (props: unknown) => {
    contentProps(props);
    return null;
  },
  ResourceRevisionSwitch: ({ selected, onSelect }: { selected: string; onSelect: (revision: string) => void }) => React.createElement(
    'view',
    {},
    ['latest', 'purchased'].map((revision) => React.createElement('pressable', {
      key: revision,
      accessibilityLabel: `Show ${revision} unlock version`,
      accessibilityState: { selected: selected === revision },
      onPress: () => onSelect(revision),
    })),
  ),
}));

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
const latestResources = { promptText: 'Latest prompt', items: [] };
const purchasedResources = { promptText: 'Purchased prompt', items: [] };
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
  return contentProps.mock.calls.at(-1)?.[0] as { mediaItems: unknown[]; resources: unknown };
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
      (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Show purchased unlock version'
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
    const line = 'The creator has updated this unlock since you bought it. You can read either version.';
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
      expect(textValues(tree)).toContain('This post is no longer public. Your unlock stays available here.');
    }
  });

  it('sends a buyer on neither side of a block to a post that will not open (03-7)', () => {
    unlockDetail.current = { ...unlockDetail.current!, post: livePost, postVisibility: 'public', postReachable: false };
    const tree = renderScreen();

    expect(buttonLabels(tree)).not.toContain('View original post');
    expect(textValues(tree)).toContain("This post isn't available to you. Your unlock stays here.");
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

  it('names a cash purchase in the currency it was paid in', () => {
    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' };
    expect(textValues(renderScreen())).toContain('₹750 paid');

    unlockDetail.current = { ...unlockDetail.current!, paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'USD' };
    expect(textValues(renderScreen())).toContain('$9.00 paid');
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
  beforeEach(() => {
    unlockDetail.current = { ...unlockDetail.current!, isNsfw: true, post: livePost };
  });

  it('covers the cover and the outputs, keeps the resources, and shows them in place on Show', () => {
    const tree = renderScreen();

    expect(textValues(tree)).toContain('Mature content');
    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(lastContentProps()).toEqual(expect.objectContaining({ mediaItems: [], resources: latestResources }));

    pressButton(tree, 'Show');

    expect(byType(tree, 'media-preview').map((node) => node.props.url)).toEqual(['/api/media?bucket=post_media&path=still.webp']);
    expect(lastContentProps().mediaItems).toBe(latestMedia);
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

  it('stays covered on Android, which shows no mature media, with the resources still open', () => {
    platform.OS = 'android';
    const tree = renderScreen();

    expect(buttonLabels(tree)).not.toContain('Show');
    expect(textValues(tree)).toContain('The creator marked this post NSFW. Mature posts stay covered in this app.');
    expect(byType(tree, 'media-preview')).toHaveLength(0);
    expect(lastContentProps()).toEqual(expect.objectContaining({ mediaItems: [], resources: latestResources }));
  });
});

describe('when the unlock does not load (03-5)', () => {
  beforeEach(() => {
    unlockDetail.current = null;
  });

  it('tells a missing unlock apart, with no retry that could bring it back', () => {
    queryError.current = new ApiError('Unlock not found.', 404);
    const tree = renderScreen();

    expect(statusBlocks(tree)).toEqual([{ title: 'Unlock unavailable', body: 'It may have been removed by moderation, or belong to another account.' }]);
    expect(buttonLabels(tree)).not.toContain('Retry');
    expect(textValues(tree)).toContain('This unlock could not be opened.');
    expect(textValues(tree)).not.toContain('Loading your purchased resources.');
  });

  it('calls anything else a connection problem, and retries', () => {
    for (const error of [new Error('Network request failed. Please check your connection and try again.'), new ApiError('Server error', 500)]) {
      queryError.current = error;
      const tree = renderScreen();

      expect(statusBlocks(tree)).toEqual([{ title: 'Could not load your unlock', body: 'Check your connection, then try again.' }]);
      expect(textValues(tree)).not.toContain('Loading your purchased resources.');
      pressButton(tree, 'Retry');
    }
    expect(detailRefetch).toHaveBeenCalledTimes(2);
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
