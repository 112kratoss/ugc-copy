// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceToolOption } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown; visible?: boolean } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) }));
const navigationState = vi.hoisted(() => ({ dispatch: vi.fn(), setOptions: vi.fn() }));
const alertState = vi.hoisted(() => ({ alert: vi.fn() }));
const storageState = vi.hoisted(() => ({ values: new Map<string, string>() }));
const paramsState = vi.hoisted(() => ({ params: {} as { generationId?: string; postId?: string; focus?: string; shareAfterPublish?: string } }));
const shareState = vi.hoisted(() => ({
  share: vi.fn(async () => ({ action: 'sharedAction' })),
  sharedAction: 'sharedAction',
  dismissedAction: 'dismissedAction',
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
    signPostResourceFileUpload: vi.fn(),
    finalizePostResourceFileUpload: vi.fn(),
    shareShowcasePost: vi.fn(async () => ({ success: true })),
  },
}));
const sourceToolsState = vi.hoisted(() => ({
  tools: [{
    slug: 'runway',
    label: 'Runway',
    models: [{ slug: 'gen-4', label: 'Gen-4' }],
    supportedMediaKinds: ['image', 'video'],
  }] as SourceToolOption[],
}));
const postEditState = vi.hoisted(() => ({ post: null as Record<string, unknown> | null }));
// The files still on the device, by uri; anything else reads as gone.
const deviceFileState = vi.hoisted(() => ({ uris: new Set<string>() }));
// The creation the composer is opened on, when a case needs one other than `generationItem`.
const generationState = vi.hoisted(() => ({ item: null as Record<string, unknown> | null }));
const mutationState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  options: null as null | {
    mutationFn?: (visibility?: 'public' | 'unlisted' | 'private') => Promise<unknown>;
    onMutate?: (visibility?: 'public' | 'unlisted' | 'private') => { submittedDraft?: unknown } | void;
    onSuccess?: (
      response: { postId?: string | null },
      visibility?: 'public' | 'unlisted' | 'private',
      context?: { submittedDraft?: unknown } | void
    ) => void;
    onError?: (error: unknown, visibility?: 'public' | 'unlisted' | 'private', context?: unknown) => void;
  },
}));
const queryClientState = vi.hoisted(() => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }));
const queryOptionsState = vi.hoisted(() => ({ options: [] as Array<{ queryKey: string[]; enabled?: boolean; gcTime?: number }> }));
const keyboardState = vi.hoisted(() => ({ dismiss: vi.fn() }));
// Android's back key, as the screen's own surfaces claim it.
const backHandlerState = vi.hoisted(() => ({ listeners: new Set<() => boolean>() }));
// Timed animations end at once unless a case holds them, to look at a sheet
// while it is still leaving; `finishAnimations` then delivers their ends.
const animatedState = vi.hoisted(() => ({
  hold: false,
  pending: [] as Array<(result: { finished: boolean }) => void>,
}));

function finishAnimations() {
  for (const done of animatedState.pending.splice(0)) done({ finished: true });
}

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

// The community-rules gate has its own tests (content-policy-gate.test.tsx);
// here it passes straight through to the screen under test.
vi.mock('@/components/content-policy-gate', () => ({
  ContentPolicyGate: ({ children }: { children: unknown }) => children,
}));

vi.mock('expo-router', () => ({
  Redirect: (props: MockProps) => React.createElement('redirect', props),
  Stack: { Screen: (props: MockProps) => React.createElement('stack-screen', props) },
  router: routerState,
  useLocalSearchParams: () => paramsState.params,
}));

vi.mock('@react-navigation/native', async () => {
  const { createContext } = await import('react');
  return {
    useNavigation: () => navigationState,
    usePreventRemove: vi.fn(),
    // The media row locks the navigator's swipe-back while a card is held, and
    // reads the navigator off this context so a card rendered outside one is
    // inert rather than throwing.
    NavigationContext: createContext(navigationState),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storageState.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storageState.values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storageState.values.delete(key);
    }),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClientState,
  useMutation: (options: typeof mutationState.options) => {
    mutationState.options = options;
    return mutationState;
  },
  useQuery: (options: { queryKey: string[]; enabled?: boolean; gcTime?: number }) => {
    queryOptionsState.options.push(options);
    if (options.queryKey[0] === 'post-new-generations') {
      return { data: { generations: [generationState.item ?? generationItem] }, error: null, isLoading: false, isSuccess: true };
    }
    if (options.queryKey[0] === 'post-edit') {
      return postEditState.post
        ? { data: { post: postEditState.post }, error: null, isLoading: false, isSuccess: true }
        : { data: null, error: null, isLoading: false, isSuccess: false };
    }
    if (options.queryKey[0] === 'post-source-tools') {
      return { data: { tools: sourceToolsState.tools }, error: null, isLoading: false, isSuccess: true };
    }
    return { data: null, error: null, isLoading: false, isSuccess: false };
  },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Alert: alertState,
  Animated: {
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
    Value: class {
      constructor(public value: number) {}

      setValue(next: number) {
        this.value = next;
      }

      // The composer's toggles and chips stop a value before they move it (`lib/motion`).
      stopAnimation() {}

      interpolate(config: unknown) {
        return { interpolate: config };
      }
    },
    add: (a: unknown, b: unknown) => ({ add: [a, b] }),
    multiply: (a: unknown, b: unknown) => ({ multiply: [a, b] }),
    timing: () => ({
      start: (done?: (result: { finished: boolean }) => void) => {
        if (!done) return;
        if (animatedState.hold) animatedState.pending.push(done);
        else done({ finished: true });
      },
      stop: () => undefined,
    }),
    spring: () => ({
      start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      stop: () => undefined,
    }),
  },
  BackHandler: {
    addEventListener: (_name: string, listener: () => boolean) => {
      backHandlerState.listeners.add(listener);
      return { remove: () => backHandlerState.listeners.delete(listener) };
    },
  },
  Easing: { in: (fn: unknown) => fn, out: (fn: unknown) => fn, cubic: 'cubic' },
  findNodeHandle: vi.fn(() => 1),
  Keyboard: keyboardState,
  KeyboardAvoidingView: ({ children, ...props }: MockProps) => React.createElement('keyboard-avoiding-view', props, children),
  Modal: ({ children, visible, ...props }: MockProps) => visible ? React.createElement('modal', props, children) : null,
  Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios || obj.default },
  Share: shareState,
  Pressable: React.forwardRef((_props: MockProps, ref) => {
    const { children, style, ...props } = _props;
    return React.createElement('pressable', { ...props, ref, style: resolvePressableStyle(style) }, children);
  }),
  PanResponder: { create: (handlers: Record<string, unknown>) => ({ panHandlers: handlers }) },
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: React.forwardRef((props: MockProps, ref) => React.createElement('textinput', { ...props, ref })),
  View: React.forwardRef((_props: MockProps, ref) => {
    const { children, ...props } = _props;
    return React.createElement('view', { ...props, ref }, children);
  }),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
vi.mock('expo-image', () => ({ Image: (props: MockProps) => React.createElement('image', props) }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children) }));
vi.mock('@/components/media-preview', () => ({ StableMediaImage: (props: MockProps) => React.createElement('stable-media-image', props) }));
// The composer media lightbox pulls in expo-video, whose native module cannot
// resolve under vitest.
vi.mock('expo-video', () => ({
  useVideoPlayer: () => ({ id: 'player' }),
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(name, props);
  return {
    ArrowLeft: icon('arrow-left-icon'),
    ChevronLeft: icon('chevron-left-icon'),
    Share: icon('share-icon'),
    Share2: icon('share2-icon'),
    Check: icon('check-icon'),
    ChevronDown: icon('chevron-down-icon'),
    ChevronRight: icon('chevron-right-icon'),
    FileText: icon('file-text-icon'),
    Globe2: icon('globe-icon'),
    ImageIcon: icon('image-icon'),
    Link2: icon('link-icon'),
    Lock: icon('lock-icon'),
    Package: icon('package-icon'),
    Pencil: icon('pencil-icon'),
    Play: icon('play-icon'),
    Plus: icon('plus-icon'),
    Sparkles: icon('sparkles-icon'),
    Trash2: icon('trash-icon'),
    Upload: icon('upload-icon'),
    X: icon('x-icon'),
  };
});

// The real @/lib/media imports the expo pickers, whose native core does not
// resolve under vitest — stub them so importOriginal below can load the module.
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: vi.fn() }));
vi.mock('@/lib/media', async (importOriginal) => ({
  // Pure helpers (duration limits, ms→s conversion) stay real; only the
  // picker/upload side effects are stubbed.
  ...(await importOriginal<typeof import('../lib/media')>()),
  pickMedia: vi.fn(),
  pickMediaList: vi.fn(),
  pickResourceDocument: vi.fn(),
  uploadPickedMedia: vi.fn(),
  uploadResourceDocument: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}

    get exists() {
      return deviceFileState.uris.has(this.uri);
    }
  },
}));

import NewPostScreen from '../app/post/new';
import { ApiError } from '../lib/api-client';
import { pickMediaList, pickResourceDocument, uploadPickedMedia, uploadResourceDocument } from '@/lib/media';
import {
  buildPostResourceBundleInput,
  getDefaultPostComposerDraft,
  type PostComposerDraft,
  type PostComposerMediaItem,
} from '../lib/post-new-view-model';

function collectText(root: renderer.ReactTestInstance) {
  return root
    .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

function findPressableByText(root: renderer.ReactTestInstance, text: string) {
  const textInstances = root.findAllByProps({ children: text });
  for (const textInstance of textInstances) {
    let current: renderer.ReactTestInstance | null = textInstance;
    while (current && String(current.type) !== 'pressable') current = current.parent;
    if (current) return current;
  }
  throw new Error(`No pressable containing text "${text}" was found`);
}

function findPressableByAccessibilityLabel(root: renderer.ReactTestInstance, label: string) {
  const pressable = root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)[0];
  if (!pressable) throw new Error(`No pressable with accessibility label "${label}" was found`);
  return pressable;
}

function findTextInputByPlaceholder(root: renderer.ReactTestInstance, placeholder: string) {
  const input = root.findAll((node) => String(node.type) === 'textinput' && node.props.placeholder === placeholder)[0];
  if (!input) throw new Error(`No text input with placeholder "${placeholder}" was found`);
  return input;
}

function findTextInputByAccessibilityLabel(root: renderer.ReactTestInstance, label: string) {
  const input = root.findAll((node) => String(node.type) === 'textinput' && node.props.accessibilityLabel === label)[0];
  if (!input) throw new Error(`No text input with accessibility label "${label}" was found`);
  return input;
}

async function renderScreen() {
  let tree: renderer.ReactTestRenderer | undefined;
  await renderer.act(async () => {
    tree = renderer.create(<NewPostScreen />);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mountedTrees.push(tree!);
  return tree!;
}

const mountedTrees: renderer.ReactTestRenderer[] = [];

async function uploadManualMedia(assets = [
  { uri: 'file:///cover.png', fileName: 'cover.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
]) {
  vi.mocked(pickMediaList).mockResolvedValueOnce(assets);
  vi.mocked(uploadPickedMedia).mockImplementation(async (uri, options) => ({
    signedUrl: uri,
    storagePath: `uploads/${options?.fileName ?? 'media.png'}`,
    mimeType: options?.mimeType ?? 'image/png',
    fileName: options?.fileName ?? 'media.png',
    kind: options?.kind === 'video' ? 'video' : 'image',
    durationSeconds: null,
    sizeBytes: options?.sizeBytes ?? null,
  }));
}

async function choosePreparedMedia(tree: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    findPressableByText(tree.root, 'Add media').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('mobile external post composer', () => {
  afterEach(() => {
    renderer.act(() => {
      for (const tree of mountedTrees.splice(0)) {
        tree.unmount();
      }
    });
  });
  it('uses the same full-screen push presentation as the media creator', () => {
    const layoutSource = readFileSync('app/_layout.tsx', 'utf8');
    const postRoute = layoutSource.match(/<Stack\.Screen\s+name="post\/new"[\s\S]*?\/>/)?.[0] ?? '';

    expect(postRoute).toContain("presentation: 'card'");
    expect(postRoute).toContain("animation: reducedMotion ? 'none' : 'simple_push'");
    expect(postRoute).not.toContain("presentation: 'modal'");
    expect(postRoute).not.toContain('slide_from_bottom');
  });

  it('disables the native back gesture only while unsaved changes are present', async () => {
    // On iOS 26 the back swipe pops the screen natively before the
    // usePreventRemove veto runs (react-navigation#13072), landing the leave
    // sheet on the previous screen. The gesture must be off while dirty; the
    // header Close button remains the way out.
    const tree = await renderScreen();
    const gestureEnabled = () => (
      tree.root.findAll((node) => String(node.type) === 'stack-screen')[0]
        .props.options as { gestureEnabled: boolean }
    ).gestureEnabled;

    expect(gestureEnabled()).toBe(true);

    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Neon skyline study'));

    expect(gestureEnabled()).toBe(false);
  });

  beforeEach(() => {
    paramsState.params = { generationId: 'gen-1' };
    routerState.push.mockClear();
    routerState.replace.mockClear();
    routerState.back.mockClear();
    routerState.canGoBack.mockReset();
    routerState.canGoBack.mockReturnValue(false);
    generationState.item = null;
    authState.api.createPost.mockReset();
    authState.api.updatePost.mockReset();
    authState.api.getOwnerPost.mockReset();
    deviceFileState.uris.clear();
    queryClientState.invalidateQueries.mockClear();
    queryClientState.setQueryData.mockClear();
    mutationState.mutate.mockClear();
    mutationState.options = null;
    mutationState.isPending = false;
    queryOptionsState.options = [];
    navigationState.dispatch.mockClear();
    alertState.alert.mockClear();
    storageState.values.clear();
    postEditState.post = null;
    vi.mocked(pickMediaList).mockReset();
    vi.mocked(pickMediaList).mockResolvedValue([]);
    vi.mocked(pickResourceDocument).mockReset();
    vi.mocked(pickResourceDocument).mockResolvedValue(null);
    vi.mocked(uploadPickedMedia).mockReset();
    vi.mocked(uploadResourceDocument).mockReset();
    sourceToolsState.tools = [{ slug: 'runway', label: 'Runway', models: [{ slug: 'gen-4', label: 'Gen-4' }], supportedMediaKinds: ['image', 'video'] }];
    authState.api.listSourceTools.mockResolvedValue({ tools: sourceToolsState.tools });
    shareState.share.mockReset();
    shareState.share.mockResolvedValue({ action: 'sharedAction' });
    authState.api.shareShowcasePost.mockClear();
    keyboardState.dismiss.mockClear();
    backHandlerState.listeners.clear();
    animatedState.hold = false;
    animatedState.pending.length = 0;
  });

  it('opens on a compact details step with one dominant next action', async () => {
    const tree = await renderScreen();
    const text = collectText(tree.root);
    expect(text).toContain('Create post');
    expect(text).toContain('Step 1 of 2 · post details');
    expect(text).toContain('Media');
    expect(text).toContain('Hero product image');
    expect(text).toContain('Title');
    expect(findPressableByAccessibilityLabel(tree.root, 'Made with')).toBeTruthy();
    expect(text).toContain('Story');
    // The forward button only moves to step 2; "Review & publish" is step 2's
    // title, and on this button it read as if the tap would publish.
    expect(text).toContain('Next');
    expect(findPressableByAccessibilityLabel(tree.root, 'Next')).toBeTruthy();
    expect(text).not.toContain('Review & publish');
    expect(text).not.toContain('Recipe');
    expect(text).not.toContain('Publish');
  });

  it('moves to the optional recipe step without losing generation details', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Review & publish');
    expect(text).toContain('Step 2 of 2 · recipe optional');
    expect(text).toContain('Ready to publish');
    expect(text).toContain('Recipe');
    expect(text).toContain('Free recipe');
    expect(text).toContain('Reward useful work');
    expect(text).toContain('Paid recipe');
    expect(text).toContain('Set a token price');
    expect(findPressableByText(tree.root, 'No recipe').props.accessibilityState).toEqual({ selected: true });
    expect(text).toContain('Publish public');
    expect(text).not.toContain('What is this creation about?');
  });

  // Product decision 1 (2026-10-17): the recipe noun is "Recipe", everywhere.
  // An app creator who tapped "Add a recipe" landed on a step about resources.
  it('says recipe, never resources, anywhere on step 2', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    const words = () => [
      ...collectText(tree.root),
      ...tree.root.findAll((node) => typeof node.props?.accessibilityLabel === 'string').map((node) => node.props.accessibilityLabel as string),
      ...tree.root.findAll((node) => typeof node.props?.accessibilityHint === 'string').map((node) => node.props.accessibilityHint as string),
    ].join('\n');

    expect(words()).not.toMatch(/resources/i);
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    expect(words()).not.toMatch(/resources/i);
    expect(collectText(tree.root)).toContain('Free recipe');
    renderer.act(() => findPressableByText(tree.root, 'Paid recipe').props.onPress());
    expect(words()).not.toMatch(/resources/i);
    expect(collectText(tree.root)).toContain('Paid recipe · 900 tokens');
  });

  it('uses header back to return to details and preserve state', async () => {
    const tree = await renderScreen();
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'Share the idea, process, or story behind it…').props.onChangeText('A concise story'));
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Back to post details').props.onPress());
    expect(findTextInputByPlaceholder(tree.root, 'Share the idea, process, or story behind it…').props.value).toBe('A concise story');
  });

  it('opens directly on resources when focus=resources is requested', async () => {
    paramsState.params = { generationId: 'gen-1', focus: 'resources' };
    const tree = await renderScreen();
    expect(collectText(tree.root)).toContain('Step 2 of 2 · recipe optional');
  });

  it('waits for the creator to request media instead of opening an unstable system picker during navigation', async () => {
    paramsState.params = {};
    await renderScreen();
    expect(pickMediaList).not.toHaveBeenCalled();
    expect(queryOptionsState.options.find((options) => options.queryKey[0] === 'post-new-generations')?.enabled).toBe(false);
  });

  it('holds a media post at post details until it is given a title', async () => {
    // Titles are required everywhere now, matching the server and the web
    // composer. Media alone is no longer enough to move on.
    paramsState.params = {};
    await uploadManualMedia();
    const tree = await renderScreen();
    await choosePreparedMedia(tree);
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    expect(collectText(tree.root)).toContain('Add a title for your post.');
    expect(collectText(tree.root)).not.toContain('Recipe');

    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Neon skyline study'));
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    expect(collectText(tree.root)).toContain('Recipe');
  });

  it('shows all required field errors inline in visual order', async () => {
    paramsState.params = {};
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Add at least one image or video to continue.');
    // Titles are optional now, so an empty one must not block or warn.
    expect(text).not.toContain('Add a title before continuing.');
    expect(text).toContain('Step 1 of 2 · post details');
  });

  it('creates a text post without requesting media', async () => {
    paramsState.params = {};
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Text post').props.onPress());
    const labeledTextInputs = tree.root
      .findAll((node) => String(node.type) === 'textinput' && ['Title, required', 'Post text, required'].includes(node.props.accessibilityLabel))
      .map((node) => node.props.accessibilityLabel);
    expect(labeledTextInputs).toEqual(['Title, required', 'Post text, required']);
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'Share a prompt, idea, breakdown, or useful note…').props.onChangeText('A useful text breakdown'));
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Prompt teardown'));
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Step 2 of 2 · recipe optional');
    expect(text).toContain('Prompt teardown');
    expect(text).not.toContain('Add at least one image or video to continue.');
  });

  it('opens optional Made with controls and retains searchable custom entries', async () => {
    paramsState.params = {};
    const tree = await renderScreen();
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Made with').props.onPress());
    const toolInput = findTextInputByPlaceholder(tree.root, 'Choose or search tool');
    renderer.act(() => toolInput.props.onChangeText('Pika Labs'));
    expect(collectText(tree.root)).toContain('Create "Pika Labs"');
  });

  it('builds a free prompt resource in a focused editor sheet', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    expect(collectText(tree.root)).toContain('Prompt or script');
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    expect(findTextInputByAccessibilityLabel(tree.root, 'Unlocked description, optional').props.placeholder).toBe('Optional note shown after unlock');
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'This content is revealed only after unlock').props.onChangeText('Exact reusable prompt'));
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Save resource').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('1 resource card');
    expect(text).toContain('Prompt or script');
    expect(findTextInputByPlaceholder(tree.root, 'Tell people what they will receive').props.value).toBe('Includes Prompt or script.');
  });

  it('shows resource-link validation in the editor before Save', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'External link').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'https://').props.onChangeText('example.com/resource'));

    expect(collectText(tree.root)).toContain('Add a valid http:// or https:// link.');
    expect(findPressableByAccessibilityLabel(tree.root, 'Save resource').props.disabled).toBe(true);
  });

  it('shows buyer-preview quality guidance next to the package preview', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'This content is revealed only after unlock').props.onChangeText('Exact reusable prompt'));
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Save resource').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'Tell people what they will receive').props.onChangeText('test'));

    expect(collectText(tree.root)).toContain('Improve this recipe before publishing: Add a useful preview or summary that tells buyers what the recipe includes.');
    expect(findPressableByAccessibilityLabel(tree.root, 'Publish public').props.disabled).toBe(true);
  });

  it('places listing-quality guidance beside a non-empty public summary', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'This content is revealed only after unlock').props.onChangeText('Exact reusable prompt'));
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Save resource').props.onPress());
    renderer.act(() => findTextInputByAccessibilityLabel(tree.root, 'Public package summary, optional').props.onChangeText('test'));

    const summaryInput = findTextInputByAccessibilityLabel(tree.root, 'Public package summary, optional');
    let summaryField = summaryInput.parent;
    while (summaryField && !collectText(summaryField).includes('Public summary')) summaryField = summaryField.parent;
    expect(summaryField).toBeTruthy();
    expect(collectText(summaryField!)).toContain('Improve this recipe before publishing: Add a useful preview or summary that tells buyers what the recipe includes.');
    expect(findPressableByAccessibilityLabel(tree.root, 'Publish public').props.disabled).toBe(true);
  });

  // The multipart route this used to call is retired and answers 410, so the
  // whole flow has to go through the signed direct upload instead.
  it('attaches a source file through the signed upload path', async () => {
    vi.mocked(pickResourceDocument).mockResolvedValue({
      uri: 'file:///tmp/project.zip',
      name: 'project.zip',
      mimeType: 'application/zip',
      size: 4096,
    } as never);
    vi.mocked(uploadResourceDocument).mockResolvedValue({
      label: 'project.zip',
      kind: 'file',
      storagePath: 'user-123/uuid-project.zip',
      contentType: 'application/zip',
      sizeBytes: 4096,
    } as never);

    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Source assets').props.onPress());
    await renderer.act(async () => {
      findPressableByText(tree.root, 'Add file').props.onPress();
    });

    expect(pickResourceDocument).toHaveBeenCalledWith('resource');
    expect(uploadResourceDocument).toHaveBeenCalledWith('file:///tmp/project.zip', expect.objectContaining({
      fileName: 'project.zip',
      mediaOnly: false,
      mimeType: 'application/zip',
      sizeBytes: 4096,
    }));
    expect(collectText(tree.root)).toContain('project.zip');

    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Save resource').props.onPress());
    expect(collectText(tree.root)).toContain('1 resource card');
  });

  it('keeps resource upload progress and recovery inside the editor sheet', async () => {
    vi.mocked(pickResourceDocument).mockResolvedValue({
      uri: 'file:///tmp/project.zip',
      name: 'project.zip',
      mimeType: 'application/zip',
      size: 10_000,
    } as never);
    vi.mocked(uploadResourceDocument).mockImplementation((_uri, options) => new Promise((resolve, reject) => {
      options.onProgress?.({ bytesSent: 4_000, totalBytes: 10_000, fraction: 0.4 });
      options.signal?.addEventListener('abort', () => {
        const error = new Error('Upload cancelled.');
        error.name = 'UploadCancelledError';
        reject(error);
      }, { once: true });
      // Keep the promise pending until the in-sheet Cancel action aborts it.
      void resolve;
    }));

    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Source assets').props.onPress());
    await renderer.act(async () => {
      findPressableByText(tree.root, 'Add file').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(collectText(tree.root)).toContain('Uploading file · 40%');
    expect(collectText(tree.root)).toContain('4 KB of 10 KB');
    expect(findPressableByAccessibilityLabel(tree.root, 'Save resource').props.disabled).toBe(true);

    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Close resource editor').props.onPress());
    expect(alertState.alert).toHaveBeenLastCalledWith(
      'File upload in progress',
      expect.stringContaining('Keep this resource editor open'),
      expect.any(Array),
      // `showConfirmDialog`'s fallback settles its promise on an Android
      // dismissal too, so the answer never strands the caller — see `lib/dialog`.
      expect.any(Object),
    );
    const closeButtons = alertState.alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    await renderer.act(async () => {
      closeButtons.find((button) => button.text === 'Cancel upload')?.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(collectText(tree.root)).toContain('Could not add file');
    expect(collectText(tree.root)).toContain('Upload cancelled. You can retry the selected file.');
    expect(findPressableByAccessibilityLabel(tree.root, 'Retry resource upload')).toBeTruthy();
    expect(collectText(tree.root)).not.toContain('project.zip');

    vi.mocked(uploadResourceDocument).mockResolvedValueOnce({
      label: 'project.zip',
      kind: 'file',
      storagePath: 'user-123/retried-project.zip',
      contentType: 'application/zip',
      sizeBytes: 10_000,
    } as never);
    await renderer.act(async () => {
      findPressableByAccessibilityLabel(tree.root, 'Retry resource upload').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pickResourceDocument).toHaveBeenCalledTimes(1);
    expect(collectText(tree.root)).toContain('project.zip');
    expect(collectText(tree.root)).not.toContain('Could not add file');
  });

  it('uses the media-only upload contract for reference cards', async () => {
    vi.mocked(pickResourceDocument).mockResolvedValue({
      uri: 'file:///tmp/reference.png',
      name: 'reference.png',
      mimeType: 'image/png',
      size: 2048,
    } as never);
    vi.mocked(uploadResourceDocument).mockResolvedValue({
      label: 'reference.png',
      kind: 'file',
      storagePath: 'user-123/reference.png',
      contentType: 'image/png',
      sizeBytes: 2048,
    } as never);

    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Reference media').props.onPress());
    await renderer.act(async () => {
      findPressableByText(tree.root, 'Add file').props.onPress();
    });

    expect(pickResourceDocument).toHaveBeenCalledWith('reference_media');
    expect(uploadResourceDocument).toHaveBeenCalledWith('file:///tmp/reference.png', expect.objectContaining({
      mediaOnly: true,
    }));
    expect(collectText(tree.root)).toContain('reference.png');
  });

  it('keeps resource edits isolated until Save and confirms dirty discard', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'This content is revealed only after unlock').props.onChangeText('Unsaved prompt'));

    // The resource editor has to give way to the keyboard on both platforms.
    // It used to rely on KeyboardAvoidingView, which was configured for iOS
    // only and so did nothing on Android once edge-to-edge stopped the window
    // resizing; KeyboardAvoidingArea shrinks the surface on either platform.
    const keyboardContainer = tree.root.findAll((node) => node.props?.testID === 'resource-editor-keyboard-area')[0];
    expect(keyboardContainer).toBeTruthy();
    // Inside the editor's own area: the page's scroll view carries the prop too, and comes first.
    const keyboardScroll = keyboardContainer.findAll((node) => String(node.type) === 'scrollview' && node.props.automaticallyAdjustKeyboardInsets)[0];
    expect(keyboardScroll).toBeTruthy();
    const pageArea = tree.root.findAll((node) => node.props?.testID === 'composer-keyboard-area')[0];
    expect(pageArea.findAll((node) => String(node.type) === 'scrollview' && node.props.automaticallyAdjustKeyboardInsets)).not.toHaveLength(0);

    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Close resource editor').props.onPress());
    expect(alertState.alert).toHaveBeenCalledWith(
      'Discard resource changes?',
      'This resource has unsaved changes.',
      expect.any(Array),
      expect.any(Object),
    );
    const buttons = alertState.alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    // The discard runs when the confirmation resolves, a microtask after the
    // press, so the tick has to be flushed before the card list is read back.
    await renderer.act(async () => {
      buttons.find((button) => button.text === 'Discard')?.onPress?.();
      await Promise.resolve();
    });
    expect(collectText(tree.root)).not.toContain('1 resource card');
  });

  describe('the resource sheet', () => {
    /** The Resources step with "Add a resource" open on its list of kinds. */
    async function openResourceKinds() {
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
      renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
      // Nothing has been asked of the keyboard or the back key by the page alone.
      expect(keyboardState.dismiss).not.toHaveBeenCalled();
      expect(backHandlerState.listeners.size).toBe(0);
      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
      return tree;
    }

    /** The same sheet a step on: the editor of a new prompt resource. */
    async function openPromptEditor() {
      const tree = await openResourceKinds();
      renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
      return tree;
    }

    function ancestors(node: renderer.ReactTestInstance) {
      const found: renderer.ReactTestInstance[] = [];
      for (let current = node.parent; current; current = current.parent) found.push(current);
      return found;
    }

    function flatStyle(style: unknown): Record<string, unknown> {
      if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
      return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
    }

    const contentField = (tree: renderer.ReactTestRenderer) => findTextInputByPlaceholder(tree.root, 'This content is revealed only after unlock');
    const closeButton = (tree: renderer.ReactTestRenderer) => findPressableByAccessibilityLabel(tree.root, 'Close resource editor');
    /** The editor's own scroll view: the nearest one above its fields. (With no overlay host in a test, the sheet draws in place.) */
    const editorBody = (tree: renderer.ReactTestRenderer) => ancestors(contentField(tree)).find((node) => String(node.type) === 'scrollview')!;
    const keyboardArea = (tree: renderer.ReactTestRenderer) => ancestors(closeButton(tree)).find((node) => node.props.testID === 'resource-editor-keyboard-area')!;
    /** The panel: the view whose first layout the sheet's slide waits for. */
    const panel = (tree: renderer.ReactTestRenderer) => ancestors(closeButton(tree)).find((node) => typeof node.props.onLayout === 'function')!;

    it('draws in the app’s own window, in an area that gives way to the keyboard and ends under the status bar', async () => {
      const tree = await openPromptEditor();
      const above = ancestors(contentField(tree));

      // A Modal is a window of its own on Android, where the keyboard tracker
      // reads nothing: the area lifted late and short on an event alone.
      expect(above.some((node) => String(node.type) === 'modal')).toBe(false);
      expect(above).toContain(keyboardArea(tree));

      // Both halves of the keyboard pairing, for the fields.
      const body = editorBody(tree);
      expect(body.props).toEqual(expect.objectContaining({
        automaticallyAdjustKeyboardInsets: true,
        keyboardShouldPersistTaps: 'handled',
      }));

      // The panel was lifted whole, 760pt of it on a tall phone, and its title,
      // its Close button and its first field left the top of the screen. It
      // gives up height instead: it may shrink, and the area it shrinks within
      // stops under the status bar (24 in this double) with a strip to spare.
      expect(flatStyle(panel(tree).props.style)).toEqual(expect.objectContaining({ flexShrink: 1, maxHeight: 844 * 0.9 }));
      expect(flatStyle(keyboardArea(tree).props.style)).toEqual(expect.objectContaining({ justifyContent: 'flex-end', paddingTop: 32 }));

      // What must stay where it can be pressed stays out of what scrolls.
      expect(ancestors(closeButton(tree))).not.toContain(body);
      expect(ancestors(findPressableByAccessibilityLabel(tree.root, 'Save resource'))).not.toContain(body);
    });

    it('takes the keyboard from the page as it opens, and puts its own away as it closes', async () => {
      const tree = await openResourceKinds();
      // Opening over a field of the page: a Modal's window took the keyboard
      // by taking the focus, and an overlay takes nothing.
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(1);

      // The step from the kinds to the editor is the same opening.
      renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(1);

      renderer.act(() => closeButton(tree).props.onPress());
      expect(collectText(tree.root)).not.toContain('Contents stay protected until unlock.');
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(2);
    });

    it('closes an untouched editor on Android’s back key, and asks first about one with changes', async () => {
      const tree = await openPromptEditor();
      expect(backHandlerState.listeners.size).toBe(1);

      renderer.act(() => contentField(tree).props.onChangeText('Unsaved prompt'));
      let claimed: boolean | undefined;
      renderer.act(() => {
        claimed = [...backHandlerState.listeners][0]();
      });
      // The key is the sheet's, and it asks what the Close button asks.
      expect(claimed).toBe(true);
      expect(alertState.alert).toHaveBeenLastCalledWith('Discard resource changes?', 'This resource has unsaved changes.', expect.any(Array), expect.any(Object));
      expect(contentField(tree).props.value).toBe('Unsaved prompt');
      expect(backHandlerState.listeners.size).toBe(1);

      const buttons = alertState.alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
      await renderer.act(async () => {
        buttons.find((button) => button.text === 'Discard')?.onPress?.();
        await Promise.resolve();
      });
      expect(collectText(tree.root)).not.toContain('Contents stay protected until unlock.');
      // Closed, it gives the key back to the page.
      expect(backHandlerState.listeners.size).toBe(0);
    });

    it('leaves showing the resource it was editing, and takes no press while it does', async () => {
      const tree = await openPromptEditor();
      const surface = () => ancestors(closeButton(tree)).find((node) => node.props.pointerEvents !== undefined);
      expect(surface()?.props.pointerEvents).toBe('auto');
      renderer.act(() => contentField(tree).props.onChangeText('Exact reusable prompt'));

      animatedState.hold = true;
      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Save resource').props.onPress());
      // Saved: the composer has the card and has dropped the editor's copy
      // and its step. The panel is still on its way out with its fields, or
      // it would fall to the height of its title under its own exit.
      expect(collectText(tree.root)).toContain('1 resource card');
      expect(collectText(tree.root)).toContain('Contents stay protected until unlock.');
      expect(contentField(tree).props.value).toBe('Exact reusable prompt');
      expect(findPressableByAccessibilityLabel(tree.root, 'Save resource')).toBeTruthy();
      expect(surface()?.props.pointerEvents).toBe('none');

      renderer.act(() => finishAnimations());
      expect(collectText(tree.root)).not.toContain('Contents stay protected until unlock.');
      expect(tree.root.findAll((node) => String(node.type) === 'textinput' && node.props.placeholder === 'This content is revealed only after unlock')).toHaveLength(0);
    });

    it('takes a pull from its title as from its grabber, and leaves a touch-down on its body to the scroll view', async () => {
      type Handler = (...args: unknown[]) => boolean;
      const tree = await openPromptEditor();
      const touch = { nativeEvent: { target: 57 }, stopPropagation: () => undefined };
      // This suite's PanResponder double hands a responder's config back as its
      // handlers, so each view shows which responder it carries.
      const carriesResponder = (node: renderer.ReactTestInstance) => typeof node.props.onStartShouldSetPanResponder === 'function';

      // The title row: taken as it lands, as the grabber's strip is, with no
      // question about where the body is scrolled to. The panel's own drag
      // waits for the body to be at its top: a pull from the title did
      // nothing once the fields had scrolled.
      const titleRow = ancestors(closeButton(tree)).find(carriesResponder)!;
      const titleStart = titleRow.props.onStartShouldSetPanResponder as Handler;
      expect(titleStart(touch, { dy: 0, dx: 0 })).toBe(true);
      expect(titleRow.props.onMoveShouldSetPanResponderCapture).toBeUndefined();

      // The panel: in its own window nothing above it takes an unowned touch,
      // so it waits for the pull. Held from its start, the touch is intercepted
      // from the scroll view inside on Android, and a slow drag that began on
      // a label scrolled nothing.
      const sheetPanel = ancestors(titleRow).find((node) => carriesResponder(node) && node.props.onStartShouldSetPanResponder !== titleStart)!;
      expect(typeof sheetPanel.props.onLayout).toBe('function');
      expect((sheetPanel.props.onStartShouldSetPanResponder as Handler)(touch, { dy: 0, dx: 0 })).toBe(false);
      expect((sheetPanel.props.onMoveShouldSetPanResponder as Handler)(touch, { dy: 12, dx: 0 })).toBe(true);
    });
  });

  it('keeps a legacy title private until the creator explicitly edits it', async () => {
    paramsState.params = { postId: 'post-legacy-resource' };
    postEditState.post = {
      id: 'post-legacy-resource',
      title: 'Legacy resource post',
      description: 'Existing description',
      body: 'Existing story',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/legacy.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: {
        accessMode: 'free',
        summary: 'A compact public summary for the existing package.',
        previewText: 'Includes the reusable prompt and guidance.',
        resources: {
          items: [{
            id: 'legacy-prompt',
            type: 'prompt',
            title: 'Private client launch prompt',
            textContent: 'Protected prompt',
            sortOrder: 0,
          }],
        },
      },
      hasPaidOrders: false,
    };

    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    expect(findTextInputByAccessibilityLabel(tree.root, 'Public package summary, optional').props.value)
      .toBe('A compact public summary for the existing package.');
    expect(findTextInputByAccessibilityLabel(tree.root, 'Package preview, required').props.value)
      .toBe('Includes the reusable prompt and guidance.');
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Edit Private client launch prompt').props.onPress());
    expect(collectText(tree.root)).toContain('This legacy title stays private. Editing it makes the updated title visible in the locked package preview.');

    renderer.act(() => findTextInputByAccessibilityLabel(tree.root, 'Resource title, required').props.onChangeText('Reusable launch prompt'));
    expect(collectText(tree.root)).not.toContain('This legacy title stays private. Editing it makes the updated title visible in the locked package preview.');
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Save resource').props.onPress());

    const contextHolder: {
      value?: {
        submittedDraft?: {
          resource: {
            cards: Array<{ publicTitleIntent?: string }>;
            summary: string;
            previewText: string;
          };
        };
      };
    } = {};
    renderer.act(() => {
      contextHolder.value = mutationState.options?.onMutate?.('public') as typeof contextHolder.value;
    });
    expect(contextHolder.value?.submittedDraft?.resource.cards[0]?.publicTitleIntent).toBe('explicit');
    expect(contextHolder.value?.submittedDraft?.resource).toMatchObject({
      summary: 'A compact public summary for the existing package.',
      previewText: 'Includes the reusable prompt and guidance.',
    });
  });

  it('does not resurrect legacy protected fields after the last hydrated card is removed', async () => {
    paramsState.params = { postId: 'post-remove-last-resource' };
    postEditState.post = {
      id: 'post-remove-last-resource',
      title: 'Legacy resource deletion',
      description: 'Existing description',
      body: 'Existing story',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/legacy.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: {
        accessMode: 'free',
        summary: 'A useful public summary for the legacy resource.',
        previewText: 'Includes a reusable prompt and practical guidance.',
        resources: {
          promptText: 'Old protected prompt that must stay deleted',
          items: [{
            id: 'legacy-delete-prompt',
            type: 'prompt',
            title: 'Private prompt to remove',
            textContent: 'Old protected prompt that must stay deleted',
            sortOrder: 0,
          }],
        },
      },
      hasPaidOrders: false,
    };

    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Remove Private prompt to remove').props.onPress());

    const context = mutationState.options?.onMutate?.('public') as {
      submittedDraft?: PostComposerDraft;
    } | void;
    expect(context?.submittedDraft?.resource).toMatchObject({
      cardAuthoringMode: 'cards',
      accessMode: 'none',
      cards: [],
      promptText: 'Old protected prompt that must stay deleted',
    });
    expect(buildPostResourceBundleInput(context!.submittedDraft!.resource)).toBeNull();
  });

  it('keeps files visible when a hydrated legacy card is primarily text', async () => {
    paramsState.params = { postId: 'post-mixed-resource' };
    postEditState.post = {
      id: 'post-mixed-resource',
      title: 'Mixed legacy resource post',
      description: 'Existing description',
      body: 'Existing story',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/legacy.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: {
        accessMode: 'free',
        previewText: 'Includes a reusable prompt and its supporting archive.',
        resources: {
          sections: [{
            id: 'mixed-card',
            title: 'Mixed resource kit',
            publicTitle: 'Mixed resource kit',
            kind: 'global',
            sortOrder: 0,
          }],
          items: [{
            id: 'mixed-prompt',
            type: 'prompt',
            title: 'Prompt',
            textContent: 'Protected prompt',
            sectionId: 'mixed-card',
            sortOrder: 0,
          }, {
            id: 'mixed-file',
            type: 'source_file',
            title: 'archive.zip',
            storagePath: 'user-123/archive.zip',
            contentType: 'application/zip',
            sectionId: 'mixed-card',
            sortOrder: 1,
          }],
        },
      },
      hasPaidOrders: false,
    };

    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Edit Mixed resource kit').props.onPress());

    expect(collectText(tree.root)).toContain('archive.zip');
    expect(findPressableByAccessibilityLabel(tree.root, 'Remove archive.zip')).toBeTruthy();
  });

  it('uses semantic accessibility names instead of placeholders', async () => {
    paramsState.params = {};
    const tree = await renderScreen();
    expect(findTextInputByAccessibilityLabel(tree.root, 'Title, required')).toBeTruthy();
    expect(findTextInputByAccessibilityLabel(tree.root, 'Story, optional')).toBeTruthy();
    renderer.act(() => findPressableByText(tree.root, 'Text post').props.onPress());
    expect(findTextInputByAccessibilityLabel(tree.root, 'Post text, required')).toBeTruthy();
    renderer.act(() => findTextInputByAccessibilityLabel(tree.root, 'Title, required').props.onChangeText('Accessible resource post'));
    renderer.act(() => findTextInputByAccessibilityLabel(tree.root, 'Post text, required').props.onChangeText('A useful public text post with enough detail.'));
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    expect(findTextInputByAccessibilityLabel(tree.root, 'Public package summary, optional')).toBeTruthy();
    expect(findTextInputByAccessibilityLabel(tree.root, 'Package preview, required')).toBeTruthy();
  });

  it('supports a paid token price and shows estimated creator earnings', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Paid recipe').props.onPress());
    const price = findTextInputByPlaceholder(tree.root, '100');
    renderer.act(() => price.props.onChangeText('50'));
    const text = collectText(tree.root);
    expect(text).toContain('You earn ~42.5 tokens');
    expect(text).toContain('Credit-only purchase on web and mobile below 100 tokens.');
  });

  it('shows per-output scope only when multiple proof media exist', async () => {
    paramsState.params = {};
    await uploadManualMedia([
      { uri: 'file:///one.png', fileName: 'one.png', mimeType: 'image/png', fileSize: 100, width: 100, height: 100 },
      { uri: 'file:///two.png', fileName: 'two.png', mimeType: 'image/png', fileSize: 100, width: 100, height: 100 },
    ]);
    const tree = await renderScreen();
    await choosePreparedMedia(tree);
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Two studies'));
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    expect(collectText(tree.root)).toContain('Applies to');
    expect(collectText(tree.root)).toContain('All outputs');
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Apply to output 2').props.onPress());
    expect(findPressableByAccessibilityLabel(tree.root, 'Apply to output 2').props.accessibilityState.selected).toBe(true);
  });

  it('publishes without forcing a resource package', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Publish public').props.onPress());
    expect(mutationState.mutate).toHaveBeenCalledWith('public');
  });

  it('changes visibility from a compact sheet', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Visibility: Public').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Private').props.onPress());
    expect(findPressableByAccessibilityLabel(tree.root, 'Visibility: Private')).toBeTruthy();
  });

  // A post is public or private (product decisions 2026-10-17, item 12).
  it('offers Public and Private only', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Visibility: Public').props.onPress());

    const text = collectText(tree.root);
    expect(text).toContain('Visible in Explore and your profile.');
    expect(text).toContain('Only you can see it in Studio.');
    expect(text).not.toContain('Unlisted');
    expect(text).not.toContain('Only people with the link can open it.');
  });

  it('opens an old unlisted post as Private', async () => {
    paramsState.params = { postId: 'post-unlisted' };
    postEditState.post = {
      id: 'post-unlisted',
      title: 'Link-only post',
      description: null,
      body: 'Existing story',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'unlisted',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/unlisted.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: null,
      hasPaidOrders: false,
    };
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

    expect(findPressableByAccessibilityLabel(tree.root, 'Visibility: Private')).toBeTruthy();
    expect(collectText(tree.root)).not.toContain('Unlisted');
  });

  // An edited post's media with no original name is named by its id, which the card showed: a UUID, or
  // "<post id>:cover" for a post older than its media rows (review of the redundant-UI leftovers).
  it('names an edited post’s media by kind where it has no file name', async () => {
    paramsState.params = { postId: 'post-legacy' };
    postEditState.post = {
      id: 'post-legacy',
      title: 'Legacy post',
      description: null,
      body: 'Existing story',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/legacy.png',
      mediaKind: 'image',
      mediaItems: [
        { id: 'post-legacy:cover', mediaKey: 'cover', url: 'https://cdn.example.com/legacy.png', previewUrl: null, originalName: null, contentType: 'image/png', mediaKind: 'image' },
        { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', mediaKey: 'row-2', url: 'https://cdn.example.com/clip.mp4', previewUrl: null, originalName: null, contentType: 'video/mp4', mediaKind: 'video' },
        { id: 'row-3', mediaKey: 'row-3', url: 'https://cdn.example.com/street.png', previewUrl: null, originalName: 'Street.png', contentType: 'image/png', mediaKind: 'image' },
      ],
      resourceBundleInput: null,
      hasPaidOrders: false,
    };
    const tree = await renderScreen();

    const cardLines = (label: string) => collectText(tree.root.findAll((node) => (
      node.props.accessibilityLabel === label && typeof node.props.accessibilityValue?.text === 'string'
    ))[0]);
    expect(cardLines('Cover')).toEqual(['Cover', 'Image']);
    expect(cardLines('Media 2')).toEqual(['Media 2', 'Video']);
    expect(cardLines('Media 3')).toEqual(['Media 3', 'Street.png']);
  });

  it('restores a draft an older build saved as unlisted as Private', async () => {
    paramsState.params = {};
    storageState.values.set('magicbooklet.post.drafts.v1', JSON.stringify({
      'user-123:new': {
        draft: {
          ...getDefaultPostComposerDraft(),
          mode: 'text',
          title: 'Saved before the update',
          contentText: 'A note kept on this device.',
          visibility: 'unlisted',
        },
        step: 'details',
        updatedAt: new Date().toISOString(),
      },
    }));
    const tree = await renderScreen();
    expect(collectText(tree.root)).toContain('Draft restored');
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

    expect(findPressableByAccessibilityLabel(tree.root, 'Visibility: Private')).toBeTruthy();
    expect(findPressableByAccessibilityLabel(tree.root, 'Save private')).toBeTruthy();
  });

  it('locks a paid resource package after buyers have unlocked it', async () => {
    paramsState.params = { postId: 'post-sold' };
    postEditState.post = {
      id: 'post-sold',
      title: 'Sold prompt',
      description: 'Existing description',
      body: 'Existing story',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/sold.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: {
        accessMode: 'paid',
        previewText: 'Includes the exact prompt.',
        priceUsdCents: 100,
        resources: {
          items: [{
            id: 'item-1',
            type: 'prompt',
            title: 'Exact prompt',
            textContent: 'Protected prompt',
            sortOrder: 0,
          }],
        },
      },
      hasPaidOrders: true,
    };
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Purchased recipe is protected');
    expect(text).toContain('People have already unlocked this recipe, so its access mode, price, and contents cannot be changed. Visibility changes still apply to the post.');
    expect(text).toContain('Existing recipe preserved');
    expect(text).toContain('Paid recipe · 100 tokens · 1 item');
    expect(text).not.toContain('No recipe');
    expect(text.join('\n')).not.toMatch(/resources/i);
  });

  it('routes a successful post back to the profile Posts tab', async () => {
    paramsState.params = {};
    await renderScreen();
    renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-123' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // `published` is what earns the notifications offer on the profile.
    expect(routerState.replace).toHaveBeenCalledWith({ pathname: '/(tabs)/profile', params: { tab: 'posts', postId: 'post-123', published: '1' } });
  });

  // An edit refreshed Your Sales and a new post did not, so a listing made in
  // the composer was missing from it.
  it('refreshes Your Sales after a new post', async () => {
    paramsState.params = {};
    await renderScreen();
    queryClientState.invalidateQueries.mockClear();
    renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-123' }));
    // The composer leaves on the next tick; waiting keeps that out of the next test.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClientState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['seller-dashboard-posts', 'user-123'] });
  });

  describe('after saving an edit', () => {
    const editedPost = {
      id: 'post-edit-1',
      title: 'Existing post',
      description: null,
      body: 'Existing story',
      postFormat: 'mixed',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/existing.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: null,
      hasPaidOrders: false,
    };

    async function saveEdit(canGoBack: boolean) {
      paramsState.params = { postId: 'post-edit-1' };
      postEditState.post = editedPost;
      routerState.canGoBack.mockReturnValue(canGoBack);
      await renderScreen();
      renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-edit-1' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Opened from the viewer, the post page or the seller dashboard, an edit
    // used to land on the profile like a new post, offer included.
    it('returns to the screen that opened the editor, refreshed', async () => {
      await saveEdit(true);

      expect(routerState.back).toHaveBeenCalledTimes(1);
      expect(routerState.replace).not.toHaveBeenCalled();
      expect(queryClientState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['immersive-preview-source'] });
      expect(queryClientState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['showcase-post', 'post-edit-1'] });
      expect(queryClientState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['owner-text-post', 'post-edit-1'] });
      expect(queryClientState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['seller-dashboard-posts', 'user-123'] });
      // The post page's recipe is kept for a minute, and showed the price and
      // cards from before the save on the way back.
      expect(queryClientState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['post-resource-bundle', 'post-edit-1'] });
      // Reopening the editor from there must not prefill from the copy loaded
      // before the save.
      expect(queryOptionsState.options.find((options) => options.queryKey[0] === 'post-edit')?.gcTime).toBe(0);
    });

    it('lands on the profile without the publish offer when nothing is behind it', async () => {
      await saveEdit(false);

      expect(routerState.back).not.toHaveBeenCalled();
      expect(routerState.replace).toHaveBeenCalledWith({ pathname: '/(tabs)/profile', params: { tab: 'posts', postId: 'post-edit-1' } });
    });
  });

  // The web editor shows a post's Explore description apart from its body;
  // reading it into the Story turned a media post mixed on its first save here.
  it('loads the Story from the body alone and carries a web description through unchanged', async () => {
    paramsState.params = { postId: 'post-web' };
    postEditState.post = {
      id: 'post-web',
      title: 'Web post',
      description: 'Explore copy from the web',
      body: '',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: 'Manual',
      sourceToolSlug: 'manual',
      mediaUrl: 'https://cdn.example.com/web.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: null,
      hasPaidOrders: false,
    };

    const tree = await renderScreen();
    expect(findTextInputByAccessibilityLabel(tree.root, 'Story, optional').props.value).toBe('');

    let context: { submittedDraft?: PostComposerDraft } | void = undefined;
    renderer.act(() => {
      context = mutationState.options?.onMutate?.('public') as typeof context;
    });
    expect((context as { submittedDraft?: PostComposerDraft } | undefined)?.submittedDraft).toMatchObject({
      caption: '',
      description: 'Explore copy from the web',
    });
  });

  describe('title prefill from a creation', () => {
    it('starts untitled when the creation has no title, rather than from its prompt', async () => {
      generationState.item = { ...generationItem, title: null };
      const tree = await renderScreen();
      expect(findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.value).toBe('');
    });

    it('takes the template title when the creation has none', async () => {
      generationState.item = {
        ...generationItem,
        title: null,
        origin: 'template',
        template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Ghost rider' },
      };
      const tree = await renderScreen();
      expect(findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.value).toBe('Ghost rider');
    });

    it('takes the creation’s own title first', async () => {
      const tree = await renderScreen();
      expect(findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.value).toBe('Hero product image');
    });
  });

  // The category used to follow only the first media added; a reorder kept it,
  // and the create route refused the mismatch with a message about a control
  // this app does not have.
  it('files a new post under its cover after a video is moved first', async () => {
    paramsState.params = {};
    await uploadManualMedia([
      { uri: 'file:///still.png', fileName: 'still.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
      { uri: 'file:///clip.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', type: 'video', fileSize: 4096, duration: 8000, width: 1080, height: 1920 },
    ] as never);
    const tree = await renderScreen();
    await choosePreparedMedia(tree);

    // A card is named by its label and placed by its value.
    const videoCard = tree.root.findAll((node) => node.props.accessibilityLabel === 'Media 2' && node.props.accessibilityValue?.text === '2 of 2')[0];
    renderer.act(() => videoCard.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
    expect(tree.root.findAll((node) => String(node.type) === 'text' && node.props.children === 'clip.mp4')).toHaveLength(1);
    expect(tree.root.findAll((node) => node.props.accessibilityLabel === 'Cover' && node.props.accessibilityValue?.text === '1 of 2').length).toBeGreaterThan(0);
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Mixed gallery'));

    authState.api.createPost.mockResolvedValueOnce({ postId: 'post-mixed' });
    await renderer.act(async () => {
      await mutationState.options?.mutationFn?.('public');
    });

    const formData = authState.api.createPost.mock.calls.at(-1)?.[0] as unknown as FormData;
    expect(formData.get('category')).toBe('video');
    expect(JSON.parse(String(formData.get('mediaItems'))).map((item: { originalName: string }) => item.originalName))
      .toEqual(['clip.mp4', 'still.png']);
  });

  // Android's system photo picker hands a picture over under its media id, and a card's second line read
  // "1000333161.jpg" (redundant-UI audit, 2026-10-21). The file's name still goes to the server as it was.
  it('names a card by its kind where its file name says nothing', async () => {
    paramsState.params = {};
    await uploadManualMedia([
      { uri: 'file:///1000333161.jpg', fileName: '1000333161.jpg', mimeType: 'image/jpeg', fileSize: 1024, width: 1024, height: 1024 },
      { uri: 'file:///1000333162.mp4', fileName: '1000333162.mp4', mimeType: 'video/mp4', type: 'video', fileSize: 4096, duration: 8000, width: 1080, height: 1920 },
      { uri: 'file:///still.png', fileName: 'still.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
    ] as never);
    const tree = await renderScreen();
    await choosePreparedMedia(tree);

    const cardLines = (label: string) => collectText(tree.root.findAll((node) => (
      node.props.accessibilityLabel === label && typeof node.props.accessibilityValue?.text === 'string'
    ))[0]);
    expect(cardLines('Cover')).toEqual(['Cover', 'Image']);
    expect(cardLines('Media 2')).toEqual(['Media 2', 'Video']);
    expect(cardLines('Media 3')).toEqual(['Media 3', 'still.png']);

    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Picker names'));
    authState.api.createPost.mockResolvedValueOnce({ postId: 'post-picker-names' });
    await renderer.act(async () => {
      await mutationState.options?.mutationFn?.('public');
    });
    const formData = authState.api.createPost.mock.calls.at(-1)?.[0] as unknown as FormData;
    expect(JSON.parse(String(formData.get('mediaItems'))).map((item: { originalName: string }) => item.originalName))
      .toEqual(['1000333161.jpg', '1000333162.mp4', 'still.png']);
  });

  describe('media the post cannot take', () => {
    const MB = 1024 * 1024;

    it('refuses an oversized video before uploading any of it', async () => {
      paramsState.params = {};
      await uploadManualMedia([
        { uri: 'file:///long.mp4', fileName: 'long.mp4', mimeType: 'video/mp4', type: 'video', fileSize: 300 * MB, duration: 60_000, width: 1080, height: 1920 },
        { uri: 'file:///still.png', fileName: 'still.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
      ] as never);
      const tree = await renderScreen();
      await choosePreparedMedia(tree);

      expect(vi.mocked(uploadPickedMedia).mock.calls.map(([uri]) => uri)).toEqual(['file:///still.png']);
      const text = collectText(tree.root);
      expect(text).toContain('Video too large');
      expect(text).toContain('Videos must be 250 MB or smaller.');
      expect(text).toContain('still.png');
    });

    function pickWithOneFailure() {
      vi.mocked(pickMediaList).mockResolvedValueOnce([
        { uri: 'file:///still.png', fileName: 'still.png', mimeType: 'image/png', fileSize: 1024, width: 1024, height: 1024 },
        { uri: 'file:///broken.png', fileName: 'broken.png', mimeType: 'image/png', fileSize: 2048, width: 1024, height: 1024 },
      ] as never);
      vi.mocked(uploadPickedMedia).mockImplementation(async (uri, options) => {
        if (uri === 'file:///broken.png') throw new Error('The connection was lost.');
        return {
          signedUrl: uri,
          storagePath: `uploads/${options?.fileName ?? 'media.png'}`,
          mimeType: 'image/png',
          fileName: options?.fileName ?? 'media.png',
          kind: 'image',
          durationSeconds: null,
          sizeBytes: options?.sizeBytes ?? null,
        };
      });
    }

    // Publish stayed off while a failed upload waited for a retry, and some
    // failures never pass on a retry: the only escape was the picker.
    it('offers Remove failed beside Retry, which lets Publish go', async () => {
      paramsState.params = {};
      pickWithOneFailure();
      const tree = await renderScreen();
      await choosePreparedMedia(tree);
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Kept still'));
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

      expect(findPressableByAccessibilityLabel(tree.root, 'Retry 1 media upload')).toBeTruthy();
      expect(findPressableByAccessibilityLabel(tree.root, 'Publish public').props.disabled).toBe(true);

      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Remove failed').props.onPress());

      expect(tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Retry 1 media upload')).toHaveLength(0);
      expect(tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Remove failed')).toHaveLength(0);
      expect(findPressableByAccessibilityLabel(tree.root, 'Publish public').props.disabled).toBe(false);
      // What did upload is still the post's.
      const context = mutationState.options?.onMutate?.('public') as { submittedDraft?: PostComposerDraft } | void;
      expect(context?.submittedDraft?.mediaItems.map((item) => item.name)).toEqual(['still.png']);
    });

    it('clears the failure notice along with the failed media', async () => {
      paramsState.params = {};
      pickWithOneFailure();
      const tree = await renderScreen();
      await choosePreparedMedia(tree);
      expect(collectText(tree.root)).toContain('1 media upload failed');

      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Remove failed').props.onPress());
      expect(collectText(tree.root)).not.toContain('1 media upload failed');
    });
  });

  it('caps a made-with tool or model name at the server’s 80 characters', async () => {
    paramsState.params = {};
    const tree = await renderScreen();
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Made with').props.onPress());
    expect(findTextInputByPlaceholder(tree.root, 'Choose or search tool').props.maxLength).toBe(80);
    expect(findTextInputByPlaceholder(tree.root, 'Any model').props.maxLength).toBe(80);
  });

  describe('publish then share', () => {
    // Reached by tapping Share on something not yet public. Publishing is the
    // real action and the share sheet follows it, so a shared link always points
    // at a post that exists rather than at a raw storage file or nothing at all.
    async function publishWithShareIntent(response: Record<string, unknown>) {
      paramsState.params = { shareAfterPublish: '1' };
      await renderScreen();
      renderer.act(() => mutationState.options?.onSuccess?.(response as { postId?: string | null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('opens the share sheet, records the share, then navigates', async () => {
      await publishWithShareIntent({ postId: 'post-123', visibility: 'public' });

      expect(shareState.share).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://magicbooklet.com/showcase/post-123?s=my-creations',
      }));
      expect(authState.api.shareShowcasePost).toHaveBeenCalledWith('post-123', { sourceSurface: 'my-creations' });
      expect(routerState.replace).toHaveBeenCalledWith({
        pathname: '/(tabs)/profile',
        params: { tab: 'posts', postId: 'post-123', published: '1' },
      });
    });

    it('skips the share when the post did not end up public', async () => {
      await publishWithShareIntent({ postId: 'post-124', visibility: 'private' });

      expect(shareState.share).not.toHaveBeenCalled();
      expect(routerState.replace).toHaveBeenCalled();
    });

    it('records nothing when the viewer dismisses the sheet, but still navigates', async () => {
      shareState.share.mockResolvedValueOnce({ action: 'dismissedAction' });
      await publishWithShareIntent({ postId: 'post-125', visibility: 'public' });

      expect(authState.api.shareShowcasePost).not.toHaveBeenCalled();
      expect(routerState.replace).toHaveBeenCalled();
    });

    it('still navigates when the share sheet cannot open', async () => {
      // Publishing already succeeded; a share failure must never strand the
      // creator on the composer as though the post had not gone out.
      shareState.share.mockRejectedValueOnce(new Error('no share sheet'));
      await publishWithShareIntent({ postId: 'post-126', visibility: 'public' });

      expect(routerState.replace).toHaveBeenCalledWith({
        pathname: '/(tabs)/profile',
        params: { tab: 'posts', postId: 'post-126', published: '1' },
      });
    });

    // Share on a post that is not public yet opens it in the editor; once it is
    // public and shared, the person is put back where they tapped Share.
    it('returns to the screen it was opened from after making a post public and sharing it', async () => {
      paramsState.params = { postId: 'post-private', shareAfterPublish: '1' };
      postEditState.post = {
        id: 'post-private',
        title: 'Private post',
        description: null,
        body: '',
        postFormat: 'media',
        generationId: null,
        category: 'image',
        visibility: 'private',
        sourceTool: 'Manual',
        sourceToolSlug: 'manual',
        mediaUrl: 'https://cdn.example.com/private.png',
        mediaKind: 'image',
        mediaItems: [],
        resourceBundleInput: null,
        hasPaidOrders: false,
      };
      routerState.canGoBack.mockReturnValue(true);
      await renderScreen();
      renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-private', visibility: 'public' } as { postId?: string | null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(shareState.share).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://magicbooklet.com/showcase/post-private?s=my-creations',
      }));
      expect(routerState.back).toHaveBeenCalledTimes(1);
      expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('does not share when the composer was not opened with a share intent', async () => {
      paramsState.params = {};
      await renderScreen();
      renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-127', visibility: 'public' } as { postId?: string | null }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(shareState.share).not.toHaveBeenCalled();
    });
  });

  // Every public post needs a claimed handle and a display name. The server says
  // so with `field: 'profile'` on all three routes, and the banner had no way on:
  // Close, Save draft, find Edit profile, come back.
  describe('a refusal for an incomplete profile', () => {
    const PROFILE_MESSAGE = 'Complete your profile before publishing publicly: choose a custom handle and add your display name.';
    const profileRefusal = () => new ApiError(PROFILE_MESSAGE, 400, {
      error: PROFILE_MESSAGE,
      field: 'profile',
      actionHref: '/profile',
      actionLabel: 'Complete profile and return',
    });
    const completeProfileButtons = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Complete profile'
    ));

    it('offers Complete profile, which opens profile editing over the composer', async () => {
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
      renderer.act(() => mutationState.options?.onError?.(profileRefusal(), 'public'));

      expect(collectText(tree.root)).toContain('Could not publish');
      expect(collectText(tree.root)).toContain(PROFILE_MESSAGE);
      renderer.act(() => completeProfileButtons(tree)[0].props.onPress());
      // Pushed over the composer, which stays where it is: saving the profile
      // comes back to the post as it was left.
      expect(routerState.push).toHaveBeenCalledWith('/edit-profile');
      expect(routerState.replace).not.toHaveBeenCalled();
      expect(navigationState.dispatch).not.toHaveBeenCalled();
    });

    it('offers it when an edit is refused for the same reason', async () => {
      paramsState.params = { postId: 'post-going-public' };
      postEditState.post = {
        id: 'post-going-public',
        title: 'Neon skyline study',
        description: null,
        body: '',
        postFormat: 'media',
        generationId: null,
        category: 'image',
        visibility: 'private',
        sourceTool: null,
        sourceToolSlug: null,
        mediaUrl: 'https://cdn.example.com/neon.png',
        mediaKind: 'image',
        mediaItems: [],
        resourceBundleInput: null,
        hasPaidOrders: false,
      };
      const tree = await renderScreen();
      renderer.act(() => mutationState.options?.onError?.(profileRefusal(), 'public'));

      expect(collectText(tree.root)).toContain('Could not save');
      expect(completeProfileButtons(tree)).toHaveLength(1);
    });

    it('offers nothing for a refusal of another kind', async () => {
      const tree = await renderScreen();
      renderer.act(() => mutationState.options?.onError?.(new ApiError('Add a title for your post.', 400, {
        error: 'Add a title for your post.',
        field: 'title',
      }), 'public'));

      expect(collectText(tree.root)).toContain('Add a title for your post.');
      expect(completeProfileButtons(tree)).toHaveLength(0);
    });
  });

  // The server refuses a public post with a placeholder title, or a text post
  // without enough useful text (contracts/public-post-quality-v1.json), and the
  // summary said "Ready to publish" for it.
  describe('the public-post rule on step 2', () => {
    it('says what to fix and keeps Publish public off, while Save private still goes', async () => {
      paramsState.params = {};
      await uploadManualMedia();
      const tree = await renderScreen();
      await choosePreparedMedia(tree);
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Product demo with Kling 3.0'));
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

      let text = collectText(tree.root);
      expect(text).toContain('Needs attention');
      expect(text).toContain('Replace the placeholder title with something specific to this post.');
      expect(text).not.toContain('Ready to publish');
      expect(findPressableByAccessibilityLabel(tree.root, 'Publish public').props.disabled).toBe(true);

      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Visibility: Public').props.onPress());
      renderer.act(() => findPressableByText(tree.root, 'Private').props.onPress());
      text = collectText(tree.root);
      expect(text).toContain('Ready to publish');
      expect(findPressableByAccessibilityLabel(tree.root, 'Save private').props.disabled).toBe(false);
    });

    it('asks a public text post for useful text', async () => {
      paramsState.params = {};
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Text post').props.onPress());
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Prompt teardown'));
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'Share a prompt, idea, breakdown, or useful note…').props.onChangeText('Too short body'));
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

      expect(collectText(tree.root)).toContain('Add useful text so viewers can understand the post before publishing.');
      expect(findPressableByAccessibilityLabel(tree.root, 'Publish public').props.disabled).toBe(true);
    });
  });

  // The server moves each staged upload into the post before it checks the Made
  // with catalog, so that refusal comes after the move, and so can a server
  // error or an answer that never arrived. A retry that sent the same paths was
  // refused every time ("That upload was already consumed").
  describe('a publish that may have used the uploads', () => {
    async function failFirstPublish(error: unknown) {
      paramsState.params = {};
      await uploadManualMedia();
      const tree = await renderScreen();
      await choosePreparedMedia(tree);
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Neon skyline study'));
      authState.api.createPost.mockRejectedValueOnce(error);
      await renderer.act(async () => {
        await mutationState.options?.mutationFn?.('public').catch(() => undefined);
      });
      return tree;
    }

    const sentStoragePaths = () => {
      const formData = authState.api.createPost.mock.calls.at(-1)?.[0] as unknown as FormData;
      return (JSON.parse(String(formData.get('mediaItems'))) as Array<{ storagePath?: string }>).map((item) => item.storagePath);
    };

    async function publishAgain() {
      authState.api.createPost.mockResolvedValueOnce({ postId: 'post-retried' });
      await renderer.act(async () => {
        await mutationState.options?.mutationFn?.('public');
      });
    }

    it.each([
      ['no answer came back', new ApiError('Network request failed. Please check your connection and try again.', 0, {
        url: 'https://magicbooklet.com/api/posts',
        cause: 'Network request failed',
      })],
      ['the deadline ran out after it was sent', new ApiError('Network request failed. Please check your connection and try again.', 0, {
        url: 'https://magicbooklet.com/api/posts',
        cause: 'Request timed out after 310000ms',
        timedOut: true,
      })],
      ['a server error', new ApiError('Failed to publish post.', 500, { error: 'Failed to publish post.' })],
      ['the Made with refusal', new ApiError('Choose a tool from the list or create one.', 400, {
        error: 'Choose a tool from the list or create one.',
        field: 'sourceTools',
      })],
    ])('uploads the files again from the device after %s', async (_label, error) => {
      await failFirstPublish(error);
      expect(sentStoragePaths()).toEqual(['uploads/cover.png']);

      vi.mocked(uploadPickedMedia).mockClear();
      vi.mocked(uploadPickedMedia).mockImplementation(async (_uri, options) => ({
        signedUrl: 'https://storage.example.com/signed',
        storagePath: 'uploads/cover-again.png',
        mimeType: options?.mimeType ?? 'image/png',
        fileName: options?.fileName ?? 'cover.png',
        kind: 'image',
        durationSeconds: null,
        sizeBytes: null,
      }));
      await publishAgain();

      expect(uploadPickedMedia).toHaveBeenCalledTimes(1);
      expect(uploadPickedMedia).toHaveBeenCalledWith('file:///cover.png', expect.objectContaining({
        fileName: 'cover.png',
        mimeType: 'image/png',
        kind: 'image',
      }));
      expect(sentStoragePaths()).toEqual(['uploads/cover-again.png']);
      // A new post has no rows to read back.
      expect(authState.api.getOwnerPost).not.toHaveBeenCalled();
    });

    it('sends the same uploads again after a refusal decided before they were used', async () => {
      await failFirstPublish(new ApiError('Add a title for your post.', 400, { error: 'Add a title for your post.', field: 'title' }));
      vi.mocked(uploadPickedMedia).mockClear();
      await publishAgain();

      expect(uploadPickedMedia).not.toHaveBeenCalled();
      expect(sentStoragePaths()).toEqual(['uploads/cover.png']);
    });
  });

  // An edit save that sends media deletes and re-inserts every media row of the
  // post (`replace_post_media`), so every id changes, and it can go through and
  // still fail: the Made with refusal comes after the write, a server error can,
  // and the 30 s deadline can run out while the server finishes a large video.
  // The retry sent the old ids and was refused on every press ("An existing media
  // item no longer belongs to this post."), and the draft kept on the device took
  // them into every reopening.
  describe('an edit that may have saved before it failed', () => {
    const mediaRow = (id: string, mediaKey: string, name: string) => ({
      id,
      mediaKey,
      url: `https://cdn.example.com/${name}`,
      previewUrl: null,
      originalName: name,
      contentType: 'image/png',
      mediaKind: 'image',
    });
    const gallery = {
      id: 'post-gallery',
      title: 'Neon skyline study',
      description: null,
      body: 'Frames from one evening',
      postFormat: 'mixed',
      generationId: null,
      category: 'image',
      visibility: 'public',
      sourceTool: null,
      sourceToolSlug: null,
      sourceTools: [],
      mediaUrl: 'https://cdn.example.com/first.png',
      mediaKind: 'image',
      mediaItems: [mediaRow('row-1', 'media-first', 'first.png')],
      resourceBundleInput: null,
      hasPaidOrders: false,
    };
    const saved = { success: true, postId: 'post-gallery', visibility: 'public' };
    // The post once a save of the cover and the new picture went through: every row re-inserted.
    const savedGallery = (newKey: string) => ({
      success: true,
      post: { ...gallery, mediaItems: [mediaRow('row-9', 'media-first', 'first.png'), mediaRow('row-10', newKey, 'cover.png')] },
    });
    const noAnswer = () => new ApiError('Network request failed. Please check your connection and try again.', 0, {
      url: 'https://magicbooklet.com/api/posts/post-gallery',
      cause: 'Network request failed',
    });

    const sentMedia = () => (
      authState.api.updatePost.mock.calls.at(-1)?.[1] as { mediaItems?: Array<Record<string, unknown>> } | undefined
    )?.mediaItems;
    const mediaCardLabels = (tree: renderer.ReactTestRenderer) => tree.root
      .findAll((node) => String(node.type) === 'view' && typeof node.props.accessibilityValue?.text === 'string')
      .map((node) => node.props.accessibilityLabel as string);

    /** Presses Save; the error it stopped with, or null. */
    async function save() {
      let failure: unknown = null;
      await renderer.act(async () => {
        failure = await mutationState.options?.mutationFn?.('public').then(() => null, (error: unknown) => error);
      });
      return failure;
    }

    async function waitUntil(check: () => boolean) {
      for (let attempt = 0; attempt < 20 && !check(); attempt += 1) {
        await renderer.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      expect(check()).toBe(true);
    }

    async function failFirstSave(error: unknown) {
      paramsState.params = { postId: 'post-gallery' };
      postEditState.post = gallery;
      await uploadManualMedia();
      const tree = await renderScreen();
      await choosePreparedMedia(tree);
      authState.api.updatePost.mockRejectedValueOnce(error);
      expect(await save()).toBe(error);
      const [kept, added] = sentMedia() ?? [];
      expect(kept).toEqual({ existingId: 'row-1', mediaKey: 'media-first' });
      expect(added).toMatchObject({ storagePath: 'uploads/cover.png' });
      vi.mocked(uploadPickedMedia).mockClear();
      return { tree, newKey: String(added.mediaKey) };
    }

    it.each([
      ['the Made with refusal that follows the write', new ApiError('Choose a tool from the list or create one.', 400, {
        error: 'Choose a tool from the list or create one.',
        field: 'sourceTools',
      })],
      ['a server error', new ApiError('Failed to update post.', 500, { error: 'Failed to update post.' })],
      ['the deadline running out while the server finished', new ApiError('Network request failed. Please check your connection and try again.', 0, {
        url: 'https://magicbooklet.com/api/posts/post-gallery',
        cause: 'Request timed out after 30000ms',
        timedOut: true,
      })],
    ])('saves again under the rows the post holds now after %s', async (_label, error) => {
      const { newKey } = await failFirstSave(error);
      authState.api.getOwnerPost.mockResolvedValueOnce(savedGallery(newKey));
      authState.api.updatePost.mockResolvedValueOnce(saved);

      expect(await save()).toBeNull();

      expect(authState.api.getOwnerPost).toHaveBeenCalledWith('post-gallery');
      expect(sentMedia()).toEqual([
        { existingId: 'row-9', mediaKey: 'media-first' },
        { existingId: 'row-10', mediaKey: newKey },
      ]);
      // The post already holds the new picture, so nothing goes up again.
      expect(uploadPickedMedia).not.toHaveBeenCalled();
    });

    // Past the client's deadline the server can still be finishing: a retry read
    // the rows from before that save went through, and was refused once it had.
    it('reads the rows again on the press after a retry refused for ids the post no longer has', async () => {
      const { newKey } = await failFirstSave(new ApiError('Network request failed. Please check your connection and try again.', 0, {
        url: 'https://magicbooklet.com/api/posts/post-gallery',
        cause: 'Request timed out after 30000ms',
        timedOut: true,
      }));
      // Not saved yet as far as the read can tell, so the picture goes up again from the phone.
      deviceFileState.uris.add('file:///cover.png');
      authState.api.getOwnerPost.mockResolvedValueOnce({ success: true, post: gallery });
      authState.api.updatePost.mockRejectedValueOnce(new ApiError('An existing media item no longer belongs to this post.', 400, {
        error: 'An existing media item no longer belongs to this post.',
      }));
      expect(await save()).toBeInstanceOf(ApiError);

      authState.api.getOwnerPost.mockResolvedValueOnce(savedGallery(newKey));
      authState.api.updatePost.mockResolvedValueOnce(saved);
      expect(await save()).toBeNull();

      expect(authState.api.getOwnerPost).toHaveBeenCalledTimes(2);
      expect(sentMedia()).toEqual([
        { existingId: 'row-9', mediaKey: 'media-first' },
        { existingId: 'row-10', mediaKey: newKey },
      ]);
    });

    it('reads nothing back after a refusal decided before anything was written', async () => {
      const { newKey } = await failFirstSave(new ApiError('Add a title for your post.', 400, {
        error: 'Add a title for your post.',
        field: 'title',
      }));
      authState.api.updatePost.mockResolvedValueOnce(saved);

      expect(await save()).toBeNull();

      expect(authState.api.getOwnerPost).not.toHaveBeenCalled();
      expect(sentMedia()).toEqual([
        { existingId: 'row-1', mediaKey: 'media-first' },
        expect.objectContaining({ mediaKey: newKey, storagePath: 'uploads/cover.png' }),
      ]);
    });

    it('stops the save, keeping the draft, when the post cannot be read back, and reads again on the next press', async () => {
      const { tree, newKey } = await failFirstSave(new ApiError('Failed to update post.', 500, { error: 'Failed to update post.' }));
      authState.api.getOwnerPost.mockRejectedValueOnce(noAnswer());

      const failure = await save();

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Could not check this post's media before saving. Try again.");
      // Neither the ids that may be stale nor an upload went anywhere.
      expect(authState.api.updatePost).toHaveBeenCalledTimes(1);
      expect(uploadPickedMedia).not.toHaveBeenCalled();
      renderer.act(() => mutationState.options?.onError?.(failure, 'public'));
      expect(collectText(tree.root)).toContain('Could not save');
      expect(collectText(tree.root)).toContain("Could not check this post's media before saving. Try again.");
      expect(mediaCardLabels(tree)).toEqual(['Cover', 'Media 2']);

      authState.api.getOwnerPost.mockResolvedValueOnce(savedGallery(newKey));
      authState.api.updatePost.mockResolvedValueOnce(saved);
      expect(await save()).toBeNull();

      expect(authState.api.getOwnerPost).toHaveBeenCalledTimes(2);
      expect(sentMedia()).toEqual([
        { existingId: 'row-9', mediaKey: 'media-first' },
        { existingId: 'row-10', mediaKey: newKey },
      ]);
    });

    describe('in a draft kept on the device', () => {
      // As the edit prefill loads an item the post holds.
      const loadedItem = (id: string, mediaKey: string, name: string): PostComposerMediaItem => ({
        id,
        mediaKey,
        uri: `https://cdn.example.com/${name}`,
        previewUrl: `https://cdn.example.com/${name}`,
        name,
        type: 'image/png',
        mediaKind: 'image',
        existingId: id,
      });
      // Added on this phone; its upload was forgotten after a save that may have used it.
      const addedItem = (mediaKey: string, name: string): PostComposerMediaItem => ({
        id: mediaKey,
        mediaKey,
        uri: `file:///${name}`,
        previewUrl: `file:///${name}`,
        name,
        type: 'image/png',
        mediaKind: 'image',
        storagePath: null,
      });

      function keepDraft(mediaItems: PostComposerMediaItem[]) {
        storageState.values.set('magicbooklet.post.drafts.v1', JSON.stringify({
          'user-123:edit:post-gallery': {
            draft: {
              ...getDefaultPostComposerDraft(),
              mode: 'upload',
              proofMode: 'media',
              title: 'Neon skyline study',
              caption: 'Frames from one evening',
              category: 'image',
              mediaItems,
            },
            step: 'details',
            updatedAt: new Date().toISOString(),
          },
        }));
      }

      it('names its media by the rows the post holds now', async () => {
        // Kept after a save that went through and then failed, with the ids from before it.
        keepDraft([loadedItem('row-1', 'media-first', 'first.png'), addedItem('media-added', 'added.png')]);
        paramsState.params = { postId: 'post-gallery' };
        postEditState.post = { ...gallery, mediaItems: [mediaRow('row-9', 'media-first', 'first.png'), mediaRow('row-10', 'media-added', 'added.png')] };
        authState.api.updatePost.mockResolvedValueOnce(saved);
        const tree = await renderScreen();
        await waitUntil(() => collectText(tree.root).includes('Draft restored'));

        expect(await save()).toBeNull();

        expect(sentMedia()).toEqual([
          { existingId: 'row-9', mediaKey: 'media-first' },
          { existingId: 'row-10', mediaKey: 'media-added' },
        ]);
        expect(uploadPickedMedia).not.toHaveBeenCalled();
        // The post the editor loaded is what the draft is checked against.
        expect(authState.api.getOwnerPost).not.toHaveBeenCalled();
      });

      it('drops what the post no longer holds unless it can go again from the device', async () => {
        deviceFileState.uris.add('file:///later.png');
        keepDraft([
          loadedItem('row-1', 'media-first', 'first.png'),
          // Removed from the post on the web since this draft was kept.
          loadedItem('row-2', 'media-removed', 'removed.png'),
          addedItem('media-later', 'later.png'),
        ]);
        paramsState.params = { postId: 'post-gallery' };
        postEditState.post = gallery;
        vi.mocked(uploadPickedMedia).mockImplementation(async (_uri, options) => ({
          signedUrl: 'https://storage.example.com/signed',
          storagePath: 'uploads/later-again.png',
          mimeType: options?.mimeType ?? 'image/png',
          fileName: options?.fileName ?? 'later.png',
          kind: 'image',
          durationSeconds: null,
          sizeBytes: null,
        }));
        authState.api.updatePost.mockResolvedValueOnce(saved);
        const tree = await renderScreen();
        await waitUntil(() => collectText(tree.root).includes('Some media could not be restored'));

        expect(collectText(tree.root)).toContain('removed.png could not be restored and was removed. Add it again before publishing.');
        expect(mediaCardLabels(tree)).toEqual(['Cover', 'Media 2']);
        expect(await save()).toBeNull();

        expect(uploadPickedMedia).toHaveBeenCalledTimes(1);
        expect(uploadPickedMedia).toHaveBeenCalledWith('file:///later.png', expect.objectContaining({ fileName: 'later.png' }));
        expect(sentMedia()).toEqual([
          { existingId: 'row-1', mediaKey: 'media-first' },
          expect.objectContaining({ mediaKey: 'media-later', storagePath: 'uploads/later-again.png' }),
        ]);
      });
    });
  });

  // "Made with Manual" showed under posts nobody attributed: the composer stamped
  // its own placeholder as the tool. The web sends none.
  describe('a post nobody attributed', () => {
    const sourceFields = (formData: FormData) => [formData.get('sourceTool'), formData.get('sourceToolSlug'), formData.get('sourceTools')];

    it('sends no tool for a text post', async () => {
      paramsState.params = {};
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Text post').props.onPress());
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Prompt teardown'));
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'Share a prompt, idea, breakdown, or useful note…').props.onChangeText('A useful text breakdown'));
      authState.api.createPost.mockResolvedValueOnce({ postId: 'post-text' });
      await renderer.act(async () => {
        await mutationState.options?.mutationFn?.('public');
      });

      expect(sourceFields(authState.api.createPost.mock.calls.at(-1)?.[0] as unknown as FormData)).toEqual([null, null, null]);
    });

    it('sends no tool for a media post, after a turn as a text post too', async () => {
      paramsState.params = {};
      await uploadManualMedia();
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Text post').props.onPress());
      renderer.act(() => findPressableByText(tree.root, 'Media post').props.onPress());
      await choosePreparedMedia(tree);
      renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Neon skyline study'));
      authState.api.createPost.mockResolvedValueOnce({ postId: 'post-media' });
      await renderer.act(async () => {
        await mutationState.options?.mutationFn?.('public');
      });

      expect(sourceFields(authState.api.createPost.mock.calls.at(-1)?.[0] as unknown as FormData)).toEqual([null, null, null]);
    });

    it('leaves an edited post that had no tool without one', async () => {
      paramsState.params = { postId: 'post-web-media' };
      postEditState.post = {
        id: 'post-web-media',
        title: 'Web media post',
        description: null,
        body: 'Made on the web',
        postFormat: 'mixed',
        generationId: null,
        category: 'image',
        visibility: 'public',
        sourceTool: null,
        sourceToolSlug: null,
        sourceTools: [],
        mediaUrl: 'https://cdn.example.com/web-media.png',
        mediaKind: 'image',
        mediaItems: [],
        resourceBundleInput: null,
        hasPaidOrders: false,
      };
      authState.api.updatePost.mockResolvedValueOnce({ success: true, postId: 'post-web-media', visibility: 'public' });
      const tree = await renderScreen();

      expect(collectText(tree.root)).toContain('Add tool and model');
      expect(collectText(tree.root)).not.toContain('Manual');
      await renderer.act(async () => {
        await mutationState.options?.mutationFn?.('public');
      });
      const payload = authState.api.updatePost.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(payload).toMatchObject({ title: 'Web media post', body: 'Made on the web' });
      for (const key of ['sourceTool', 'sourceToolSlug', 'sourceTools']) {
        expect(payload).not.toHaveProperty(key);
      }
    });
  });

  describe('From this creation', () => {
    const toggle = (tree: renderer.ReactTestRenderer, label: string) => tree.root.findAll((node) => (
      node.props?.label === label && typeof node.props.onValueChange === 'function'
    ))[0];

    it('offers the creation’s references on a new post', async () => {
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
      renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());

      expect(toggle(tree, 'Include creation references')).toBeTruthy();
      expect(toggle(tree, 'Include exact prompt')).toBeTruthy();
    });

    // Only the publish route copies a creation's inputs; on an edit the toggle
    // did nothing, while the package could promise references it never got.
    it('does not offer the references on an edit, and reads a prompt card made on the web as included', async () => {
      paramsState.params = { postId: 'post-from-creation' };
      postEditState.post = {
        id: 'post-from-creation',
        title: 'Hero product image',
        description: null,
        body: '',
        postFormat: 'media',
        generationId: 'gen-1',
        category: 'image',
        visibility: 'public',
        sourceTool: 'Magicbooklet',
        sourceToolSlug: 'magicbooklet',
        mediaUrl: 'https://cdn.example.com/output.png',
        mediaKind: 'image',
        mediaItems: [],
        resourceBundleInput: {
          accessMode: 'free',
          previewText: 'Includes the exact reusable prompt.',
          resources: {
            // As the web composer saves it: titled by its kind, found by its text.
            items: [{ id: 'web-prompt', type: 'prompt', title: 'Prompt or script', textContent: 'Exact glossy product prompt', sortOrder: 0 }],
          },
        },
        hasPaidOrders: false,
      };
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

      expect(toggle(tree, 'Include creation references')).toBeUndefined();
      expect(toggle(tree, 'Include exact prompt').props.value).toBe(true);
    });

    it('switches Include exact prompt off when its card is removed, and back on with Undo', async () => {
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());
      renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
      renderer.act(() => toggle(tree, 'Include exact prompt').props.onValueChange(true));
      expect(toggle(tree, 'Include exact prompt').props.value).toBe(true);

      // The last card going switches the recipe off; choosing it again shows the toggle as the cards leave it.
      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Remove Exact generation prompt').props.onPress());
      renderer.act(() => findPressableByText(tree.root, 'Free recipe').props.onPress());
      expect(toggle(tree, 'Include exact prompt').props.value).toBe(false);

      renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Undo removing Exact generation prompt').props.onPress());
      expect(toggle(tree, 'Include exact prompt').props.value).toBe(true);
    });
  });

  // Share on something not yet public opens its editor; saved still private,
  // the share was dropped without a word.
  describe('opened from Share on a private post', () => {
    const privatePost = {
      id: 'post-private-share',
      title: 'Private post',
      description: null,
      body: '',
      postFormat: 'media',
      generationId: null,
      category: 'image',
      visibility: 'private',
      sourceTool: null,
      sourceToolSlug: null,
      mediaUrl: 'https://cdn.example.com/private.png',
      mediaKind: 'image',
      mediaItems: [],
      resourceBundleInput: null,
      hasPaidOrders: false,
    };

    it('starts on Public', async () => {
      paramsState.params = { postId: 'post-private-share', shareAfterPublish: '1' };
      postEditState.post = privatePost;
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

      expect(findPressableByAccessibilityLabel(tree.root, 'Visibility: Public')).toBeTruthy();
    });

    it('keeps Private when the editor was opened to edit', async () => {
      paramsState.params = { postId: 'post-private-share' };
      postEditState.post = privatePost;
      const tree = await renderScreen();
      renderer.act(() => findPressableByText(tree.root, 'Next').props.onPress());

      expect(findPressableByAccessibilityLabel(tree.root, 'Visibility: Private')).toBeTruthy();
    });
  });

  // A guest can generate and press Post to feed. Sent to sign-in with no way
  // back, they finished on Home, without the creation they were posting.
  describe('signed out', () => {
    const signedInUser = authState.user;
    const auth = authState as { user: typeof signedInUser | null };

    afterEach(() => {
      auth.user = signedInUser;
    });

    const redirects = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'redirect');

    it('sends sign-in back to the composer, on the same creation and intent', async () => {
      auth.user = null;
      paramsState.params = { generationId: 'gen-1', shareAfterPublish: '1' };
      const tree = await renderScreen();

      expect(redirects(tree)).toHaveLength(1);
      expect(redirects(tree)[0].props.href).toEqual({
        pathname: '/auth',
        params: { returnTo: '/post/new?generationId=gen-1&shareAfterPublish=1' },
      });
    });

    it('keeps an edit and the step it was opened on', async () => {
      auth.user = null;
      paramsState.params = { postId: 'post-9', focus: 'resources' };
      const tree = await renderScreen();

      expect(redirects(tree)[0].props.href).toEqual({
        pathname: '/auth',
        params: { returnTo: '/post/new?postId=post-9&focus=resources' },
      });
    });

    it('does not redirect a signed-in creator', async () => {
      const tree = await renderScreen();
      expect(redirects(tree)).toHaveLength(0);
    });
  });

  // The server publishes any succeeded run with output. A creation whose poster
  // job failed plays fine, and used to end here on "Could not load this creation".
  describe('a creation whose preview failed', () => {
    const posterFailedVideo = {
      ...generationItem,
      category: 'video',
      output_url: 'https://cdn.example.com/output.mp4',
      preview_url: null,
      previewUrl: null,
      media: { gridReady: false, status: 'failed' },
    };

    it('opens on its details, drawing a plate rather than the clip', async () => {
      generationState.item = posterFailedVideo;
      const tree = await renderScreen();
      const text = collectText(tree.root);

      expect(text).not.toContain('Could not load this creation');
      expect(text).toContain('Hero product image');
      expect(text).toContain('Creation ready');
    });

    it('never hands the clip to a picture on the review step', async () => {
      generationState.item = posterFailedVideo;
      paramsState.params = { generationId: 'gen-1', focus: 'resources' };
      const tree = await renderScreen();

      expect(collectText(tree.root)).toContain('Step 2 of 2 · recipe optional');
      const pictureUrls = tree.root
        .findAll((node) => String(node.type) === 'stable-media-image')
        .map((node) => node.props.url);
      expect(pictureUrls).not.toContain('https://cdn.example.com/output.mp4');
    });

    it('still draws a picture creation from its output when it has no preview', async () => {
      generationState.item = { ...generationItem, preview_url: null, previewUrl: null, media: { gridReady: false, status: 'failed' } };
      paramsState.params = { generationId: 'gen-1', focus: 'resources' };
      const tree = await renderScreen();

      const pictureUrls = tree.root
        .findAll((node) => String(node.type) === 'stable-media-image')
        .map((node) => node.props.url);
      expect(pictureUrls).toContain('https://cdn.example.com/output.png');
    });
  });
});
