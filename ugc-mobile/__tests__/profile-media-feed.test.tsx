// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const routerState = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
}));

const paramsState = vi.hoisted(() => ({
  source: 'profile-creations' as string | string[] | undefined,
  initialId: 'gen-2' as string | string[] | undefined,
}));

type MockVideoPlayer = {
    addListener: ReturnType<typeof vi.fn>;
    loop: boolean;
    muted: boolean;
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    playing: boolean;
    showNowPlayingNotification: boolean;
    staysActiveInBackground: boolean;
    volume: number;
};

const videoState = vi.hoisted(() => {
  const players: MockVideoPlayer[] = [];

  return {
    players,
    useVideoPlayer: vi.fn((_source: unknown, setup?: (player: MockVideoPlayer) => void) => {
      return React.useMemo(() => {
        const player: MockVideoPlayer = {
          addListener: vi.fn(() => ({ remove: vi.fn() })),
          loop: false,
          muted: false,
          pause: vi.fn(),
          play: vi.fn(),
          playing: false,
          showNowPlayingNotification: true,
          staysActiveInBackground: true,
          volume: 0,
        };
        setup?.(player);
        players.push(player);
        return player;
      }, []);
    }),
  };
});

const accessibilityState = vi.hoisted(() => ({
  enabled: false,
  listeners: [] as Array<(enabled: boolean) => void>,
}));

const sourceQueryState = vi.hoisted(() => ({
  isError: false,
  refetch: vi.fn(),
}));

const alertState = vi.hoisted(() => ({
  alert: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: routerState,
  useLocalSearchParams: () => paramsState,
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(accessibilityState.enabled),
    addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
      accessibilityState.listeners.push(listener);
      return {
        remove: () => {
          accessibilityState.listeners = accessibilityState.listeners.filter((item) => item !== listener);
        },
      };
    },
  },
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
  FlatList: (props: MockProps & {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
    ListEmptyComponent?: React.ReactNode;
  }) => React.createElement(
    'flat-list',
    props,
    props.data?.length
      ? props.data.map((item, index) => props.renderItem?.({ item, index }))
      : props.ListEmptyComponent
  ),
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Modal: ({ children, visible, ...props }: MockProps & { visible?: boolean }) =>
    visible ? React.createElement('modal', props, children) : null,
  Alert: {
    alert: alertState.alert,
  },
  Linking: {
    openURL: vi.fn(),
  },
  Share: {
    share: vi.fn(),
  },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  Platform: {
    OS: 'ios',
    select: (obj: Record<string, unknown>) => obj.ios || obj.default,
  },
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) => React.createElement('blur-view', props, children),
}));

vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
  useVideoPlayer: videoState.useVideoPlayer,
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));

vi.mock('lucide-react-native', () => ({
  ArrowLeft: (props: Record<string, unknown>) => React.createElement('arrow-left-icon', props),
  Download: (props: Record<string, unknown>) => React.createElement('download-icon', props),
  FileText: (props: Record<string, unknown>) => React.createElement('file-text-icon', props),
  Globe: (props: Record<string, unknown>) => React.createElement('globe-icon', props),
  Heart: (props: Record<string, unknown>) => React.createElement('heart-icon', props),
  ImageOff: (props: Record<string, unknown>) => React.createElement('image-off-icon', props),
  Images: (props: Record<string, unknown>) => React.createElement('images-icon', props),
  LockKeyhole: (props: Record<string, unknown>) => React.createElement('lock-icon', props),
  MessageCircle: (props: Record<string, unknown>) => React.createElement('message-circle-icon', props),
  MoreVertical: (props: Record<string, unknown>) => React.createElement('more-vertical-icon', props),
  Play: (props: Record<string, unknown>) => React.createElement('play-icon', props),
  Repeat2: (props: Record<string, unknown>) => React.createElement('repeat-icon', props),
  Send: (props: Record<string, unknown>) => React.createElement('send-icon', props),
  Share2: (props: Record<string, unknown>) => React.createElement('share-icon', props),
  Wand2: (props: Record<string, unknown>) => React.createElement('wand-icon', props),
}));

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'user@example.com' },
  api: {
    getProfile: vi.fn(),
    listGenerations: vi.fn(),
    listOwnerPosts: vi.fn(),
    saveShowcasePost: vi.fn(),
    shareShowcasePost: vi.fn(),
    remixShowcasePost: vi.fn(),
    updatePost: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey, queryFn }: { queryKey: string[]; queryFn?: () => unknown }) => {
    if (queryKey[0] === 'profile') {
      return {
        data: { id: 'user-123', username: 'luna_dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' },
        isLoading: false,
      };
    }
    if (queryKey[0] === 'immersive-preview-source') {
      if (sourceQueryState.isError) {
        return {
          data: undefined,
          error: new Error('Network unavailable'),
          isError: true,
          isFetching: false,
          isLoading: false,
          refetch: sourceQueryState.refetch,
        };
      }

      const data = paramsState.source === 'profile-posts'
        ? {
            ownerPosts: [
              {
                id: 'post-1',
                title: 'Published office set',
                createdAt: '2026-06-10T00:00:00Z',
                visibility: 'public',
                mediaUrl: 'post.png',
                mediaKind: 'image',
                body: 'A published post caption',
                category: 'image',
                publicPath: '/showcase/post-1',
              },
            ],
          }
        : {
            generations: [
              {
                id: 'gen-1',
                status: 'succeeded',
                output_url: 'first.png',
                category: 'image',
                title: 'First creation',
                prompt: 'first prompt',
              },
              {
                id: 'gen-2',
                status: 'succeeded',
                output_url: 'video.mp4',
                preview_url: 'video-poster.webp',
                previewUrl: 'video-poster.webp',
                category: 'video',
                title: 'Video creation',
                prompt: 'video prompt',
              },
              {
                id: 'gen-3',
                status: 'succeeded',
                output_url: 'linked.png',
                category: 'image',
                title: 'Published creation',
                prompt: 'linked prompt',
                linked_post_id: 'post-1',
                linked_post_title: 'Published office set',
                linked_post_visibility: 'public',
              },
            ],
            ownerPosts: [
              {
                id: 'post-1',
                title: 'Published office set',
                createdAt: '2026-06-10T00:00:00Z',
                visibility: 'public',
                mediaUrl: 'post.png',
                mediaKind: 'image',
                body: 'A published post caption',
                category: 'image',
                postFormat: 'media',
                publicPath: '/showcase/post-1',
                generationId: 'gen-3',
                bundle: {
                  id: 'bundle-1',
                  accessMode: 'paid',
                  status: 'published',
                  priceUsdCents: 900,
                  salesCount: 1,
                  earningsUsdCents: 900,
                  resourceKinds: ['prompt'],
                },
              },
            ],
          };
      return {
        data,
        isError: false,
        isFetching: false,
        isLoading: false,
        refetch: sourceQueryState.refetch,
      };
    }
    return {
      data: queryFn ? queryFn() : null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  },
  useMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: null,
  }),
  useQueryClient: () => ({
    getQueryData: vi.fn(),
    getQueriesData: vi.fn(() => []),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/components/feed-media-frame', () => ({
  FeedMediaFrame: (props: MockProps) => React.createElement('feed-media-frame', props),
}));

vi.mock('@/components/fantasy-portal-art', () => ({
  FantasyPortalArt: (props: MockProps) => React.createElement('fantasy-portal-art', props),
}));

vi.mock('@/components/post-resource-references', () => ({
  PostResourceReferences: (props: MockProps) => React.createElement('post-resource-references', props),
}));

import ProfileMediaFeedScreen from '../app/profile-media-feed';

function renderScreen() {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<ProfileMediaFeedScreen />);
  });
  return tree!;
}

function findPressableByText(root: renderer.ReactTestInstance, text: string) {
  const textInstances = root.findAllByProps({ children: text });
  for (const textInstance of textInstances) {
    let current: renderer.ReactTestInstance | null = textInstance;
    while (current && String(current.type) !== 'pressable') {
      current = current.parent;
    }
    if (current) return current;
  }
  throw new Error(`No pressable containing text "${text}" was found`);
}

describe('ProfileMediaFeedScreen', () => {
  beforeEach(() => {
    routerState.back.mockClear();
    routerState.push.mockClear();
    alertState.alert.mockClear();
    authState.api.updatePost.mockClear();
    videoState.useVideoPlayer.mockClear();
    videoState.players.splice(0);
    accessibilityState.enabled = false;
    sourceQueryState.isError = false;
    sourceQueryState.refetch.mockClear();
    paramsState.source = 'profile-creations';
    paramsState.initialId = 'gen-2';
  });

  it('opens profile creations at the tapped item and exposes creation actions in the options menu', () => {
    const tree = renderScreen();

    const list = tree.root.findByProps({ testID: 'profile-media-feed-list' });
    expect(list.props.initialScrollIndex).toBe(1);
    expect(list.props.initialNumToRender).toBe(1);
    expect(list.props.maxToRenderPerBatch).toBe(2);
    expect(list.props.windowSize).toBe(3);
    expect(tree.root.findByProps({ children: 'Creations' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Video creation' })).toBeTruthy();

    const options = tree.root.findByProps({ accessibilityLabel: 'Open media options' });
    renderer.act(() => {
      options.props.onPress();
    });

    expect(tree.root.findByProps({ children: 'Post this creation' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Recreate / Remix' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'View details' })).toBeTruthy();
  });

  it('opens profile posts with post actions in the options menu', () => {
    paramsState.source = 'profile-posts';
    paramsState.initialId = 'post-1';

    const tree = renderScreen();

    expect(tree.root.findByProps({ children: 'Posts' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Published office set' })).toBeTruthy();

    const options = tree.root.findByProps({ accessibilityLabel: 'Open media options' });
    renderer.act(() => {
      options.props.onPress();
    });

    expect(tree.root.findByProps({ children: 'Edit post' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Change visibility' })).toBeTruthy();
  });

  it('renders Publish as the visible creation action and keeps details in the options menu', () => {
    paramsState.source = 'profile-creations';
    paramsState.initialId = 'gen-2';

    const tree = renderScreen();

    expect(tree.root.findAllByProps({ children: 'Create' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ children: 'Share' }).length).toBeGreaterThan(0);
    expect(tree.root.findByProps({ accessibilityLabel: 'Publish Video creation' })).toBeTruthy();
    expect(tree.root.findAllByProps({ children: 'Details' })).toHaveLength(0);

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Publish Video creation' }).props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/post/new',
      params: { generationId: 'gen-2' },
    });

    const options = tree.root.findByProps({ accessibilityLabel: 'Open media options' });
    renderer.act(() => {
      options.props.onPress();
    });

    expect(tree.root.findByProps({ children: 'View details' })).toBeTruthy();
  });

  it('renders manage unlock and make private for published creations', () => {
    paramsState.source = 'profile-creations';
    paramsState.initialId = 'gen-3';

    const tree = renderScreen();

    expect(tree.root.findAllByProps({ children: 'Create' }).length).toBeGreaterThan(0);
    expect(tree.root.findByProps({ accessibilityLabel: 'Manage unlock for Published creation' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Make private for Published creation' })).toBeTruthy();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Publish Published creation' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ children: 'Details' })).toHaveLength(0);

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Manage unlock for Published creation' }).props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/post/new',
      params: { postId: 'post-1', focus: 'resources' },
    });

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Make private for Published creation' }).props.onPress();
    });

    expect(alertState.alert).toHaveBeenCalledWith(
      'Make private?',
      'This linked post will leave public surfaces until you make it public again.',
      expect.any(Array)
    );
  });

  it('plays active full-screen profile videos with sound and no persistent mute control', () => {
    const tree = renderScreen();

    const videoFrames = tree.root.findAll((node) =>
      String(node.type) === 'feed-media-frame'
      && node.props.kind === 'video'
      && node.props.backdropUrl === 'video-poster.webp'
    );
    expect(videoFrames).toHaveLength(1);
    expect(videoFrames[0].props.player).toBeTruthy();
    expect(videoState.useVideoPlayer).toHaveBeenCalledTimes(1);

    const player = videoState.players[0];
    expect(player.muted).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Unmute video' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Mute video' })).toHaveLength(0);
  });

  it('shows an honest retryable source error instead of the empty state', () => {
    sourceQueryState.isError = true;

    const tree = renderScreen();

    expect(tree.root.findByProps({ accessibilityRole: 'alert' })).toBeTruthy();
    expect(tree.root.findByProps({ children: "Couldn't load creations" })).toBeTruthy();
    expect(tree.root.findAllByProps({ children: 'No items found in this section.' })).toHaveLength(0);

    sourceQueryState.refetch.mockClear();
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Try again' }).props.onPress();
    });

    expect(sourceQueryState.refetch).toHaveBeenCalledTimes(1);
  });

  it('pauses active video when the reduced-motion preference turns on', async () => {
    renderScreen();

    await renderer.act(async () => {
      accessibilityState.listeners.forEach((listener) => listener(true));
      await Promise.resolve();
    });

    expect(videoState.players.some((player) => player.pause.mock.calls.length > 0)).toBe(true);
  });
});
