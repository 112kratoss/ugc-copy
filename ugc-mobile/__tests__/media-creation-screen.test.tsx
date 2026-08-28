// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Nullable: guests hold a backend identity but no registered account, and the
  // guest generation case below asserts that distinction.
  user: null as { id: string; email: string } | null,
  // Generating keys off the backend identity, not registration, so guests can
  // spend the credits they bought. For a registered user the two are the same.
  identityUserId: 'user-123' as string | null,
  isGuest: false,
  credits: 999,
  updateCredits: vi.fn(),
  api: {
    enhancePrompt: vi.fn(),
    startGeneration: undefined as ReturnType<typeof vi.fn> | undefined,
    startImageGeneration: vi.fn(),
    startVideoGeneration: vi.fn(),
    startMotionGeneration: vi.fn(),
    getImageGeneration: vi.fn(),
    getVideoGeneration: vi.fn(),
    getMotionGeneration: vi.fn(),
    quoteGenerationModel: vi.fn(),
    getRemixSourceBundle: vi.fn(),
  },
}));

const catalogState = vi.hoisted(() => ({
  catalog: null as unknown,
  isLoading: false,
  isUnavailable: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

const nativeAlertState = vi.hoisted(() => ({
  alert: vi.fn(),
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
  Alert: nativeAlertState,
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
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
  PanResponder: {
    create: vi.fn(() => ({ panHandlers: {} })),
  },
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
  ArrowLeft: (props: MockProps) => React.createElement('glyph-icon', props),
  ChevronLeft: (props: MockProps) => React.createElement('glyph-icon', props),
  Share: (props: MockProps) => React.createElement('glyph-icon', props),
  Share2: (props: MockProps) => React.createElement('glyph-icon', props),
  AudioLines: (props: MockProps) => React.createElement('audio-lines-icon', props),
  Check: (props: MockProps) => React.createElement('check-icon', props),
  ChevronDown: (props: MockProps) => React.createElement('chevron-down-icon', props),
  ChevronRight: (props: MockProps) => React.createElement('chevron-right-icon', props),
  GripHorizontal: (props: MockProps) => React.createElement('grip-horizontal-icon', props),
  Image: (props: MockProps) => React.createElement('image-icon', props),
  Layers: (props: MockProps) => React.createElement('layers-icon', props),
  Plus: (props: MockProps) => React.createElement('plus-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  RefreshCw: (props: MockProps) => React.createElement('refresh-icon', props),
  Search: (props: MockProps) => React.createElement('search-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
  Settings2: (props: MockProps) => React.createElement('settings-icon', props),
  Trash2: (props: MockProps) => React.createElement('trash-icon', props),
  Video: (props: MockProps) => React.createElement('video-icon', props),
  Wand2: (props: MockProps) => React.createElement('wand-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: (props: MockProps) => React.createElement('media-preview', props),
  StableMediaImage: (props: MockProps) => React.createElement('stable-media-image', props),
}));

// The real @/lib/media imports the expo pickers, whose native core does not
// resolve under vitest — stub them so importOriginal below can load the module.
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: vi.fn() }));

vi.mock('@/lib/media', async (importOriginal) => ({
  // Pure helpers (assetDurationSeconds, duration-limit predicates) stay real;
  // only the picker/upload side effects are stubbed.
  ...(await importOriginal<typeof import('../lib/media')>()),
  pickAudioDocument: vi.fn(),
  pickMedia: vi.fn(),
  pickMediaList: vi.fn(),
  uploadPickedMedia: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/use-generation-model-catalog', () => ({
  useGenerationModelCatalog: () => catalogState,
}));

import { MediaCreationScreen } from '../components/media-creation-screen';
import { pickMedia, pickMediaList, uploadPickedMedia } from '../lib/media';
import { createTestGenerationModelCatalog, remoteImageModel } from './fixtures/generation-model-catalog';
import { catalogV2 } from './generation-model-catalog-v2-fixtures';

const mountedTrees: renderer.ReactTestRenderer[] = [];
const createRenderer = renderer.create.bind(renderer);

vi.spyOn(renderer, 'create').mockImplementation((...args: Parameters<typeof renderer.create>) => {
  const tree = createRenderer(...args);
  mountedTrees.push(tree);
  return tree;
});

function collectText(root: renderer.ReactTestInstance) {
  const textFromChildren = (children: unknown): string | null => {
    if (typeof children === 'string' || typeof children === 'number') return String(children);
    if (Array.isArray(children)) {
      const text = children
        .map((child) => textFromChildren(child))
        .filter((child): child is string => Boolean(child))
        .join('');
      return text || null;
    }
    return null;
  };

  return root
    .findAll((node) => String(node.type) === 'text')
    .map((node) => textFromChildren(node.props.children))
    .filter((text): text is string => Boolean(text));
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

function findPressableByLabelPrefix(root: renderer.ReactTestInstance, prefix: string) {
  return root.find((node) => (
    String(node.type) === 'pressable'
    && typeof node.props.accessibilityLabel === 'string'
    && node.props.accessibilityLabel.startsWith(prefix)
  ));
}

describe('MediaCreationScreen Phase 3 create workspace', () => {
  afterEach(() => {
    renderer.act(() => {
      for (const tree of mountedTrees.splice(0)) tree.unmount();
    });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  beforeEach(() => {
    routerState.push.mockClear();
    authState.updateCredits.mockClear();
    authState.credits = 999;
    authState.user = { id: 'user-123', email: 'creator@example.com' };
    authState.identityUserId = 'user-123';
    authState.isGuest = false;
    authState.api.startGeneration = undefined;
    authState.api.startImageGeneration.mockReset();
    authState.api.getImageGeneration.mockReset();
    authState.api.startVideoGeneration.mockReset();
    authState.api.getVideoGeneration.mockReset();
    authState.api.startMotionGeneration.mockReset();
    authState.api.getMotionGeneration.mockReset();
    authState.api.quoteGenerationModel.mockReset();
    authState.api.getRemixSourceBundle.mockReset();
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'nano-banana-2',
      catalogRevision: 'test-catalog-rev',
      normalizedSettings: { aspectRatio: '4:5', resolution: '1K' },
      costCredits: 8,
    });
    catalogState.catalog = createTestGenerationModelCatalog();
    catalogState.isLoading = false;
    catalogState.isUnavailable = false;
    catalogState.error = null;
    catalogState.refetch.mockReset();
    nativeAlertState.alert.mockReset();
    vi.mocked(pickMedia).mockReset();
    vi.mocked(pickMediaList).mockReset();
    vi.mocked(uploadPickedMedia).mockReset();
  });

  it('routes to consumer templates from the prompt toolbar without authoring controls', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });

    expect(collectText(tree!.root)).toContain('Templates');
    expect(collectText(tree!.root)).not.toContain('Create template');
    expect(collectText(tree!.root)).not.toContain('Publish template');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Templates').props.onPress();
    });
    expect(routerState.push).toHaveBeenCalledWith('/templates');
  });

  it('renders a schema-v1 model supplied only by the remote catalog', () => {
    catalogState.catalog = createTestGenerationModelCatalog([remoteImageModel]);
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Selected model').props.onPress();
    });

    expect(collectText(tree!.root)).toContain('Remote Image V1');
  });

  it('selects a remote-only model and applies its controls and reference limit', () => {
    catalogState.catalog = createTestGenerationModelCatalog([remoteImageModel]);
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Selected model').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Remote Image V1').props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text.some((item) => item.includes('2K · 2:3'))).toBe(true);
    expect(text).toContain('0 / 3');
    expect(text).toContain('Remote Image V1');
  });

  it('survives a catalog refresh that retires a selected remote-only model', () => {
    catalogState.catalog = createTestGenerationModelCatalog([remoteImageModel]);
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Selected model').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Remote Image V1').props.onPress();
    });

    catalogState.catalog = createTestGenerationModelCatalog();
    expect(() => {
      renderer.act(() => {
        tree!.update(<MediaCreationScreen initialTool="image" />);
      });
    }).not.toThrow();

    expect(collectText(tree!.root)).toContain('Nano Banana 2.0');
    expect(collectText(tree!.root)).toContain('Model updated');
  });

  it('waits for a debounced server quote before enabling generation', async () => {
    vi.useFakeTimers();
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('Quote this image');
    });

    expect(findPressableByText(tree!.root, 'Calculating…').props.disabled).toBe(true);
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(authState.api.quoteGenerationModel).toHaveBeenCalledTimes(1);
    expect(findPressableByText(tree!.root, 'Generate · 8 credits').props.disabled).toBe(false);
    vi.useRealTimers();
  });

  it('switches a retired draft model to the catalog default with a notice', async () => {
    const catalog = createTestGenerationModelCatalog();
    catalog.models = catalog.models.filter((model) => model.id !== 'nano-banana-2');
    catalog.defaults.image = 'nano-banana-pro';
    catalogState.catalog = catalog;
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Model updated');
    expect(text).toContain('Your previous image model is no longer available. Switched to Nano Banana Pro.');
    expect(text).toContain('Nano Banana Pro');
  });

  it('uses the catalog default for a fresh draft even when the bundled model is still active', async () => {
    const catalog = createTestGenerationModelCatalog();
    catalog.defaults.motion = 'kling-2.6';
    catalogState.catalog = catalog;
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Kling 2.6');
    expect(text).toContain('720P · Add motion');
    expect(text).not.toContain('Model updated');
  });

  it('renders the compact image composer with model selection outside parameters', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Nano Banana 2.0')).toBeLessThan(text.indexOf('Prompt'));
    expect(text.indexOf('Prompt')).toBeLessThan(text.indexOf('Reference images'));
    expect(text).not.toContain('Generation parameters');
    expect(text).not.toContain('Ready check');
    expect(text).not.toContain('Credits');
    expect(text).not.toContain('Cost');
    expect(text).not.toContain('What should we create?');

    const toolTabs = tree!.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        ['Image', 'Video', 'Motion'].includes(node.props.accessibilityLabel) &&
        node.props.style?.minHeight === 48,
    );
    expect(toolTabs).toHaveLength(3);
    expect(toolTabs.find((node) => node.props.accessibilityLabel === 'Image')?.props.accessibilityState).toEqual({ selected: true });
    expect(toolTabs.every((node) => node.props.style.minHeight === 48)).toBe(true);
    const promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    expect(promptInput.props.scrollEnabled).toBe(true);
    expect(promptInput.props.style).toEqual(expect.objectContaining({ height: 190, overflow: 'hidden', fontSize: 14, lineHeight: 20, paddingTop: 12, paddingBottom: 28 }));
    expect(tree!.root.findByProps({ testID: 'prompt-heading-inset' }).props.style).toEqual(expect.objectContaining({ paddingBottom: 8, zIndex: 1 }));
    expect(tree!.root.findByProps({ testID: 'prompt-scroll-viewport' }).props.style).toEqual({ height: 190, overflow: 'hidden' });
    expect(tree!.root.findByProps({ testID: 'prompt-bottom-inset' }).props.style).toEqual(expect.objectContaining({ bottom: 0, height: 16 }));
  });

  it.each([
    ['video', 'Kling 3.0 Cinematic'],
    ['motion', 'Kling 3.0'],
  ] as const)('uses the compact shared shell for %s creation', (tool, modelName) => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool={tool} />);
    });

    let text = collectText(tree!.root);
    expect(text).toContain(modelName);
    expect(text).not.toContain('Ready check');
    expect(text).not.toContain('Review cost and blockers before starting the run.');
    expect(tree!.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'creator-persistent-bar')).toHaveLength(1);

    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, `Selected model ${modelName}`).props.onPress();
    });
    expect(collectText(tree!.root)).toContain('Choose model');
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Close model picker' }).props.onPress();
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });
    text = collectText(tree!.root);
    expect(text).toContain('Generation parameters');
    expect(text).not.toContain('Choose model');
  });

  it.each(['image', 'video', 'motion'] as const)(
    'uses only the manual safe-area inset for the %s creator scroll view',
    (tool) => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool={tool} insideTab />);
      });

      const creatorScrollView = tree!.root.findAll(
        (node) => String(node.type) === 'scrollview' && node.props.style?.flex === 1,
      )[0];

      expect(creatorScrollView.props.contentInsetAdjustmentBehavior).toBe('never');
      expect(creatorScrollView.props.contentContainerStyle).toEqual(
        expect.objectContaining({ paddingTop: 34 }),
      );
    },
  );

  it('shows frame inputs in the video composer and keeps the model out of parameters', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });

    expect(tree!.root.findByProps({ testID: 'video-start-frame-slot' })).toBeTruthy();
    expect(tree!.root.findByProps({ testID: 'video-end-frame-slot' })).toBeTruthy();
    expect(tree!.root.findAllByProps({ testID: 'video-reference-mode' })).toHaveLength(0);
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });
    expect(collectText(tree!.root)).not.toContain('Choose model');
  });

  it('keeps motion duration source-derived and read-only in parameters', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });

    expect(collectText(tree!.root)).toContain('Source duration');
    expect(collectText(tree!.root)).toContain('Add motion video');
    expect(tree!.root.findAllByProps({ testID: 'parameter-stepper-duration' })).toHaveLength(0);
  });

  it('retries an unavailable local quote without remounting the creator', async () => {
    vi.useFakeTimers();
    authState.api.quoteGenerationModel
      .mockRejectedValueOnce(new Error('Could not reach local API at http://127.0.0.1:3000.'))
      .mockResolvedValueOnce({
        modelId: 'nano-banana-2',
        catalogRevision: 'test-catalog-rev',
        normalizedSettings: { aspectRatio: '4:5', resolution: '1K' },
        costCredits: 8,
      });
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(collectText(tree!.root)).toContain('Could not reach local API at http://127.0.0.1:3000.');
    renderer.act(() => {
      findPressableByText(tree!.root, 'Retry quote').props.onPress();
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(authState.api.quoteGenerationModel).toHaveBeenCalledTimes(2);
    expect(collectText(tree!.root)).toContain('Generate · 8 credits');
    vi.useRealTimers();
  });

  it('offers a visible exit and anchors the persistent controls to the safe area in the focused tab workspace', () => {
    const onClose = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab onClose={onClose} />);
    });

    const close = tree!.root.findByProps({ accessibilityLabel: 'Close creator' });
    expect(close.props.accessibilityHint).toContain('Your draft is saved');
    renderer.act(() => close.props.onPress());
    expect(onClose).toHaveBeenCalledTimes(1);

    const persistentBar = tree!.root.find((node) => (
      String(node.type) === 'view'
      && node.props.style?.position === 'absolute'
      && node.props.style?.left === 14
      && node.props.style?.right === 14
      && node.props.style?.zIndex === 8
    ));
    expect(persistentBar.props.style.bottom).toBe(32);
  });

  it('shows the reference rail count and toolbar action', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Reference images');
    expect(text).toContain('0 / 14');
    expect(text).toContain('Reference');
    expect(text.indexOf('Reference')).toBeLessThan(text.indexOf('Reference images'));
    const actionGrid = tree!.root.findByProps({ testID: 'composer-action-grid' });
    expect(actionGrid.props.style).toEqual(expect.objectContaining({ flexDirection: 'row', gap: 8 }));
    const actionColumns = actionGrid.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        ['Reference', 'Templates', 'Enhance'].includes(node.props.accessibilityLabel) &&
        node.props.style?.minHeight === 60,
    );
    expect(actionColumns).toHaveLength(3);
    const referenceRail = tree!.root.findByProps({ testID: 'image-reference-rail' });
    expect(referenceRail.props.style).not.toEqual(expect.objectContaining({ borderTopWidth: expect.any(Number) }));
  });

  it('hydrates remix prompt and references from the remix-source bundle', async () => {
    authState.api.getRemixSourceBundle.mockResolvedValue({
      generation: {
        id: 'gen-1',
        title: 'Original source',
        prompt: 'Restore this exact remix prompt.',
        category: 'image',
        model: 'nano-banana-2',
      },
      result: null,
      inputs: {
        image: {
          elements: [
            {
              id: 'element-1',
              displayName: 'Hero Product',
              handle: '@hero_product',
              url: 'https://cdn.example.com/hero.png',
              storagePath: 'inputs/hero.png',
              sourceGenerationId: 'gen-1',
            },
          ],
        },
      },
      workflowSettings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        resolution: '2K',
      },
      restoreIssues: [],
    });
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <MediaCreationScreen
          initialTool="image"
          remixSource={{ generationId: 'gen-1', postId: 'post-1' }}
        />
      );
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });

    expect(authState.api.getRemixSourceBundle).toHaveBeenCalledWith('gen-1', { postId: 'post-1' });
    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    expect(promptInput.props.value).toBe('Restore this exact remix prompt.');
    const text = collectText(tree!.root);
    expect(text).toContain('1 / 14');
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for Hero Product' }).props.onPress();
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Reference name for Hero Product' }).props.value).toBe('Hero Product');
  });

  it('shows the restore as in flight and keeps a prompt typed while it was still running', async () => {
    let releaseBundle: (bundle: unknown) => void = () => {};
    authState.api.getRemixSourceBundle.mockReturnValue(
      new Promise((resolve) => {
        releaseBundle = resolve;
      })
    );

    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(
        <MediaCreationScreen
          initialTool="image"
          remixSource={{ generationId: 'gen-1', postId: 'post-1' }}
        />
      );
    });

    // The screen is fully interactive while the bundle is still in flight, so it
    // has to say so rather than look like a finished empty form.
    expect(collectText(tree!.root)).toContain('Restoring the original prompt, settings, and references…');

    const promptInput = () => tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput().props.onChangeText('my own idea, typed while waiting');
    });

    await renderer.act(async () => {
      releaseBundle({
        generation: {
          id: 'gen-1',
          title: 'Original source',
          prompt: 'Restore this exact remix prompt.',
          category: 'image',
          model: 'nano-banana-2',
        },
        result: null,
        inputs: {
          image: {
            elements: [
              {
                id: 'element-1',
                displayName: 'Hero Product',
                handle: '@hero_product',
                url: 'https://cdn.example.com/hero.png',
                storagePath: 'inputs/hero.png',
                sourceGenerationId: 'gen-1',
              },
            ],
          },
        },
        workflowSettings: { model: 'nano-banana-2', aspectRatio: '9:16', resolution: '2K' },
        restoreIssues: [],
      });
      await Promise.resolve();
    });

    // Their words win over the restore...
    expect(promptInput().props.value).toBe('my own idea, typed while waiting');
    // ...but everything else the restore carried still lands, and the in-flight
    // notice goes away.
    const settled = collectText(tree!.root);
    expect(settled).toContain('1 / 14');
    expect(settled).not.toContain('Restoring the original prompt, settings, and references…');
  });

  it('prefills prompt-only create deep links without remix hydration', async () => {
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" initialPrompt="hello from a deep link" />);
    });

    expect(authState.api.getRemixSourceBundle).not.toHaveBeenCalled();
    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    expect(promptInput.props.value).toBe('hello from a deep link');
  });

  it('opens a searchable model dropdown and selects a filtered model', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    expect(collectText(tree!.root)).not.toContain('Search models');

    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Selected model').props.onPress();
    });

    let text = collectText(tree!.root);
    expect(text).toContain('Grok Imagine');
    expect(text).toContain('GPT Image 2');
    expect(text).toContain('Choose model');

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
    expect(text.some((item) => item.includes('1K · 3:2'))).toBe(true);
  });

  it('removes the separate credits and cost cards', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text).not.toContain('Credits');
    expect(text).not.toContain('Cost');
    expect(text).toContain('Calculating…');
  });

  it('renders motion required inputs before the optional prompt', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    const text = collectText(tree!.root);
    expect(text.indexOf('Character image')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Motion video')).toBeGreaterThan(text.indexOf('Character image'));
    expect(text.indexOf('Optional direction')).toBeGreaterThan(text.indexOf('Motion video'));
    expect(tree!.root.findByProps({ testID: 'motion-character-slot' })).toBeTruthy();
    expect(tree!.root.findByProps({ testID: 'motion-video-slot' })).toBeTruthy();
  });

  it('keeps the persistent generate bar above the tab bar', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });

    const scrollView = tree!.root.find((node) => String(node.type) === 'scrollview');
    expect(scrollView.props.style).not.toEqual(expect.objectContaining({
      marginBottom: expect.any(Number),
    }));
    expect(scrollView.props.contentContainerStyle.paddingBottom).toBeGreaterThan(100);
    // Must clear the mocked 24pt top inset. Asserting the exact pad here is what
    // let the header render under the status bar in a tab: the flat value looked
    // intentional, so the regression read as expected behaviour.
    expect(scrollView.props.contentContainerStyle.paddingTop).toBeGreaterThan(24);
    expect(collectText(tree!.root)).toContain('Calculating…');
    const basePaddingBottom = scrollView.props.contentContainerStyle.paddingBottom;

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a glossy product hero shot.');
    });

    expect(collectText(tree!.root)).toContain('Calculating…');
    const scrollViewWithReview = tree!.root.find((node) => String(node.type) === 'scrollview');
    expect(scrollViewWithReview.props.style).not.toEqual(expect.objectContaining({
      marginBottom: expect.any(Number),
    }));
    expect(scrollViewWithReview.props.contentContainerStyle.paddingBottom).toBe(basePaddingBottom);

    renderer.act(() => {
      promptInput.props.onFocus();
    });
    expect(collectText(tree!.root)).toContain('Calculating…');
    const focusedScrollView = tree!.root.find((node) => String(node.type) === 'scrollview');
    expect(focusedScrollView.props.contentContainerStyle.paddingBottom).toBe(basePaddingBottom);

    renderer.act(() => {
      promptInput.props.onBlur();
    });
    expect(collectText(tree!.root)).toContain('Calculating…');
    const blurredScrollView = tree!.root.find((node) => String(node.type) === 'scrollview');
    expect(blurredScrollView.props.contentContainerStyle.paddingBottom).toBe(basePaddingBottom);
  });

  it('shows the authoritative server quote in the persistent bar', async () => {
    vi.useFakeTimers();
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'nano-banana-2',
      catalogRevision: 'test-catalog-rev',
      normalizedSettings: { aspectRatio: '4:5', resolution: '1K' },
      costCredits: 123,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a glossy product hero shot.');
    });

    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(collectText(tree!.root)).toContain('Generate · 123 credits');
    vi.useRealTimers();
  });

  it('does not show bundled pricing before a server quote exists', () => {
    catalogState.catalog = null;
    catalogState.isLoading = true;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a glossy product hero shot.');
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Calculating…');
    expect(text).not.toContain('Generate · 8 credits');
  });

  it('does not show bundled pricing in readiness when the catalog is unavailable', () => {
    catalogState.catalog = null;
    catalogState.isUnavailable = true;
    catalogState.error = new Error('Catalog unavailable');

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a glossy product hero shot.');
    });

    const text = collectText(tree!.root);
    expect(text).not.toContain('Cost ready');
    expect(text).not.toContain('8 credits available for this generation.');
    expect(text).toContain('Catalog unavailable');
    expect(text).toContain('Retry settings');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Retry settings').props.onPress();
    });
    expect(catalogState.refetch).toHaveBeenCalledTimes(1);
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
    expect(text.indexOf('Add a prompt before enhancing.')).toBeLessThan(text.indexOf('Reference images'));
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
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });

    const thumbnail = tree!.root.find((node) => String(node.type) === 'stable-media-image' && node.props.url === 'https://cdn.example.com/hero.png');
    expect(thumbnail.props).toEqual(expect.objectContaining({
      contentFit: 'cover',
      style: { width: '100%', height: '100%' },
    }));
    const referenceRail = tree!.root.findByProps({ testID: 'image-reference-rail' });
    expect(referenceRail.find((node) => String(node.type) === 'scrollview').props.horizontal).toBe(true);
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
      await tree!.root.findByProps({ accessibilityLabel: 'Add motion video' }).props.onPress();
    });

    expect(uploadPickedMedia).toHaveBeenCalledWith(
      'file:///motion.mp4',
      expect.objectContaining({ durationSeconds: 7.2 }),
    );
    const previews = tree!.root.findAll((node) => String(node.type) === 'media-preview');
    expect(previews).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        kind: 'video',
        url: 'https://cdn.example.com/motion.mp4',
      }),
    }));
  });

  it('does not offer prompt insertion for Motion assets that are not named prompt references', async () => {
    vi.mocked(pickMedia).mockResolvedValue({
      uri: 'file:///character.png',
      fileName: 'character.png',
      mimeType: 'image/png',
      fileSize: 2048,
    } as never);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/character.png',
      storagePath: 'uploads/user/character.png',
      mimeType: 'image/png',
      fileName: 'character.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });
    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Add character image' }).props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for Character Image' }).props.onPress();
    });

    expect(collectText(tree!.root)).toContain('Reference details');
    expect(collectText(tree!.root).some((text) => text.startsWith('Insert @'))).toBe(false);
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
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });
    const thumbnail = tree!.root.find((node) => String(node.type) === 'stable-media-image' && node.props.url === 'https://cdn.example.com/hero.png');
    expect(thumbnail.props).toEqual(expect.objectContaining({
      contentFit: 'cover',
      style: { width: '100%', height: '100%' },
    }));
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Reference details');
    expect(tree!.root.findAll((node) => String(node.type) === 'media-preview')).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        url: 'https://cdn.example.com/hero.png',
        height: 300,
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
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Reference name for hero' }).props.onChangeText('Logo Sheet');
    });

    const nameInput = tree!.root.findByProps({ accessibilityLabel: 'Reference name for Logo Sheet' });
    expect(nameInput.props.value).toBe('Logo Sheet');
    expect(collectText(tree!.root).some((item) => item.includes('@logo_sheet'))).toBe(true);
  });

  it('suggests named references after @ and replaces the active query at the caret', async () => {
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///flowers.png', fileName: 'flowers.png', mimeType: 'image/png', fileSize: 2048 } as never,
    ]);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/flowers.png',
      storagePath: 'uploads/user/flowers.png',
      mimeType: 'image/png',
      fileName: 'flowers.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });

    let promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    renderer.act(() => promptInput.props.onFocus());
    renderer.act(() => promptInput.props.onChangeText('Use @flo for color'));
    promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    renderer.act(() => promptInput.props.onSelectionChange({ nativeEvent: { selection: { start: 8, end: 8 } } }));

    expect(tree!.root.findByProps({ testID: 'reference-mention-suggestions' })).toBeTruthy();
    expect(collectText(tree!.root)).toContain('@flowers');
    expect(collectText(tree!.root).some((item) => item.includes('Unknown element mention:'))).toBe(false);
    const suggestion = tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Insert @flowers, flowers'
    ));
    renderer.act(() => suggestion.props.onPress());

    promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    expect(promptInput.props.value).toBe('Use @flowers for color');
    expect(tree!.root.findAllByProps({ testID: 'reference-mention-suggestions' })).toHaveLength(0);
  });

  it('inserts a reference-details handle at the last prompt cursor instead of the end', async () => {
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///flowers.png', fileName: 'flowers.png', mimeType: 'image/png', fileSize: 2048 } as never,
    ]);
    vi.mocked(uploadPickedMedia).mockResolvedValue({
      signedUrl: 'https://cdn.example.com/flowers.png',
      storagePath: 'uploads/user/flowers.png',
      mimeType: 'image/png',
      fileName: 'flowers.png',
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });

    let promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    renderer.act(() => promptInput.props.onFocus());
    renderer.act(() => promptInput.props.onChangeText('Place beside the vase.'));
    promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    renderer.act(() => promptInput.props.onSelectionChange({ nativeEvent: { selection: { start: 13, end: 13 } } }));
    renderer.act(() => promptInput.props.onBlur());
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for flowers' }).props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Insert @flowers').props.onPress();
    });

    promptInput = tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' });
    expect(promptInput.props.value).toBe('Place beside @flowers the vase.');
  });

  it('keeps a cleared reference name blank and removes its old prompt handle', async () => {
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
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Insert @hero').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Reference name for hero' }).props.onChangeText('');
    });

    const clearedInput = tree!.root.findByProps({ accessibilityLabel: 'Reference name for hero.png' });
    expect(clearedInput.props.value).toBe('');
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).not.toContain('@hero');
    expect(collectText(tree!.root).some((item) => item.includes('Insert @hero'))).toBe(false);
  });

  it('confirms reference removal and cleans its handle from the prompt', async () => {
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
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Insert @hero').props.onPress();
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toContain('@hero');

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Remove hero' }).props.onPress();
    });
    expect(nativeAlertState.alert).toHaveBeenCalledWith(
      'Remove reference?',
      expect.stringContaining('@hero'),
      expect.any(Array),
    );
    const buttons = nativeAlertState.alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    renderer.act(() => {
      buttons.find((button) => button.text === 'Remove')?.onPress?.();
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).not.toContain('@hero');
    expect(collectText(tree!.root)).toContain('Reference updated');
    expect(collectText(tree!.root).some((item) => item.includes('hero and @hero were removed'))).toBe(true);
  });

  it('shows rename persistence feedback in reference details', async () => {
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
      await findPressableByText(tree!.root, 'Reference').props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Reference name for hero' }).props.onChangeText('Hero product');
    });
    expect(collectText(tree!.root)).toContain('Saving…');
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Reference name for Hero product' }).props.onBlur();
    });
    expect(collectText(tree!.root)).toContain('Saved to draft');
  });

  it('keeps model selection out of the parameter sheet', () => {
    authState.credits = 1_234;
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });
    const text = collectText(tree!.root);
    expect(text).toContain('Generation parameters');
    expect(text).toContain('Output format');
    expect(text).toContain('Available balance');
    expect(text).toContain('1,234 credits');
    expect(tree!.root.findByProps({ accessibilityLabel: 'Available balance, 1,234 credits' })).toBeTruthy();
    expect(text).not.toContain('Choose model');
    expect(text).not.toContain('Search models');
  });

  it('renders truthful fixed output format, image-accent selections, and ordered aspect ratios', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });

    expect(tree!.root.findByProps({ testID: 'read-only-parameter-value' }).props.accessibilityLabel).toBe('JPG. Fixed for this model');
    expect(tree!.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'JPG')).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Close generation parameters' })).toBeTruthy();

    const ratioLabels = tree!.root.findAll((node) => (
      String(node.type) === 'pressable'
      && ['1:1', '4:5', '3:2'].includes(String(node.props.accessibilityLabel))
    )).map((node) => node.props.accessibilityLabel);
    expect(ratioLabels).toEqual(['1:1', '4:5', '3:2']);

    const selectedRatio = tree!.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === '4:5');
    expect(selectedRatio.props.accessibilityState.selected).toBe(true);
    expect(selectedRatio.props.style.borderColor).toBe('#73bff28a');
    expect(selectedRatio.props.style).toEqual(expect.objectContaining({ minHeight: 48, width: '23%' }));

    const squarePreview = tree!.root.findByProps({ testID: 'aspect-ratio-preview-1:1' }).props.style;
    const portraitPreview = tree!.root.findByProps({ testID: 'aspect-ratio-preview-4:5' }).props.style;
    const landscapePreview = tree!.root.findByProps({ testID: 'aspect-ratio-preview-3:2' }).props.style;
    expect(squarePreview.width).toBe(squarePreview.height);
    expect(portraitPreview.height).toBeGreaterThan(portraitPreview.width);
    expect(landscapePreview.width).toBeGreaterThan(landscapePreview.height);
    expect(tree!.root.findAll((node) => (
      String(node.type) === 'text'
      && node.props.accessibilityLiveRegion === 'polite'
    )).length).toBeGreaterThan(0);
  });

  it('uses boxed parameter tiles for resolution and selectable output formats', () => {
    const catalog = createTestGenerationModelCatalog();
    const imageModel = catalog.models.find((model) => model.id === 'nano-banana-2')!;
    imageModel.capabilities.outputFormat = true;
    imageModel.controls = imageModel.controls.map((control) => (
      control.key === 'resolution'
        ? { ...control, options: [{ value: '1K', label: '1K' }, { value: '2K', label: '2K' }, { value: '4K', label: '4K' }] }
        : control
    ));
    imageModel.controls.push({
      key: 'outputFormat',
      label: 'Output format',
      type: 'choice',
      presentation: 'chips',
      defaultValue: 'jpg',
      options: [{ value: 'jpg', label: 'jpg' }, { value: 'png', label: 'png' }],
    });
    catalogState.catalog = catalog;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });

    const resolution = tree!.root.find((node) => String(node.type) === 'pressable' && node.props.testID === 'parameter-choice-resolution-1K');
    const output = tree!.root.find((node) => String(node.type) === 'pressable' && node.props.testID === 'parameter-choice-outputFormat-jpg');
    expect(resolution.props.style).toEqual(expect.objectContaining({ width: '31%', minHeight: 48, borderRadius: 14 }));
    expect(output.props.style).toEqual(expect.objectContaining({ width: '48.5%', minHeight: 48, borderRadius: 14 }));
    expect(resolution.props.accessibilityState).toEqual({ selected: true });
    expect(output.props.accessibilityState).toEqual({ selected: true });

    renderer.act(() => {
      tree!.root.find((node) => String(node.type) === 'pressable' && node.props.testID === 'parameter-choice-outputFormat-png').props.onPress();
    });
    expect(tree!.root.find((node) => String(node.type) === 'pressable' && node.props.testID === 'parameter-choice-outputFormat-png').props.accessibilityState).toEqual({ selected: true });
  });

  it('keeps advanced toggles visually compact with an accessible hit area', () => {
    const catalog = createTestGenerationModelCatalog();
    const imageModel = catalog.models.find((model) => model.id === 'nano-banana-2')!;
    imageModel.capabilities.googleSearch = true;
    imageModel.controls.push({
      key: 'googleSearch',
      label: 'Google Search',
      type: 'boolean',
      presentation: 'toggle',
      defaultValue: false,
    });
    catalogState.catalog = catalog;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });

    const googleSearchSwitch = tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Google Search'
    ));
    expect(googleSearchSwitch.props.style).toEqual(expect.objectContaining({ width: 56, minHeight: 48 }));
    expect(googleSearchSwitch.props.accessibilityState).toEqual({ checked: false });
    expect(googleSearchSwitch.props.accessibilityHint).toBe('Turns google search on');
    expect(tree!.root.findByProps({ testID: 'compact-toggle-visual' }).props.style).toEqual({ transform: [{ scale: 0.76 }] });

    renderer.act(() => {
      googleSearchSwitch.props.onPress();
    });
    expect(tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Google Search'
    )).props.accessibilityState).toEqual({ checked: true });
  });

  it('renders remote toggle and stepper controls and quotes their generic settings', async () => {
    vi.useFakeTimers();
    const catalog = catalogV2();
    const videoModel = catalog.models.find((model) => model.id === 'fallback-video-v2')!;
    videoModel.controls.push(
      {
        key: 'cinematicLock',
        label: 'Cinematic lock',
        type: 'boolean',
        presentation: 'toggle',
        defaultValue: false,
      },
      {
        key: 'motionIntensity',
        label: 'Motion intensity',
        type: 'integer',
        presentation: 'stepper',
        defaultValue: 2,
        min: 1,
        max: 5,
        step: 1,
      },
    );
    catalogState.catalog = catalog;
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: videoModel.id,
      catalogRevision: catalog.revision,
      normalizedSettings: {
        referenceMode: 'elements',
        resolution: '720p',
        duration: 7,
        cinematicLock: true,
        motionIntensity: 3,
      },
      costCredits: 29,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });

    const cinematicLock = tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Cinematic lock'
    ));
    renderer.act(() => {
      cinematicLock.props.onPress();
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Increase motion intensity' }).props.onPress();
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(tree!.root.findByProps({ testID: 'parameter-stepper-motionIntensity' })).toBeTruthy();
    const quoteBody = authState.api.quoteGenerationModel.mock.calls.at(-1)?.[0];
    expect(quoteBody).toMatchObject({
      modelId: videoModel.id,
      settings: {
        cinematicLock: true,
        motionIntensity: 3,
      },
    });
  });

  it('keeps video parameters in the sheet and multi-shot editing in the composer', () => {
    const catalog = createTestGenerationModelCatalog();
    const videoModel = catalog.models.find((model) => model.id === 'kling-3.0-video')!;
    videoModel.capabilities.multiShot = true;
    videoModel.controls.push({
      key: 'isMultiShot',
      label: 'Multi-shot',
      type: 'boolean',
      presentation: 'toggle',
      defaultValue: false,
    });
    catalogState.catalog = catalog;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });

    expect(tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityRole === 'switch'
      && node.props.accessibilityLabel === 'Sound'
    ))).toBeTruthy();

    expect(tree!.root.findAll((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityRole === 'switch'
      && node.props.accessibilityLabel === 'Multi-shot'
    ))).toHaveLength(0);
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Close generation parameters' }).props.onPress();
    });

    const multiShotSwitch = tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'Multi-shot'
    ));
    renderer.act(() => {
      multiShotSwitch.props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Add shot').props.onPress();
    });

    const removeShot = tree!.root.find((node) => (
      String(node.type) === 'pressable'
      && typeof node.props.accessibilityLabel === 'string'
      && node.props.accessibilityLabel.startsWith('Remove shot ')
      && node.props.accessibilityState?.disabled === false
    ));
    expect(removeShot.props.accessibilityRole).toBe('button');
    expect(removeShot.props.accessibilityState).toEqual({ disabled: false });
    expect(removeShot.props.style).toMatchObject({ width: 48, height: 48 });
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
    expect(text).toContain('Unknown element mention: @missing_reference');
    expect(text).not.toContain('Review issues');
    expect(text).not.toContain('Generation checks');
  });

  it('shows one contextual motion blocker instead of the legacy ready check', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="motion" />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Character image is required.');
    expect(tree!.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'creator-contextual-blocker')).toHaveLength(1);
    expect(text).not.toContain('Ready check');
    expect(text).not.toContain('Generation checks');
  });

  it('lets a guest generate without registering', async () => {
    // App Review rejected 0.0.5 (28) under guideline 5.1.1(v) for requiring
    // registration before purchase. Buying is only half of it: credits a guest
    // paid for have to be spendable too, or the purchase they were allowed to
    // make buys them nothing.
    //
    // `user` stays null for guests on purpose — roughly seventy `!user` checks
    // across this app mean "is this person registered?" and gate publishing,
    // comments, follows and payouts. This screen reads `identityUserId`, which
    // is the backend identity either way.
    vi.useFakeTimers();
    authState.user = null;
    authState.isGuest = true;
    authState.identityUserId = 'guest-1';
    authState.api.startImageGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-guest-1',
      generationId: 'gen-guest-1',
      status: 'processing',
      remainingCredits: 480,
    });
    authState.api.getImageGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/guest-output.png',
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('A guest-made product shot.');
    });

    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate \u00b7 8 credits').props.onPress();
    });

    // Generated, not bounced to /auth.
    expect(authState.api.startImageGeneration).toHaveBeenCalledTimes(1);
    expect(routerState.push).not.toHaveBeenCalled();
  });

  it('offers a post handoff after a generation succeeds with a generation id', async () => {
    vi.useFakeTimers();
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
      await vi.advanceTimersByTimeAsync(200);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });

    expect(authState.api.startImageGeneration).toHaveBeenCalledTimes(1);
    expect(authState.api.getImageGeneration).toHaveBeenCalledTimes(1);
    const text = collectText(tree!.root);
    expect(text).toContain('Post to feed');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Post to feed').props.onPress();
    });
    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/post/new',
      params: { generationId: 'gen-1' },
    });
    vi.useRealTimers();
  });

  it('starts catalog-v2 models through the unified generation endpoint', async () => {
    vi.useFakeTimers();
    catalogState.catalog = catalogV2();
    const startGeneration = vi.fn().mockResolvedValue({
      success: true,
      predictionId: 'unified-video-prediction',
      generationId: 'unified-video-generation',
      status: 'processing',
      remainingCredits: 970,
    });
    authState.api.startGeneration = startGeneration;
    authState.api.getVideoGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/unified-output.mp4',
    });
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'fallback-video-v2',
      catalogRevision: 'catalog-v2-revision',
      normalizedSettings: {
        referenceMode: 'elements',
        resolution: '720p',
        duration: 7,
      },
      costCredits: 29,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('Create a remote cinematic reveal.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 29 credits').props.onPress();
    });

    expect(startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'video',
        modelId: 'fallback-video-v2',
        catalogRevision: 'catalog-v2-revision',
        prompt: 'Create a remote cinematic reveal.',
        settings: expect.objectContaining({
          referenceMode: 'elements',
          resolution: '720p',
          duration: 7,
        }),
        inputs: [],
      }),
      expect.stringMatching(/^video:/),
    );
    expect(authState.api.startVideoGeneration).not.toHaveBeenCalled();
    expect(authState.api.getVideoGeneration).toHaveBeenCalledWith('unified-video-prediction');
  });

  it('opens the shared video result workspace and posts with the generation id', async () => {
    vi.useFakeTimers();
    authState.api.startVideoGeneration.mockResolvedValue({
      success: true,
      predictionId: 'video-prediction-1',
      generationId: 'video-gen-1',
      status: 'processing',
      remainingCredits: 980,
    });
    authState.api.getVideoGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/output.mp4',
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('Create a cinematic product reveal.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });

    expect(authState.api.startVideoGeneration).toHaveBeenCalledTimes(1);
    expect(collectText(tree!.root)).toContain('Your video');
    expect(tree!.root.find((node) => String(node.type) === 'media-preview' && node.props.url === 'https://cdn.example.com/output.mp4').props.kind).toBe('video');
    renderer.act(() => {
      findPressableByText(tree!.root, 'Post to feed').props.onPress();
    });
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/post/new', params: { generationId: 'video-gen-1' } });
    vi.useRealTimers();
  });

  it('minimizes and reopens an in-progress image workspace without cancelling generation', async () => {
    vi.useFakeTimers();
    authState.api.startImageGeneration.mockReturnValue(new Promise(() => undefined));

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />);
    });
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('Create an editorial product image.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    renderer.act(() => {
      void findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });
    expect(collectText(tree!.root)).toContain('Creating image');
    expect(collectText(tree!.root)).toContain('Minimize');

    renderer.act(() => {
      findPressableByText(tree!.root, 'Minimize').props.onPress();
    });
    expect(collectText(tree!.root)).not.toContain('Creating image');
    expect(collectText(tree!.root)).toContain('View progress');

    renderer.act(() => {
      findPressableByText(tree!.root, 'View progress').props.onPress();
    });
    expect(collectText(tree!.root)).toContain('Creating image');
    expect(authState.api.startImageGeneration).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('retries an interrupted status check without starting or charging for a second generation', async () => {
    vi.useFakeTimers();
    authState.api.startImageGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-interrupted',
      generationId: 'gen-interrupted',
      status: 'processing',
      remainingCredits: 980,
    });
    authState.api.getImageGeneration
      .mockRejectedValueOnce(new Error('Could not refresh generation progress.'))
      .mockResolvedValueOnce({
        status: 'succeeded',
        output: 'https://cdn.example.com/recovered.png',
      });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('Create a resilient product image.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });

    expect(collectText(tree!.root)).toContain('Progress check interrupted');
    expect(collectText(tree!.root)).toContain('Retry status check');
    expect(authState.api.startImageGeneration).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Retry status check').props.onPress();
    });

    expect(authState.api.startImageGeneration).toHaveBeenCalledTimes(1);
    expect(authState.api.getImageGeneration).toHaveBeenCalledTimes(2);
    expect(collectText(tree!.root)).toContain('Post to feed');
    vi.useRealTimers();
  });

  it('shows failed generation actions and retries with the preserved draft', async () => {
    vi.useFakeTimers();
    authState.api.startImageGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-failed',
      generationId: 'gen-failed',
      status: 'processing',
      remainingCredits: 980,
    });
    authState.api.getImageGeneration.mockResolvedValue({
      status: 'failed',
      error: 'The image provider timed out.',
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
    renderer.act(() => {
      promptInput.props.onChangeText('Create a dramatic studio portrait.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });

    expect(collectText(tree!.root)).toContain('Generation failed');
    expect(collectText(tree!.root)).toContain('The image provider timed out.');
    // S9: every route to a paid generation states the price, so the failure
    // panel's retry is no longer a bare verb.
    expect(collectText(tree!.root)).toContain('Try again · 8 credits');
    expect(collectText(tree!.root)).toContain('Back to creator');

    authState.api.startImageGeneration.mockReturnValueOnce(new Promise(() => undefined));
    renderer.act(() => {
      void findPressableByText(tree!.root, 'Try again · 8 credits').props.onPress();
    });
    expect(authState.api.startImageGeneration).toHaveBeenCalledTimes(2);
    expect(promptInput.props.value).toBe('Create a dramatic studio portrait.');
    vi.useRealTimers();
  });

  it('creates another image while preserving prompt and parameters', async () => {
    vi.useFakeTimers();
    authState.api.startImageGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-another',
      generationId: 'gen-another',
      status: 'processing',
      remainingCredits: 980,
    });
    authState.api.getImageGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/another.png',
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('Keep this product prompt.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Back to creator').props.onPress();
    });

    expect(collectText(tree!.root)).not.toContain('Your image');
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('Keep this product prompt.');
    expect(collectText(tree!.root).some((item) => item.includes('1K · 4:5 · JPG'))).toBe(true);
    vi.useRealTimers();
  });
  it('offers enhancement level and undo on every prompt surface', async () => {
    // Three separate prompt surfaces call enhancePrompt (one per creator
    // composer); a device check caught the controls shipping on only one of
    // them.
    authState.api.enhancePrompt.mockResolvedValue({ enhancedPrompt: 'Enhanced product prompt.', remainingCredits: 900 });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Full enhancement' })).toBeTruthy();
    const lightControl = tree!.root.findByProps({ accessibilityLabel: 'Light enhancement' });
    expect(lightControl.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));

    renderer.act(() => {
      lightControl.props.onPress();
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Light enhancement' }).props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));

    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('creator lifts the serum');
    });
    // No enhancement has run, so there is nothing to undo yet.
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Undo enhancement' })).toHaveLength(0);

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Enhance').props.onPress();
    });

    expect(authState.api.enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ enhancementLevel: 'faithful' }),
    }));
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value)
      .toBe('Enhanced product prompt.');

    const undoControl = tree!.root.findAllByProps({ accessibilityLabel: 'Undo enhancement' })[0];
    expect(undoControl).toBeTruthy();
    renderer.act(() => {
      undoControl.props.onPress();
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value)
      .toBe('creator lifts the serum');
  });
});
