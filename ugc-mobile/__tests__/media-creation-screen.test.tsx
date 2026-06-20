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
}));

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'creator@example.com' },
  credits: 999,
  updateCredits: vi.fn(),
  api: {
    enhancePrompt: vi.fn(),
    startImageGeneration: vi.fn(),
    startVideoGeneration: vi.fn(),
    startMotionGeneration: vi.fn(),
    getImageGeneration: vi.fn(),
    getVideoGeneration: vi.fn(),
    getMotionGeneration: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({
  router: routerState,
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
  NotificationFeedbackType: {
    Success: 'success',
    Error: 'error',
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
  Modal: ({ children, visible, ...props }: MockProps) =>
    visible ? React.createElement('modal', props, children) : null,
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Switch: (props: MockProps) => React.createElement('switch', props),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('lucide-react-native', () => ({
  AudioLines: (props: MockProps) => React.createElement('audio-lines-icon', props),
  Check: (props: MockProps) => React.createElement('check-icon', props),
  ChevronDown: (props: MockProps) => React.createElement('chevron-down-icon', props),
  ChevronRight: (props: MockProps) => React.createElement('chevron-right-icon', props),
  Image: (props: MockProps) => React.createElement('image-icon', props),
  Layers: (props: MockProps) => React.createElement('layers-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  Search: (props: MockProps) => React.createElement('search-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
  Trash2: (props: MockProps) => React.createElement('trash-icon', props),
  Video: (props: MockProps) => React.createElement('video-icon', props),
  Wand2: (props: MockProps) => React.createElement('wand-icon', props),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: (props: MockProps) => React.createElement('media-preview', props),
}));

vi.mock('@/lib/media', () => ({
  pickAudioDocument: vi.fn(),
  pickMedia: vi.fn(),
  pickMediaList: vi.fn(),
  uploadPickedMedia: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

import { MediaCreationScreen } from '../components/media-creation-screen';
import { pickMedia, pickMediaList, uploadPickedMedia } from '../lib/media';

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

describe('MediaCreationScreen Phase 3 create workspace', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    authState.updateCredits.mockClear();
    authState.credits = 999;
    authState.api.startImageGeneration.mockReset();
    authState.api.getImageGeneration.mockReset();
    authState.api.startVideoGeneration.mockReset();
    authState.api.getVideoGeneration.mockReset();
    authState.api.startMotionGeneration.mockReset();
    authState.api.getMotionGeneration.mockReset();
    vi.mocked(pickMedia).mockReset();
    vi.mocked(pickMediaList).mockReset();
    vi.mocked(uploadPickedMedia).mockReset();
  });

  it('renders the default image flow in prompt-first progressive order', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Prompt')).toBeLessThan(text.indexOf('References'));
    expect(text.indexOf('References')).toBeLessThan(text.indexOf('Settings'));
    expect(text.indexOf('Settings')).toBeLessThan(text.indexOf('Advanced'));
    expect(text.indexOf('References')).toBeLessThan(text.indexOf('Advanced'));
    expect(text.indexOf('Advanced')).toBeLessThan(text.indexOf('Generate'));
    expect(text).not.toContain('Essentials');
  });

  it('uses clearer reference upload copy without truncating the count', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Reference images');
    expect(text).toContain('0 / 14');
    expect(text).toContain('Optional: style, pose, product, or face guide.');
    expect(text).toContain('Add reference');
    expect(text).not.toContain('Reference images (0/1');
  });

  it('opens a searchable model dropdown and selects a filtered model', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    expect(collectText(tree!.root)).not.toContain('Search models');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Change').props.onPress();
    });

    let text = collectText(tree!.root);
    expect(text).toContain('Grok Imagine');
    expect(text).toContain('GPT Image 2');
    expect(text).not.toContain('Versatile image generation with Google Search grounding.');
    expect(text).not.toContain('ChatGPT image generation with fast high-quality edits.');

    const searchInput = tree!.root.findByProps({ accessibilityLabel: 'Search model names' });
    renderer.act(() => {
      searchInput.props.onChangeText('grok');
    });

    text = collectText(tree!.root);
    expect(text).toContain('Grok Imagine');
    expect(text).not.toContain('GPT Image 2');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Grok Imagine').props.onPress();
    });

    text = collectText(tree!.root);
    expect(text).toContain('Grok Imagine');
    expect(text).toContain('Grok Imagine · 3:2 · 1K');
  });

  it('keeps credits and cost near the generate action instead of the header', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Prompt')).toBeLessThan(text.indexOf('Credits'));
    expect(text.indexOf('Generate')).toBeLessThan(text.indexOf('Credits'));
    expect(text.indexOf('Generate')).toBeLessThan(text.indexOf('Cost'));
  });

  it('renders motion required media before the optional prompt', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Settings')).toBeLessThan(text.indexOf('References'));
    expect(text.indexOf('References')).toBeLessThan(text.indexOf('Prompt'));
    expect(text).toContain('Optional for motion');
  });

  it('reserves viewport space for the floating tab bar when rendered inside the create tab', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });

    const scrollView = tree!.root.find((node) => String(node.type) === 'scrollview');
    expect(scrollView.props.style).toEqual(expect.objectContaining({
      marginBottom: expect.any(Number),
    }));
    expect(scrollView.props.style.marginBottom).toBeGreaterThan(120);
    expect(scrollView.props.contentContainerStyle.paddingBottom).toBeGreaterThan(100);
    expect(collectText(tree!.root)).not.toContain('Review and generate');

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a glossy product hero shot.');
    });

    expect(collectText(tree!.root)).toContain('Review and generate');

    renderer.act(() => {
      promptInput.props.onFocus();
    });
    expect(collectText(tree!.root)).not.toContain('Review and generate');

    renderer.act(() => {
      promptInput.props.onBlur();
    });
    expect(collectText(tree!.root)).toContain('Review and generate');
  });

  it('shows empty prompt enhancement feedback inside the prompt panel', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    renderer.act(() => {
      findPressableByText(tree!.root, 'Enhance').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Add a prompt before enhancing.')).toBeGreaterThan(text.indexOf('Prompt'));
    expect(text.indexOf('Add a prompt before enhancing.')).toBeLessThan(text.indexOf('Settings'));
  });

  it('shows an image preview after adding image references', async () => {
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///hero.png', fileName: 'hero.png', mimeType: 'image/png', fileSize: 2048 } as never,
    ]);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/hero.png',
      storagePath: 'uploads/user/hero.png',
      mimeType: 'image/png',
      fileName: 'hero.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add reference').props.onPress();
    });

    const previews = tree!.root.findAll((node) => String(node.type) === 'media-preview');
    expect(previews).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        kind: 'image',
        url: 'https://cdn.example.com/hero.png',
      }),
    }));
  });

  it('shows a video preview after adding motion reference video', async () => {
    vi.mocked(pickMedia).mockResolvedValue({
      uri: 'file:///motion.mp4',
      fileName: 'motion.mp4',
      mimeType: 'video/mp4',
      fileSize: 4096,
      duration: 7200,
    } as never);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/motion.mp4',
      storagePath: 'uploads/user/motion.mp4',
      mimeType: 'video/mp4',
      fileName: 'motion.mp4',
      kind: 'video',
      durationSeconds: 7.2,
      sizeBytes: 4096,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add video').props.onPress();
    });

    const previews = tree!.root.findAll((node) => String(node.type) === 'media-preview');
    expect(previews).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        kind: 'video',
        url: 'https://cdn.example.com/motion.mp4',
      }),
    }));
  });

  it('opens a larger reference preview when tapping the media thumbnail', async () => {
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///hero.png', fileName: 'hero.png', mimeType: 'image/png', fileSize: 2048 } as never,
    ]);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/hero.png',
      storagePath: 'uploads/user/hero.png',
      mimeType: 'image/png',
      fileName: 'hero.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add reference').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Preview hero' }).props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Reference preview');
    expect(tree!.root.findAll((node) => String(node.type) === 'media-preview')).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        url: 'https://cdn.example.com/hero.png',
        height: 360,
      }),
    }));
  });

  it('lets creators rename image references and updates the prompt handle', async () => {
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///hero.png', fileName: 'hero.png', mimeType: 'image/png', fileSize: 2048 } as never,
    ]);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/hero.png',
      storagePath: 'uploads/user/hero.png',
      mimeType: 'image/png',
      fileName: 'hero.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Add reference').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Reference name for hero' }).props.onChangeText('Logo Sheet');
    });

    const nameInput = tree!.root.findByProps({ accessibilityLabel: 'Reference name for Logo Sheet' });
    expect(nameInput.props.value).toBe('Logo Sheet');
    expect(collectText(tree!.root)).toContain('@logo_sheet');
  });

  it('keeps advanced settings collapsed by default', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Advanced');
    expect(text).not.toContain('Output format');
    expect(text).not.toContain('Google Search');
  });

  it('keeps generate blockers inline without a nested generation checks card', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a hero image with @missing_reference.');
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Review issues');
    expect(text).toContain('Unknown element mention: @missing_reference');
    expect(text).not.toContain('Generation checks');
  });

  it('shows motion media readiness before generation is possible', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Motion media needed');
    expect(text).toContain('Add a character image and reference motion video.');
    expect(text).not.toContain('Generation checks');
  });

  it('offers a post handoff after a generation succeeds with a generation id', async () => {
    authState.api.startImageGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-1',
      generationId: 'gen-1',
      status: 'processing',
      remainingCredits: 980,
    });
    authState.api.getImageGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/output.png',
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a glossy product hero shot.');
    });

    await renderer.act(async () => {
      findPressableByText(tree!.root, 'Generate Image').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Post this');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Post this').props.onPress();
    });
    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/post/new',
      params: { generationId: 'gen-1' },
    });
  });
});
