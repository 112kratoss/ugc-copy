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
  push: vi.fn(),
  replace: vi.fn(),
}));

const paramsState = vi.hoisted(() => ({
  params: {} as { generationId?: string; postId?: string },
}));

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'creator@example.com' },
  isLoading: false,
  api: {
    listGenerations: vi.fn(),
    getOwnerPost: vi.fn(),
    publishGeneration: vi.fn(),
    createPost: vi.fn(),
    updatePost: vi.fn(),
  },
}));

const mutationState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

const generationItem = {
  id: 'gen-1',
  output_url: 'https://cdn.example.com/output.png',
  status: 'succeeded',
  created_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:01:00.000Z',
  model: 'seedream',
  category: 'image',
  title: 'Hero product image',
  description: 'A polished output',
  prompt: 'Exact glossy product prompt',
  input_media: [{ url: 'https://cdn.example.com/reference.jpg', kind: 'image' }],
  linked_post_id: null,
};

vi.mock('expo-router', () => ({
  Redirect: (props: MockProps) => React.createElement('redirect', props),
  router: routerState,
  useLocalSearchParams: () => paramsState.params,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
  useMutation: () => mutationState,
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === 'post-new-generations') {
      return {
        data: { generations: [generationItem] },
        error: null,
        isLoading: false,
      };
    }
    if (queryKey[0] === 'post-edit') {
      return {
        data: null,
        error: null,
        isLoading: false,
      };
    }
    return { data: null, error: null, isLoading: false };
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Platform: {
    OS: 'ios',
    select: (obj: Record<string, unknown>) => obj.ios || obj.default,
  },
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('lucide-react-native', () => ({
  Check: (props: MockProps) => React.createElement('check-icon', props),
  FileText: (props: MockProps) => React.createElement('file-text-icon', props),
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  Lock: (props: MockProps) => React.createElement('lock-icon', props),
  PackageCheck: (props: MockProps) => React.createElement('package-check-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
}));

vi.mock('@/lib/media', () => ({
  pickMedia: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

import NewPostScreen from '../app/post/new';

function collectText(root: renderer.ReactTestInstance) {
  return root
    .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
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

describe('NewPostScreen Phase 4 creation publishing workspace', () => {
  beforeEach(() => {
    paramsState.params = { generationId: 'gen-1' };
    routerState.push.mockClear();
    routerState.replace.mockClear();
    mutationState.mutate.mockClear();
    mutationState.isPending = false;
  });

  it('shows the selected creation hero before public post fields when launched from a generation', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Selected creation')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Selected creation')).toBeLessThan(text.indexOf('Public post'));
    expect(text).toContain('Hero product image');
    expect(text).toContain('Change creation');
  });

  it('keeps post settings collapsed and resource package set to none by default', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Post settings');
    expect(text).not.toContain('Source');
    expect(text).not.toContain('Category');
    expect(text).toContain('Resource package');
    expect(text).toContain('None');
    expect(text).toContain('No resource package configured.');
  });

  it('updates the resource package when the exact prompt toggle is enabled', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Use exact prompt as resource').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Prompt resource ready');
    expect(text).toContain('Includes the exact reusable prompt.');
  });

  it('renders a compact publish dock with readiness and the publish CTA', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Publish dock');
    expect(text).toContain('Public post ready');
    expect(text).toContain('Publish public');
  });
});
