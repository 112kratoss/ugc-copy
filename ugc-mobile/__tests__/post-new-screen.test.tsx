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
  params: {} as { generationId?: string; postId?: string; focus?: string },
}));

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'creator@example.com' },
  isLoading: false,
  api: {
    listGenerations: vi.fn(),
    listSourceTools: vi.fn(),
    getOwnerPost: vi.fn(),
    publishGeneration: vi.fn(),
    createPost: vi.fn(),
    updatePost: vi.fn(),
    uploadPostResourceFile: vi.fn(),
  },
}));

const sourceToolsState = vi.hoisted(() => ({
  tools: [{
    slug: 'runway',
    label: 'Runway',
    models: [{ slug: 'gen-4', label: 'Gen-4' }],
    supportedMediaKinds: ['image', 'video'],
  }],
}));

const mutationState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  options: null as null | {
    onMutate?: (visibility?: 'public' | 'unlisted' | 'private') => { submittedDraft?: unknown } | void;
    onSuccess?: (
      response: { postId?: string | null },
      visibility?: 'public' | 'unlisted' | 'private',
      context?: { submittedDraft?: unknown } | void
    ) => void;
  },
}));

const queryClientState = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
}));

const generationItem = {
  id: 'gen-1',
  output_url: 'https://cdn.example.com/output.png',
  preview_url: 'https://cdn.example.com/output.preview.webp',
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
  useQueryClient: () => queryClientState,
  useMutation: (options: typeof mutationState.options) => {
    mutationState.options = options;
    return mutationState;
  },
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
    if (queryKey[0] === 'post-source-tools') {
      return {
        data: {
          tools: sourceToolsState.tools,
        },
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
  PanResponder: {
    create: (handlers: Record<string, unknown>) => ({
      panHandlers: handlers,
    }),
  },
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

vi.mock('@/components/media-preview', () => ({
  StableMediaImage: (props: MockProps) => React.createElement('stable-media-image', props),
}));

vi.mock('lucide-react-native', () => ({
  Check: (props: MockProps) => React.createElement('check-icon', props),
  ChevronDown: (props: MockProps) => React.createElement('chevron-down-icon', props),
  FileText: (props: MockProps) => React.createElement('file-text-icon', props),
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  Lock: (props: MockProps) => React.createElement('lock-icon', props),
  PackageCheck: (props: MockProps) => React.createElement('package-check-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  Plus: (props: MockProps) => React.createElement('plus-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
}));

vi.mock('@/lib/media', () => ({
  pickMedia: vi.fn(),
  pickMediaList: vi.fn(),
  pickResourceDocument: vi.fn(),
  uploadPickedMedia: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

import NewPostScreen from '../app/post/new';
import { pickMediaList, uploadPickedMedia } from '@/lib/media';

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

function findPressableByAccessibilityLabel(root: renderer.ReactTestInstance, accessibilityLabel: string) {
  const pressable = root.findAll(
    (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === accessibilityLabel
  )[0];
  if (!pressable) {
    throw new Error(`No pressable with accessibility label "${accessibilityLabel}" was found`);
  }
  return pressable;
}

function findNodeByAccessibilityLabel(root: renderer.ReactTestInstance, accessibilityLabel: string) {
  const node = root.findAll(
    (candidate) => candidate.props.accessibilityLabel === accessibilityLabel
  )[0];
  if (!node) {
    throw new Error(`No node with accessibility label "${accessibilityLabel}" was found`);
  }
  return node;
}

function findTextInputByPlaceholder(root: renderer.ReactTestInstance, placeholder: string) {
  const input = root.findAll(
    (node) => String(node.type) === 'textinput' && node.props.placeholder === placeholder
  )[0];
  if (!input) {
    throw new Error(`No text input with placeholder "${placeholder}" was found`);
  }
  return input;
}

describe('NewPostScreen Phase 4 creation publishing workspace', () => {
  beforeEach(() => {
    paramsState.params = { generationId: 'gen-1' };
    routerState.push.mockClear();
    routerState.replace.mockClear();
    queryClientState.invalidateQueries.mockClear();
    queryClientState.setQueryData.mockClear();
    mutationState.mutate.mockClear();
    mutationState.options = null;
    mutationState.isPending = false;
    vi.mocked(pickMediaList).mockReset();
    vi.mocked(uploadPickedMedia).mockReset();
    sourceToolsState.tools = [{
      slug: 'runway',
      label: 'Runway',
      models: [{ slug: 'gen-4', label: 'Gen-4' }],
      supportedMediaKinds: ['image', 'video'],
    }];
    authState.api.listSourceTools.mockResolvedValue({
      tools: sourceToolsState.tools,
    });
  });

  it('renders the web composer hierarchy when launched from a generation', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).not.toContain('Composer');
    expect(text).not.toContain('Create post');
    expect(text.indexOf('Title')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Made With')).toBeGreaterThan(text.indexOf('Title'));
    expect(text.indexOf('Proof')).toBeGreaterThan(text.indexOf('Made With'));
    expect(text.indexOf('Story')).toBeGreaterThan(text.indexOf('Proof'));
    expect(text.indexOf('Unlock')).toBeGreaterThan(text.indexOf('Story'));
    expect(text.indexOf('Publish')).toBeGreaterThan(text.indexOf('Unlock'));
    expect(text).not.toContain('Publish checklist');
    expect(text).not.toContain('Checklist');
    expect(text).not.toContain('Preview');
    expect(text).not.toContain('Selected creation');
    expect(text).not.toContain('Creation selected');
    expect(text).not.toContain('References and resources optional.');
    expect(text).toContain('Hero product image');
    expect(text.indexOf('Hero product image')).toBeGreaterThan(text.indexOf('Proof'));
    expect(text.indexOf('Hero product image')).toBeLessThan(text.indexOf('Story'));
    expect(text).toContain('Generated media');
    expect(text).toContain('Attached automatically');
    expect(text).toContain('Change');
  });

  it('ends the composer at publish without checklist or preview sections', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Publish');
    expect(text).not.toContain('Publish checklist');
    expect(text).not.toContain('Checklist');
    expect(text).not.toContain('Preview');
    expect(text).not.toContain('Post preview');
  });

  it('shows Made With, Proof, compact Story details, Unlock, and web-style publish actions', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Magicbooklet');
    expect(text).toContain('seedream');
    expect(text).not.toContain('Tool 1');
    expect(text).not.toContain('Model');
    expect(text).toContain('Generated media attached');
    expect(tree!.root.findAll(
      (node) => String(node.type) === 'textinput' && node.props.placeholder === 'Choose or search tool'
    )).toHaveLength(0);
    expect(tree!.root.findAll(
      (node) => String(node.type) === 'textinput' && node.props.placeholder === 'Any model'
    )).toHaveLength(0);
    expect(text).toContain('Caption');
    expect(text).toContain('Add feed description');
    expect(text).not.toContain('Feed description');
    expect(text).toContain('Add references & unlockable resources');
    expect(text).not.toContain('Resource types');
    renderer.act(() => {
      findPressableByText(tree!.root, 'Add references & unlockable resources').props.onPress();
    });
    const unlockText = collectText(tree!.root);
    expect(unlockText).toContain('Resource types');
    expect(unlockText).toContain('Saved privately in Studio');
    expect(unlockText).toContain('Prompt');
    expect(unlockText).toContain('Workflow / setup');
    expect(unlockText).toContain('Files / links');
    expect(unlockText).toContain('Notes');
    expect(unlockText).toContain('Remix access');
    expect(unlockText).toContain('Save private');
    expect(unlockText).toContain('Publish public');
    expect(unlockText).not.toContain('Publish dock');
    expect(unlockText).not.toContain('Post settings');
    expect(unlockText).not.toContain('Public post');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Add feed description').props.onPress();
    });

    const expandedText = collectText(tree!.root);
    expect(expandedText).toContain('Feed description');
  });

  it('collapses unlock controls behind a web-style checklist row', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const collapsedText = collectText(tree!.root);
    expect(collapsedText).not.toContain('Unlock off');
    expect(collapsedText).toContain('Add references & unlockable resources');
    expect(collapsedText).not.toContain('Resource types');
    expect(collapsedText).not.toContain('Free unlock');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Add references & unlockable resources').props.onPress();
    });

    const expandedText = collectText(tree!.root);
    expect(expandedText).toContain('Resource types');
    expect(expandedText).toContain('Saved privately in Studio');
    expect(expandedText).not.toContain('None');
    expect(expandedText).toContain('Prompt');
    expect(expandedText).toContain('Workflow / setup');
    expect(expandedText).toContain('Files / links');
    expect(expandedText).toContain('Notes');
    expect(expandedText).toContain('Remix access');
  });

  it('removes resource sections from the inline section layout', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Add references & unlockable resources').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Enable section layout').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Add section').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Add section').props.onPress();
    });

    expect(collectText(tree!.root)).toContain('Section 2');

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree!.root, 'Remove Section 2').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Section 1');
    expect(text).not.toContain('Section 2');
  });

  it('keeps the composer chrome compact instead of explaining every section', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).not.toContain('Share your work and add optional unlockable resources.');
    expect(text).not.toContain('Add the tool and model you used.');
    expect(text).not.toContain('Resolve anything marked before publishing.');
    expect(text).not.toContain('Check the public card and the unlock cue before publishing.');
  });

  it('renders Story, Unlock, and Publish with the minimal web hierarchy', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Add references & unlockable resources').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text.filter((value) => value === 'Story')).toHaveLength(1);
    expect(text).toContain('The public content visible in the community feed.');
    expect(text).toContain('Add optional gated resources to this post.');
    expect(text).toContain('Choose who can see this post.');
    expect(text).toContain('Saved privately in Studio');
    expect(text).not.toContain('Visibility');
    expect(text).not.toContain('No unlock');
  });

  it('keeps the web composer order when opened with focus=resources', () => {
    paramsState.params = { generationId: 'gen-1', focus: 'resources' };
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Title')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Made With')).toBeGreaterThan(text.indexOf('Title'));
    expect(text.indexOf('Proof')).toBeGreaterThan(text.indexOf('Made With'));
    expect(text.indexOf('Story')).toBeGreaterThan(text.indexOf('Proof'));
    expect(text.indexOf('Unlock')).toBeGreaterThan(text.indexOf('Story'));
    expect(text.indexOf('Publish')).toBeGreaterThan(text.indexOf('Unlock'));
    expect(text).toContain('Add references & unlockable resources');
  });

  it('renders gallery controls for manual upload proof', () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Media').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Upload images or videos');
    expect(text.filter((value) => value === 'Add media')).toHaveLength(1);
    expect(text).not.toContain('Video');
    expect(text).toContain('Cover first · max 5');
  });

  it('routes newly created manual posts to the profile Posts tab', () => {
    paramsState.params = {};

    renderer.act(() => {
      renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      mutationState.options?.onSuccess?.({ postId: 'post-123' });
    });

    expect(routerState.replace).toHaveBeenCalledWith({
      pathname: '/(tabs)/profile',
      params: {
        tab: 'posts',
        postId: 'post-123',
      },
    });
  });

  it('primes the profile Posts cache with uploaded media after publish', async () => {
    paramsState.params = {};
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///28.png', fileName: '28.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
    ]);
    vi.mocked(uploadPickedMedia).mockImplementation(async (uri, options) => ({
      signedUrl: uri,
      storagePath: `uploads/${options?.fileName ?? 'media.png'}`,
      mimeType: options?.mimeType ?? 'image/png',
      fileName: options?.fileName ?? 'media.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: options?.sizeBytes ?? null,
    }));

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Media').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add media').props.onPress();
    });

    let mutationContext: { submittedDraft?: unknown } | void;
    renderer.act(() => {
      mutationContext = mutationState.options?.onMutate?.('public');
    });
    renderer.act(() => {
      mutationState.options?.onSuccess?.({ postId: 'post-123' }, 'public', mutationContext);
    });

    expect(queryClientState.setQueryData).toHaveBeenCalledWith(
      ['profile-owner-posts', 'user-123'],
      expect.any(Function)
    );
    const updateProfilePosts = queryClientState.setQueryData.mock.calls[0]?.[1] as
      | ((current: { success: boolean; posts: unknown[] }) => { posts: Array<{ mediaUrl: string | null; mediaItems?: Array<{ url: string }> }> })
      | undefined;
    expect(updateProfilePosts?.({ success: true, posts: [] }).posts[0]).toMatchObject({
      id: 'post-123',
      mediaUrl: 'file:///28.png',
      mediaItems: [{ url: 'file:///28.png' }],
    });
  });

  it('shows the publish loading animation only on the clicked action', () => {
    mutationState.mutate.mockImplementation(() => {
      mutationState.isPending = true;
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Publish public').props.onPress();
    });
    renderer.act(() => {
      tree!.update(<NewPostScreen />);
    });

    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(1);
    expect(collectText(tree!.root)).toContain('Save private');
  });

  it('uses the center upload target to attach mixed media', async () => {
    paramsState.params = {};
    vi.mocked(pickMediaList).mockResolvedValue([]);

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Media').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add media').props.onPress();
    });

    expect(pickMediaList).toHaveBeenCalledWith('mixed', { allowsMultipleSelection: true });
  });

  it('removes a selected media item from the gallery strip', async () => {
    paramsState.params = {};
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///28.png', fileName: '28.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
      { uri: 'file:///27.png', fileName: '27.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
    ]);
    vi.mocked(uploadPickedMedia).mockImplementation(async (uri, options) => ({
      signedUrl: uri,
      storagePath: `uploads/${options?.fileName ?? 'media.png'}`,
      mimeType: options?.mimeType ?? 'image/png',
      fileName: options?.fileName ?? 'media.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: options?.sizeBytes ?? null,
    }));

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Media').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add media').props.onPress();
    });
    renderer.act(() => {
      findPressableByAccessibilityLabel(tree!.root, 'Remove Media 2').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('28.png');
    expect(text).not.toContain('27.png');
    expect(text).not.toContain('Media 2');
  });

  it('shows a trailing add media card until the gallery reaches five items', async () => {
    paramsState.params = {};
    vi.mocked(pickMediaList)
      .mockResolvedValueOnce([
        { uri: 'file:///28.png', fileName: '28.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
        { uri: 'file:///27.png', fileName: '27.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
      ])
      .mockResolvedValueOnce([
        { uri: 'file:///26.png', fileName: '26.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
      ]);
    vi.mocked(uploadPickedMedia).mockImplementation(async (uri, options) => ({
      signedUrl: uri,
      storagePath: `uploads/${options?.fileName ?? 'media.png'}`,
      mimeType: options?.mimeType ?? 'image/png',
      fileName: options?.fileName ?? 'media.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: options?.sizeBytes ?? null,
    }));

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Media').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add media').props.onPress();
    });

    expect(collectText(tree!.root)).toContain('3 slots left');

    await renderer.act(async () => {
      await findPressableByAccessibilityLabel(tree!.root, 'Add more media').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(pickMediaList).toHaveBeenCalledTimes(2);
    expect(pickMediaList).toHaveBeenLastCalledWith('mixed', { allowsMultipleSelection: true });
    expect(text).toContain('Media 3');
    expect(text).toContain('26.png');
    expect(text).toContain('2 slots left');
  });

  it('reorders gallery media by pressing and holding the card', async () => {
    vi.useFakeTimers();
    paramsState.params = {};
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///28.png', fileName: '28.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
      { uri: 'file:///27.png', fileName: '27.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
    ]);
    vi.mocked(uploadPickedMedia).mockImplementation(async (uri, options) => ({
      signedUrl: uri,
      storagePath: `uploads/${options?.fileName ?? 'media.png'}`,
      mimeType: options?.mimeType ?? 'image/png',
      fileName: options?.fileName ?? 'media.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: options?.sizeBytes ?? null,
    }));

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Media').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add media').props.onPress();
    });

    expect(tree!.root.findAll((node) => String(node.type) === 'grip-horizontal-icon')).toHaveLength(0);
    expect(tree!.root.findAll(
      (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Drag Media 2 to reorder'
    )).toHaveLength(0);

    renderer.act(() => {
      const mediaCard = findNodeByAccessibilityLabel(tree!.root, 'Hold Media 2 to reorder');
      expect(mediaCard.props.onStartShouldSetPanResponder()).toBe(true);
      mediaCard.props.onPanResponderGrant();
      vi.advanceTimersByTime(260);
      mediaCard.props.onPanResponderMove(null, { dx: -150, dy: 0 });
      mediaCard.props.onPanResponderRelease(null, { dx: -150, dy: 0 });
    });
    vi.useRealTimers();

    const text = collectText(tree!.root);
    expect(text.indexOf('Cover')).toBeLessThan(text.indexOf('27.png'));
    expect(text.indexOf('27.png')).toBeLessThan(text.indexOf('Media 2'));
    expect(text.indexOf('Media 2')).toBeLessThan(text.indexOf('28.png'));
  });

  it('hides Made With and avoids a duplicate body field for text proof posts', () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Text').props.onPress();
    });

    const text = collectText(tree!.root);
    const bodyInputs = tree!.root.findAll(
      (node) => String(node.type) === 'textinput' && node.props.placeholder === 'Write the post content...'
    );
    expect(text).not.toContain('Made With');
    expect(text.indexOf('Proof')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Story')).toBeGreaterThan(text.indexOf('Proof'));
    expect(bodyInputs).toHaveLength(1);
  });

  it('expands source tool controls without the old post settings disclosure', () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Made With');
    expect(text).toContain('Tool 1');
    expect(text).toContain('Model');
    expect(text).toContain('Add another tool');
    expect(text).not.toContain('Category');
  });

  it('uses web-style searchable Made With pickers instead of an always-visible chip strip', () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const collapsedText = collectText(tree!.root);
    expect(collapsedText).not.toContain('Manual');
    expect(collapsedText).not.toContain('Magicbooklet');
    expect(collapsedText).not.toContain('Runway');

    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Choose or search tool').props.onFocus();
    });

    const openedText = collectText(tree!.root);
    expect(openedText).toContain('Manual');
    expect(openedText).toContain('Magicbooklet');
    expect(openedText).toContain('Runway');
  });

  it('creates custom tools and models from the mobile Made With picker', () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Choose or search tool').props.onChangeText('Pika Labs');
    });

    expect(collectText(tree!.root)).toContain('Create "Pika Labs"');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Create "Pika Labs"').props.onPress();
    });

    expect(findTextInputByPlaceholder(tree!.root, 'Choose or search tool').props.value).toBe('Pika Labs');
    expect(findTextInputByPlaceholder(tree!.root, 'Any model').props.editable).toBe(true);

    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Any model').props.onChangeText('Pika 2.2');
    });

    expect(collectText(tree!.root)).toContain('Create "Pika 2.2"');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Create "Pika 2.2"').props.onPress();
    });

    expect(findTextInputByPlaceholder(tree!.root, 'Any model').props.value).toBe('Pika 2.2');
  });

  it('shows catalog models after selecting a catalog Made With tool', () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Choose or search tool').props.onFocus();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Runway').props.onPress();
    });
    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Any model').props.onFocus();
    });

    const modelText = collectText(tree!.root);
    expect(modelText).toContain('Any model');
    expect(modelText).toContain('Gen-4');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Gen-4').props.onPress();
    });

    expect(findTextInputByPlaceholder(tree!.root, 'Any model').props.value).toBe('Gen-4');
  });

  it('uses fallback source tool models when the API catalog is empty', () => {
    paramsState.params = {};
    sourceToolsState.tools = [];
    authState.api.listSourceTools.mockResolvedValue({ tools: [] });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Choose or search tool').props.onFocus();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Runway').props.onPress();
    });
    renderer.act(() => {
      findTextInputByPlaceholder(tree!.root, 'Any model').props.onFocus();
    });

    const modelText = collectText(tree!.root);
    expect(modelText).toContain('Gen-3');
    expect(modelText).toContain('Gen-4');
  });

  it('updates the resource package when the exact prompt toggle is enabled', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Add references & unlockable resources').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Use exact prompt as resource').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Prompt resource ready');
    expect(text).toContain('Includes the exact reusable prompt.');
  });

  it('uses visible publish actions instead of an overlapping dock', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<NewPostScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Save private');
    expect(text).toContain('Publish public');
    expect(text).toContain('Saved privately in Studio.');
    expect(text).toContain('Visible in Feed.');
    expect(text).not.toContain('Visible in Feed');
    expect(text).not.toContain('Public');
    expect(text).not.toContain('Unlisted');
    expect(text).not.toContain('Private');
    expect(text).not.toContain('Ready to publish');
    expect(text).not.toContain('Publish blocked');
    expect(text).not.toContain('Public post ready');
    expect(text).not.toContain('Publish dock');
  });
});
