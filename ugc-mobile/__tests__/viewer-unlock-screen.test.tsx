import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; label?: string; title?: string; body?: string } & Record<string, unknown>;

const { contentProps, unlockDetail } = vi.hoisted(() => ({
  contentProps: vi.fn(),
  unlockDetail: { current: null as Record<string, unknown> | null },
}));

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  useLocalSearchParams: () => ({ unlockId: 'unlock-1' }),
}));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: unlockDetail.current, isLoading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'buyer-1' }, api: {} }),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: () => null,
}));

vi.mock('@/components/post-resource-bundle-content', () => ({
  PostResourceBundleContent: (props: unknown) => {
    contentProps(props);
    return null;
  },
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

describe('viewer unlock revision switching', () => {
  beforeEach(() => {
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
});
