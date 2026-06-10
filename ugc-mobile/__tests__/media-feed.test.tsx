// Define React Native development global
(global as any).__DEV__ = true;
(global as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(0);
  return 0;
};

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationListItem } from '../lib/types';

const routeState = vi.hoisted(() => ({
  params: {
    source: 'profile-creations',
    initialId: 'gen-4',
  },
}));
const flatListRefState = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
}));
const queryClientState = vi.hoisted(() => ({
  useNetworkData: true,
  invalidateQueries: vi.fn(),
}));

vi.mock('expo-router', () => ({
  Redirect: (props: Record<string, unknown>) => React.createElement('redirect', props),
  router: {
    back: vi.fn(),
    push: vi.fn(),
  },
  useLocalSearchParams: () => routeState.params,
}));

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Alert: { alert: vi.fn() },
  FlatList: React.forwardRef((props: MockProps, ref) => {
    React.useImperativeHandle(ref, () => flatListRefState);
    return React.createElement('flat-list', props);
  }),
  Linking: { openURL: vi.fn() },
  Modal: ({ children, ...props }: MockProps) => React.createElement('modal', props, children),
  Platform: {
    OS: 'android',
    select: (obj: any) => obj.android || obj.default,
  },
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  ScrollView: ({ children, ...props }: MockProps) =>
    React.createElement('scrollview', props, children),
  Share: { share: vi.fn() },
  StatusBar: { currentHeight: 24 },
  Text: ({ children, ...props }: MockProps) =>
    React.createElement('text', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: ({ children, ...props }: MockProps) =>
    React.createElement('view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: () => ({
    muted: true,
    pause: vi.fn(),
    play: vi.fn(),
  }),
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => {
  const mockIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement(`${name}-icon`, props);

  return {
    Archive: mockIcon('archive'),
    ArrowLeft: mockIcon('arrow-left'),
    Edit: mockIcon('edit'),
    Eye: mockIcon('eye'),
    EyeOff: mockIcon('eye-off'),
    FileText: mockIcon('file-text'),
    Globe: mockIcon('globe'),
    Heart: mockIcon('heart'),
    ImageIcon: mockIcon('image'),
    Images: mockIcon('images'),
    Lock: mockIcon('lock'),
    MoreVertical: mockIcon('more-vertical'),
    Play: mockIcon('play'),
    Share2: mockIcon('share'),
    Sparkles: mockIcon('sparkles'),
    Zap: mockIcon('zap'),
  };
});

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'user@example.com' },
  isLoading: false,
  api: {
    getProfile: vi.fn(),
    listGenerations: vi.fn(),
    listOwnerPosts: vi.fn(),
    getSavedMedia: vi.fn(),
    getShowcasePost: vi.fn(),
    getShowcaseFeed: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

function generation(id: string): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.example.com/${id}.jpg`,
    status: 'succeeded',
    created_at: '2026-06-10T00:00:00Z',
    completed_at: '2026-06-10T00:01:00Z',
    cost: 1,
    model: 'test-model',
    category: 'image',
    title: `Generation ${id}`,
    prompt: `Prompt ${id}`,
  };
}

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey, initialData }: { queryKey: string[]; initialData?: () => unknown }) => {
    if (queryKey[0] === 'profile') {
      return {
        data: { id: 'user-123', username: 'batman', displayName: 'Sassy23bh', avatarUrl: null },
        isLoading: false,
      };
    }

    if (queryKey[0] === 'media-feed-data') {
      if (!queryClientState.useNetworkData) {
        return {
          data: initialData?.(),
          isFetching: true,
          isLoading: false,
          refetch: vi.fn(),
        };
      }

      return {
        data: {
          generations: [
            generation('gen-1'),
            generation('gen-2'),
            generation('gen-3'),
            generation('gen-4'),
          ],
        },
        isLoading: false,
        refetch: vi.fn(),
      };
    }

    return { data: null, isLoading: false };
  },
  useQueryClient: () => ({
    getQueryData: (queryKey: string[]) => {
      if (queryKey[0] === 'profile-generations' && queryKey[1] === 'user-123') {
        return {
          generations: [
            generation('gen-1'),
            generation('gen-2'),
            generation('gen-3'),
            generation('gen-4'),
          ],
        };
      }
      return undefined;
    },
    getQueriesData: vi.fn(() => []),
    invalidateQueries: queryClientState.invalidateQueries,
  }),
}));

import MediaFeedScreen from '../app/media-feed';

describe('MediaFeedScreen', () => {
  beforeEach(() => {
    routeState.params = {
      source: 'profile-creations',
      initialId: 'gen-4',
    };
    queryClientState.useNetworkData = true;
    flatListRefState.scrollToIndex.mockClear();
    flatListRefState.scrollToOffset.mockClear();
    queryClientState.invalidateQueries.mockClear();
  });

  it('opens a selected creation at its real index without rotating the feed order', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaFeedScreen />);
    });

    const list = tree!.root.findAll((node) => String(node.type) === 'flat-list')[0];

    expect(list.props.data.map((item: { id: string }) => item.id)).toEqual([
      'gen-1',
      'gen-2',
      'gen-3',
      'gen-4',
    ]);
    expect(list.props.initialScrollIndex).toBeUndefined();
    expect(flatListRefState.scrollToIndex).toHaveBeenCalledWith({ index: 3, animated: false });
  });

  it('uses cached profile creations while the media-feed query refreshes', () => {
    queryClientState.useNetworkData = false;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaFeedScreen />);
    });

    expect(tree!.root.findAllByProps({ children: 'No items found in this section.' })).toHaveLength(0);

    const list = tree!.root.findAll((node) => String(node.type) === 'flat-list')[0];
    expect(list.props.data.map((item: { id: string }) => item.id)).toEqual([
      'gen-1',
      'gen-2',
      'gen-3',
      'gen-4',
    ]);
    expect(flatListRefState.scrollToIndex).toHaveBeenCalledWith({ index: 3, animated: false });
  });
});
