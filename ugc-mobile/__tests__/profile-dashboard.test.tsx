// Define React Native development global
(global as any).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Router mock
const routerState = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: routerState,
}));

// react-native mock
type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  Text: ({ children, ...props }: MockProps) =>
    React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) =>
    React.createElement('view', props, children),
  ScrollView: ({ children, ...props }: MockProps) =>
    React.createElement('scrollview', props, children),
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  PanResponder: {
    create: () => ({ panHandlers: {} }),
  },
  TurboModuleRegistry: {
    get: () => null,
    getEnforcing: () => null,
  },
  Platform: {
    OS: 'ios',
    select: (obj: any) => obj.ios || obj.default,
  },
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  ChevronRight: (props: Record<string, unknown>) => React.createElement('chevron-right-icon', props),
  Crown: (props: Record<string, unknown>) => React.createElement('crown-icon', props),
  Heart: (props: Record<string, unknown>) => React.createElement('heart-icon', props),
  ImageIcon: (props: Record<string, unknown>) => React.createElement('image-icon', props),
  Pencil: (props: Record<string, unknown>) => React.createElement('pencil-icon', props),
  Play: (props: Record<string, unknown>) => React.createElement('play-icon', props),
  RefreshCw: (props: Record<string, unknown>) => React.createElement('refresh-cw-icon', props),
  Sparkles: (props: Record<string, unknown>) => React.createElement('sparkles-icon', props),
  Store: (props: Record<string, unknown>) => React.createElement('store-icon', props),
  UserRound: (props: Record<string, unknown>) => React.createElement('user-round-icon', props),
  Wallet: (props: Record<string, unknown>) => React.createElement('wallet-icon', props),
}));

vi.mock('@/components/feed-video-preview', () => ({
  FeedVideoPreview: (props: MockProps) => React.createElement('feed-video-preview', props),
}));

vi.mock('@/components/fantasy-portal-art', () => ({
  FantasyPortalArt: (props: MockProps) => React.createElement('fantasy-portal-art', props),
}));

// Auth mock
const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'user@example.com' },
  credits: 100,
  api: {
    getProfile: vi.fn(),
    listGenerations: vi.fn(),
    listOwnerPosts: vi.fn(),
    getSavedMedia: vi.fn(),
    getShowcaseFeed: vi.fn(),
  },
}));

const queryState = vi.hoisted(() => ({
  profileData: { id: 'user-123', username: 'luna_dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' } as null | {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
  },
  profileError: null as Error | null,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

// react-query mock
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === 'profile') {
      return {
        data: queryState.profileData,
        error: queryState.profileError,
        isLoading: false,
      };
    }
    if (queryKey[0] === 'profile-generations') {
      return {
        data: {
          generations: [
            { id: 'gen-1', status: 'succeeded', output_url: 'gen.png', category: 'image', title: 'Cre', prompt: 'Prompt' },
          ],
        },
        isLoading: false,
      };
    }
    if (queryKey[0] === 'profile-owner-posts') {
      return {
        data: {
          posts: [
            {
              id: 'post-1',
              title: 'Post Title',
              createdAt: '2026-06-10T00:00:00Z',
              visibility: 'public',
              mediaUrl: 'post.png',
              mediaKind: 'image',
              body: 'Post body',
              category: 'image',
            },
          ],
        },
        isLoading: false,
      };
    }
    if (queryKey[0] === 'profile-saved-media') {
      return {
        data: {
          items: [
            {
              id: 'saved-1',
              mediaUrl: 'saved.png',
              mediaKind: 'image',
              title: 'Saved Title',
              creator: { name: 'Luna', username: 'luna' },
              isSaved: true,
              saveCount: 5,
            },
          ],
        },
        isLoading: false,
      };
    }
    return { data: null, isLoading: false };
  },
}));

import { ProfileDashboard } from '../components/profile-dashboard';

function findPressableByText(root: renderer.ReactTestInstance, text: string) {
  const textInstances = root.findAllByProps({ children: text });
  for (const textInstance of textInstances) {
    let current: any = textInstance;
    while (current && current.type !== 'pressable') {
      current = current.parent;
    }
    if (current) return current;
  }
  throw new Error(`No pressable containing text "${text}" was found`);
}

describe('ProfileDashboard media tiles routing', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    queryState.profileData = { id: 'user-123', username: 'luna_dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' };
    queryState.profileError = null;
  });

  it('routes to /viewer with correct source and initialId for Saved tiles', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // Saved tab is selected by default. Find the tile.
    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Saved, Saved Title, 5 likes',
    });

    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/viewer',
      params: {
        source: 'profile-saved',
        initialId: 'saved-1',
      },
    });
  });

  it('routes to /media-feed with correct source and initialId for Creations tiles', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // Select Creations tab
    const creationsTab = findPressableByText(tree!.root, 'Creations');
    renderer.act(() => {
      creationsTab.props.onPress();
    });

    // Find the Creations tile.
    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Creation, Cre',
    });

    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/media-feed',
      params: {
        source: 'profile-creations',
        initialId: 'gen-1',
      },
    });
  });

  it('routes to /media-feed with correct source and initialId for Posts tiles', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // Select Posts tab
    const postsTab = findPressableByText(tree!.root, 'Posts');
    renderer.act(() => {
      postsTab.props.onPress();
    });

    // Find the Posts tile.
    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Post, Post Title',
    });

    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/media-feed',
      params: {
        source: 'profile-posts',
        initialId: 'post-1',
      },
    });
  });

  it('does not show the profile error banner when cached profile data is available', () => {
    queryState.profileError = new Error('Unauthorized');

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(tree!.root.findAllByProps({ children: 'Could not load profile' })).toHaveLength(0);
    expect(tree!.root.findByProps({ children: 'Luna Dreams' })).toBeTruthy();
  });

  it('shows the profile error banner when no profile data is available', () => {
    queryState.profileData = null;
    queryState.profileError = new Error('Unauthorized');

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(tree!.root.findByProps({ children: 'Could not load profile' })).toBeTruthy();
  });
});
