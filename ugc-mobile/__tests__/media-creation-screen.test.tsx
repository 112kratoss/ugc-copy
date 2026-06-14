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
  ChevronDown: (props: MockProps) => React.createElement('chevron-down-icon', props),
  ChevronRight: (props: MockProps) => React.createElement('chevron-right-icon', props),
  Image: (props: MockProps) => React.createElement('image-icon', props),
  Layers: (props: MockProps) => React.createElement('layers-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
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
  });

  it('renders the default image flow in prompt-first progressive order', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Prompt')).toBeLessThan(text.indexOf('Essentials'));
    expect(text.indexOf('Essentials')).toBeLessThan(text.indexOf('References'));
    expect(text.indexOf('References')).toBeLessThan(text.indexOf('Advanced'));
    expect(text.indexOf('Advanced')).toBeLessThan(text.indexOf('Generate'));
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

  it('shows motion media readiness before generation is possible', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Motion media needed');
    expect(text).toContain('Add a character image and reference motion video.');
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
