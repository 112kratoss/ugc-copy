import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; label?: string; title?: string; body?: string } & Record<string, unknown>;

const { authUser, contentProps, openURL, routerPush, unlockApi, unlockDetail } = vi.hoisted(() => ({
  authUser: { current: { id: 'buyer-1' } as { id: string } | null },
  contentProps: vi.fn(),
  openURL: vi.fn(),
  routerPush: vi.fn(),
  // One object for every render, as the real context provides.
  unlockApi: { resolveViewerUnlockFileUrl: vi.fn() },
  unlockDetail: { current: null as Record<string, unknown> | null },
}));

vi.mock('react-native', () => ({
  Linking: { openURL },
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-router', () => ({
  router: { push: routerPush },
  useLocalSearchParams: () => ({ unlockId: 'unlock-1' }),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: unlockDetail.current, isLoading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: authUser.current, api: unlockApi }),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: () => null,
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
  StatusBlock: ({ title, body, ...props }: MockProps) => React.createElement('status', props, title, body),
}));

import ViewerUnlockScreen from '../app/unlock/[unlockId]';

const latestMedia = [
  { id: 'latest-1', mediaKey: 'latest-key', url: 'https://cdn/latest.jpg', mediaKind: 'image', sortOrder: 0 },
];
const purchasedMedia = [
  { id: 'purchased-1', mediaKey: 'purchased-key', url: '', mediaKind: 'image', sortOrder: 0 },
];
const latestResources = { promptText: 'Latest prompt', items: [] };
const purchasedResources = { promptText: 'Purchased prompt', items: [] };

function textValues(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')
    .flatMap((node) => typeof node.props.children === 'string' ? [node.props.children] : []);
}

function buttonLabels(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'button').map((node) => node.props.children);
}

function renderScreen() {
  let tree: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<ViewerUnlockScreen />);
  });
  return tree!;
}

describe('viewer unlock revision switching', () => {
  beforeEach(() => {
    authUser.current = { id: 'buyer-1' };
    routerPush.mockClear();
    contentProps.mockClear();
    unlockDetail.current = {
      unlockId: 'unlock-1',
      postId: 'post-1',
      title: 'Latest title',
      summary: 'Latest summary',
      previewText: 'Latest preview',
      accessMode: 'paid',
      priceUsdCents: 900,
      purchasePriceUsdCents: 500,
      creatorDisplayName: 'Creator',
      detached: false,
      tombstoned: false,
      retired: false,
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

  it('leads to the original post only while it is public or unlisted', () => {
    unlockDetail.current = { ...unlockDetail.current!, post: { id: 'post-1', visibility: 'public', archivedAt: null, tombstoned: false } };
    let tree = renderScreen();
    expect(buttonLabels(tree)).toContain('View original post');
    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'button' && node.props.children === 'View original post').props.onPress();
    });
    expect(routerPush).toHaveBeenCalledWith('/showcase/post-1');

    unlockDetail.current = { ...unlockDetail.current!, post: { id: 'post-1', visibility: 'unlisted', archivedAt: null } };
    tree = renderScreen();
    expect(buttonLabels(tree)).toContain('View original post');
  });

  it('says why, instead of a dead link, when the post went private or was archived', () => {
    for (const post of [
      { id: 'post-1', visibility: 'private', archivedAt: null },
      { id: 'post-1', visibility: 'public', archivedAt: '2026-10-01T00:00:00.000Z' },
      null,
    ]) {
      unlockDetail.current = { ...unlockDetail.current!, post, postVisibility: post?.visibility ?? null };
      const tree = renderScreen();
      expect(buttonLabels(tree)).not.toContain('View original post');
      expect(textValues(tree)).toContain('This post is no longer public. Your unlock stays available here.');
    }
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

    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'button' && node.props.children === 'Sign in').props.onPress();
    });
    expect(routerPush).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/unlock/unlock-1' } });
  });
});
