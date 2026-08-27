// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  router: { push: routerPush, replace: vi.fn(), canGoBack: () => true },
}));

vi.mock('react-native', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  PackageOpen: (props: MockProps) => React.createElement('icon', { name: 'PackageOpen', ...props }),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/skeleton', () => ({
  CardListSkeleton: (props: MockProps) => React.createElement('card-list-skeleton', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, api: {} }),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: () => ({
    data: {
      pages: [{
        items: [{
          unlockId: 'unlock-1',
          title: 'Moody Bathroom Portrait Prompt Pack',
          creator: { displayName: 'fluffy' },
          purchasePriceUsdCents: 900,
          purchasedAt: '2026-08-12T00:00:00.000Z',
          post: { mediaUrl: null },
        }],
        pageInfo: { total: 1, nextOffset: null },
      }],
    },
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import UnlocksScreen from '../app/unlocks';

beforeEach(() => {
  routerPush.mockClear();
});

describe('unlocks library (HIG S7)', () => {
  it('wires each row as a labelled button that opens its unlock', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(React.createElement(UnlocksScreen));
    });

    const row = tree.root.findAll((node) => String(node.type) === 'pressable'
      && String(node.props.accessibilityLabel ?? '').startsWith('Moody Bathroom'))[0];
    if (!row) throw new Error('No unlock row rendered');

    expect(row.props.accessibilityRole).toBe('button');
    expect(String(row.props.accessibilityLabel)).toContain('by fluffy');
    expect(String(row.props.accessibilityLabel)).toContain('900 credits');

    renderer.act(() => { (row.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/unlock/unlock-1');
  });

  it('holds the thumbnail slot with the placeholder when a row has no media', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(React.createElement(UnlocksScreen));
    });

    expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'PackageOpen')).toHaveLength(1);
    expect(tree.root.findAll((node) => String(node.type) === 'image')).toHaveLength(0);
  });
});
