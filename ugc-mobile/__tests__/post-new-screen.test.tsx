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

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
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
const queryClientState = vi.hoisted(() => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }));
const queryOptionsState = vi.hoisted(() => ({ options: [] as Array<{ queryKey: string[]; enabled?: boolean }> }));

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
  useQuery: (options: { queryKey: string[]; enabled?: boolean }) => {
    queryOptionsState.options.push(options);
    if (options.queryKey[0] === 'post-new-generations') {
      return { data: { generations: [generationItem] }, error: null, isLoading: false, isSuccess: true };
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
  findNodeHandle: vi.fn(() => 1),
  Keyboard: { dismiss: vi.fn() },
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

import NewPostScreen from '../app/post/new';
import { pickMediaList, pickResourceDocument, uploadPickedMedia, uploadResourceDocument } from '@/lib/media';
import { buildPostResourceBundleInput, type PostComposerDraft } from '../lib/post-new-view-model';

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
    expect(text).toContain('Review & publish');
    expect(text).not.toContain('Optional resources');
    expect(text).not.toContain('Publish');
  });

  it('moves to the optional resource step without losing generation details', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Review & publish');
    expect(text).toContain('Step 2 of 2 · resources optional');
    expect(text).toContain('Ready to publish');
    expect(text).toContain('Share free');
    expect(text).toContain('Sell resources');
    expect(text).toContain('Post without resources');
    expect(text).toContain('Publish public');
    expect(text).not.toContain('What is this creation about?');
  });

  it('uses header back to return to details and preserve state', async () => {
    const tree = await renderScreen();
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'Share the idea, process, or story behind it…').props.onChangeText('A concise story'));
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Back to post details').props.onPress());
    expect(findTextInputByPlaceholder(tree.root, 'Share the idea, process, or story behind it…').props.value).toBe('A concise story');
  });

  it('opens directly on resources when focus=resources is requested', async () => {
    paramsState.params = { generationId: 'gen-1', focus: 'resources' };
    const tree = await renderScreen();
    expect(collectText(tree.root)).toContain('Step 2 of 2 · resources optional');
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    expect(collectText(tree.root)).toContain('Add a title for your post.');
    expect(collectText(tree.root)).not.toContain('Optional resources');

    renderer.act(() => findTextInputByPlaceholder(tree.root, 'What is this creation about?').props.onChangeText('Neon skyline study'));
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    expect(collectText(tree.root)).toContain('Optional resources');
  });

  it('shows all required field errors inline in visual order', async () => {
    paramsState.params = {};
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Step 2 of 2 · resources optional');
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'External link').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'https://').props.onChangeText('example.com/resource'));

    expect(collectText(tree.root)).toContain('Add a valid http:// or https:// link.');
    expect(findPressableByAccessibilityLabel(tree.root, 'Save resource').props.disabled).toBe(true);
  });

  it('shows buyer-preview quality guidance next to the package preview', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    renderer.act(() => findTextInputByPlaceholder(tree.root, 'This content is revealed only after unlock').props.onChangeText('Unsaved prompt'));

    // The resource editor has to give way to the keyboard on both platforms.
    // It used to rely on KeyboardAvoidingView, which was configured for iOS
    // only and so did nothing on Android once edge-to-edge stopped the window
    // resizing; KeyboardAvoidingArea shrinks the surface on either platform.
    const keyboardContainer = tree.root.findAll((node) => node.props?.testID === 'keyboard-avoiding-area')[0];
    expect(keyboardContainer).toBeTruthy();
    const keyboardScroll = tree.root.findAll((node) => String(node.type) === 'scrollview' && node.props.automaticallyAdjustKeyboardInsets)[0];
    expect(keyboardScroll).toBeTruthy();

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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
    expect(findTextInputByAccessibilityLabel(tree.root, 'Public package summary, optional')).toBeTruthy();
    expect(findTextInputByAccessibilityLabel(tree.root, 'Package preview, required')).toBeTruthy();
  });

  it('supports a paid token price and shows estimated creator earnings', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Sell resources').props.onPress());
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Share free').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Add resource').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Prompt or script').props.onPress());
    expect(collectText(tree.root)).toContain('Applies to');
    expect(collectText(tree.root)).toContain('All outputs');
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Apply to output 2').props.onPress());
    expect(findPressableByAccessibilityLabel(tree.root, 'Apply to output 2').props.accessibilityState.selected).toBe(true);
  });

  it('publishes without forcing a resource package', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Publish public').props.onPress());
    expect(mutationState.mutate).toHaveBeenCalledWith('public');
  });

  it('changes visibility from a compact sheet', async () => {
    const tree = await renderScreen();
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    renderer.act(() => findPressableByAccessibilityLabel(tree.root, 'Visibility: Public').props.onPress());
    renderer.act(() => findPressableByText(tree.root, 'Private').props.onPress());
    expect(findPressableByAccessibilityLabel(tree.root, 'Visibility: Private')).toBeTruthy();
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
    renderer.act(() => findPressableByText(tree.root, 'Review & publish').props.onPress());
    const text = collectText(tree.root);
    expect(text).toContain('Purchased resources are protected');
    expect(text).toContain('Existing package preserved');
    expect(text).not.toContain('Post without resources');
  });

  it('routes a successful post back to the profile Posts tab', async () => {
    paramsState.params = {};
    await renderScreen();
    renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-123' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routerState.replace).toHaveBeenCalledWith({ pathname: '/(tabs)/profile', params: { tab: 'posts', postId: 'post-123' } });
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
        params: { tab: 'posts', postId: 'post-123' },
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
        params: { tab: 'posts', postId: 'post-126' },
      });
    });

    it('does not share when the composer was not opened with a share intent', async () => {
      paramsState.params = {};
      await renderScreen();
      renderer.act(() => mutationState.options?.onSuccess?.({ postId: 'post-127', visibility: 'public' } as { postId?: string | null }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(shareState.share).not.toHaveBeenCalled();
    });
  });
});
