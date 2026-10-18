// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const draftStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: draftStorage }));

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
  // A draft from a build that kept one for the whole phone is resumed only for
  // the session that saved it, judged by when that session signed in.
  session: null as { user: { id: string; last_sign_in_at?: string | null } } | null,
  isGuest: false,
  credits: 999,
  updateCredits: vi.fn(),
  refreshProfile: vi.fn(async () => undefined),
  // Never rejects, and mints nothing while the guest already keeps a ticket (lib/auth.tsx).
  ensureGuestMergeTicket: vi.fn(async () => undefined),
  api: {
    enhancePrompt: vi.fn(),
    // Every run starts here, as in the app (catalog schema 3); the per-kind starts below
    // answer 410 on the server now, and the screen never calls them.
    startGeneration: vi.fn(),
    startImageGeneration: vi.fn(),
    startVideoGeneration: vi.fn(),
    startMotionGeneration: vi.fn(),
    getImageGeneration: vi.fn(),
    getVideoGeneration: vi.fn(),
    getMotionGeneration: vi.fn(),
    quoteGenerationModel: vi.fn(),
    getRemixSourceBundle: vi.fn(),
    createMediaReadUrl: vi.fn(),
    createSeedanceAsset: vi.fn(),
    getSeedanceAsset: vi.fn(),
    reportGeneration: vi.fn(),
  },
}));

const EMPTY_MISSING_IDS = vi.hoisted(() => [] as string[]);
// The model ids the screen last asked the catalog hook to load.
const catalogHookCalls = vi.hoisted(() => ({ selectedIds: [] as string[] }));
const catalogState = vi.hoisted(() => ({
  catalog: null as unknown,
  // When set, what the hook's loadDetails answers, so a case can hold a model's details
  // back from `catalog` the way the screen meets a model first picked.
  loadDetails: null as null | ((ids: string[]) => Promise<unknown>),
  // When set, the picker's list, which can name models `catalog` has no details for.
  summaries: null as unknown[] | null,
  isLoading: false,
  isUnavailable: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

const nativeAlertState = vi.hoisted(() => ({
  alert: vi.fn(),
}));

const keyboardState = vi.hoisted(() => ({
  dismiss: vi.fn(),
}));

// Android's back key, as the screen's own surfaces claim it.
const backHandlerState = vi.hoisted(() => ({
  listeners: new Set<() => boolean>(),
}));

// Timed animations end at once unless a case holds them, to look at a sheet
// while it is still leaving; `finishAnimations` then delivers their ends.
const animatedState = vi.hoisted(() => ({
  hold: false,
  pending: [] as Array<(result: { finished: boolean }) => void>,
}));

function finishAnimations() {
  for (const done of animatedState.pending.splice(0)) done({ finished: true });
}

// Permission to send prompts and media to AI services is its own module's job
// (`__tests__/ai-data-consent.test.ts`). Here it answers yes unless a case says
// otherwise, and the cases check that the screen asks before anything is sent.
const aiDataConsentState = vi.hoisted(() => ({
  ensure: vi.fn(async () => true),
}));

vi.mock('@/lib/ai-data-consent', () => ({
  ensureAiDataConsent: aiDataConsentState.ensure,
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
  Animated: {
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
    Value: class {
      constructor(public value: number) {}

      setValue(next: number) {
        this.value = next;
      }

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
  Keyboard: keyboardState,
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
  BellRing: (props: MockProps) => React.createElement('bell-ring-icon', props),
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
// The real @/lib/onboarding takes its event ids from expo-crypto, which has the
// same native core.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'onboarding-event-id' }));

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

const notificationsMock = vi.hoisted(() => ({ registerForMobilePushNotifications: vi.fn() }));
vi.mock('@/lib/notifications', () => notificationsMock);

// Reference links are dated against the storage origin, so the suite fixes one.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/env')>();
  return { ...actual, env: { ...actual.env, supabaseUrl: 'https://project.supabase.co' } };
});

const loadCatalogDetails = async (ids: string[]) => (catalogState.loadDetails ? catalogState.loadDetails(ids) : catalogState.catalog);

vi.mock('@/lib/use-generation-model-catalog', () => ({
  useGenerationModelCatalog: (_api: unknown, options: { selectedIds?: string[] } = {}) => {
    catalogHookCalls.selectedIds = options.selectedIds ?? [];
    return { ...catalogState, loadDetails: loadCatalogDetails, summaries: catalogState.summaries ?? (catalogState.catalog as {models?: unknown[]} | null)?.models ?? [], missingIds: EMPTY_MISSING_IDS, isLoadingModels: false };
  },
}));

import { AppState, PanResponder } from 'react-native';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';
import { MediaCreationScreen } from '../components/media-creation-screen';
import { PUSH_OFFER_STORAGE_KEY, resetPushOffersForTests } from '../lib/push-prompt';
import { readCreatorSession, resetCreatorSessionForTests } from '../lib/creator-session-diagnostics';
import { pickAudioDocument, pickMedia, pickMediaList, uploadPickedMedia, type UploadedMedia } from '../lib/media';
import { UploadCancelledError } from '../lib/upload-file';
import { createRemixRestoreCatalog, createTestGenerationModelCatalog, remoteImageModel, seedance15ProModel } from './fixtures/generation-model-catalog';
import { catalogV2 } from './generation-model-catalog-v2-fixtures';
import type { CatalogInputMode, CatalogInputSlot, GenerationModelCatalog, GenerationModelDescriptor } from '../lib/generation-model-catalog';
import { creationDraftStorageKey, ordinaryDraftScope, remixDraftScope } from '../lib/creation-draft-resume';
import { activeGenerationRecordStorageKey } from '../lib/active-generation-record';
import type { ModelCatalogKind, ModelCatalogSummary } from '../lib/model-catalog/protocol';
import { PrimaryButton, SecondaryButton } from '../components/ui';
import { ApiError } from '../lib/api-client';
import whatsNewContract from '../../contracts/whats-new-models-v1.json';

const referenceModeIs = (value: 'frames' | 'elements') => [{ source: 'setting' as const, key: 'referenceMode', operator: 'equals' as const, value }];
const frameSlots: CatalogInputSlot[] = [
  { key: 'startFrame', kind: 'image', role: 'startFrame', label: 'Start frame', min: 0, max: 1 },
  { key: 'endFrame', kind: 'image', role: 'endFrame', label: 'End frame', min: 0, max: 1 },
];

/** Seedance 2's published input modes: frames, or reusable references, one per run. */
function seedanceInputModes(): CatalogInputMode[] {
  return [
    { key: 'frames', label: 'Frames', default: true, conditions: referenceModeIs('frames'), slots: frameSlots },
    {
      key: 'references',
      label: 'Reusable references',
      default: false,
      conditions: referenceModeIs('elements'),
      slots: [
        { key: 'imageReferences', kind: 'image', role: 'reference', label: 'Reference images', min: 0, max: 5, supportsNaming: true },
        { key: 'videoReferences', kind: 'video', role: 'reference', label: 'Reference videos', min: 0, max: 3, durationMetadata: 'required', maxDurationSeconds: 15 },
        { key: 'audioReferences', kind: 'audio', role: 'reference', label: 'Reference audio', min: 0, max: 3, durationMetadata: 'optional', maxDurationSeconds: 15 },
      ],
    },
  ];
}

/**
 * Descriptors shaped as the production catalog publishes them (src/lib/generation-model-catalog.ts),
 * with input modes, for the cases about what a run sends.
 */
function parityImageModel(id: string, displayName: string, maxImages: number): GenerationModelDescriptor {
  return {
    id,
    kind: 'image',
    displayName,
    description: `${displayName} test descriptor`,
    badge: null,
    recommended: false,
    sortOrder: 0,
    minClientSchemaVersion: 1,
    controls: [
      { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '4:5', options: [{ value: '4:5', label: '4:5' }, { value: '1:1', label: '1:1' }] },
      { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '1K', options: [{ value: '1K', label: '1K' }] },
    ],
    capabilities: { multiShot: false, sound: false, fixedLens: false, googleSearch: false, outputFormat: false },
    inputs: { imageReferences: maxImages > 0 ? { max: maxImages, supportsNaming: true } : null, videoReferences: null, audioReferences: null, startFrame: false, endFrame: false },
    availability: { web: true, mobile: true },
    inputModes: maxImages > 0
      ? [{ key: 'references', label: 'Reference images', default: true, slots: [{ key: 'imageReferences', kind: 'image', role: 'reference', label: 'Reference images', min: 0, max: maxImages, supportsNaming: true }] }]
      : [{ key: 'prompt-only', label: 'Prompt only', default: true, slots: [] }],
    inputConstraints: [],
  };
}

/** Kling 3.0 as published: frames, and named video elements in a mode of their own beside them. */
function parityKlingVideo(): GenerationModelDescriptor {
  return {
    id: 'kling-3.0-video',
    kind: 'video',
    displayName: 'Kling 3.0 Cinematic',
    description: 'Kling 3.0 test descriptor',
    badge: null,
    recommended: true,
    sortOrder: 0,
    minClientSchemaVersion: 1,
    controls: [
      { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '16:9', options: [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
      { key: 'mode', label: 'Quality mode', type: 'choice', presentation: 'chips', defaultValue: 'std', options: [{ value: 'std', label: 'Standard' }, { value: 'pro', label: 'Pro' }] },
      { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 5, min: 3, max: 15, step: 1, unit: 'seconds' },
      { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
      { key: 'isMultiShot', label: 'Multi-shot', type: 'boolean', presentation: 'toggle', defaultValue: false },
    ],
    capabilities: { multiShot: true, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
    inputs: { imageReferences: null, videoReferences: { max: 3 }, audioReferences: null, startFrame: true, endFrame: true, combineFramesWithReferences: false },
    availability: { web: true, mobile: true },
    inputModes: [
      { key: 'frames', label: 'Frames', default: true, conditions: referenceModeIs('frames'), slots: frameSlots },
      {
        key: 'video-elements',
        label: 'Video elements',
        default: false,
        slots: [{ key: 'videoElements', kind: 'video', role: 'reference', label: 'Video elements', min: 0, max: 3, supportsNaming: true, durationMetadata: 'optional' }],
      },
    ],
    inputConstraints: [],
  };
}

function paritySeedanceVideo(): GenerationModelDescriptor {
  return {
    ...parityKlingVideo(),
    id: 'seedance-2',
    displayName: 'Seedance 2',
    recommended: false,
    controls: [
      { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '16:9', options: [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
      { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 5, min: 4, max: 15, step: 1, unit: 'seconds' },
      { key: 'referenceMode', label: 'Input mode', type: 'choice', presentation: 'chips', defaultValue: 'frames', options: [{ value: 'frames', label: 'Frames' }, { value: 'elements', label: 'References' }] },
    ],
    capabilities: { multiShot: false, sound: false, fixedLens: false, googleSearch: false, outputFormat: false },
    inputs: { imageReferences: { max: 5, supportsNaming: true }, videoReferences: { max: 3 }, audioReferences: { max: 3 }, startFrame: true, endFrame: true, combineFramesWithReferences: false },
    inputModes: seedanceInputModes(),
  };
}

function parityMotionModel(): GenerationModelDescriptor {
  return {
    id: 'kling-3.0',
    kind: 'motion',
    displayName: 'Kling 3.0',
    description: 'Kling 3.0 motion test descriptor',
    badge: null,
    recommended: true,
    sortOrder: 0,
    minClientSchemaVersion: 1,
    controls: [
      { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '720p', options: [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }] },
      { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 10, min: 1, max: 30, step: 1, unit: 'seconds' },
    ],
    capabilities: { multiShot: false, sound: false, fixedLens: false, googleSearch: false, outputFormat: false },
    inputs: { imageReferences: null, videoReferences: { max: 1 }, audioReferences: null, startFrame: false, endFrame: false },
    availability: { web: true, mobile: true },
    inputModes: [{
      key: 'motion-inputs',
      label: 'Motion inputs',
      default: true,
      slots: [
        { key: 'characterImage', kind: 'image', role: 'reference', label: 'Character image', min: 1, max: 1 },
        { key: 'referenceVideo', kind: 'video', role: 'reference', label: 'Reference video', min: 1, max: 1, durationMetadata: 'optional', maxDurationSeconds: 30 },
      ],
    }],
    inputConstraints: [],
  };
}

function parityCatalog(models: GenerationModelDescriptor[]): GenerationModelCatalog {
  const first = (kind: GenerationModelDescriptor['kind']) => models.find((model) => model.kind === kind)?.id ?? null;
  return { schemaVersion: 3, revision: 'parity-rev', defaults: { image: first('image'), video: first('video'), motion: first('motion') }, models };
}

/** A quote that prices the request it is given and hands its settings back, as the server's does. */
function quoteEchoingSettings(costCredits = 8) {
  authState.api.quoteGenerationModel.mockImplementation(async (request: { modelId: string; catalogRevision: string; settings: Record<string, unknown> }) => ({
    modelId: request.modelId,
    catalogRevision: request.catalogRevision,
    normalizedSettings: request.settings,
    costCredits,
  }));
}

/** A reference the creator uploaded: staged under their own path, named after its file. */
function stagedMedia(id: string, kind: 'image' | 'video' | 'audio' = 'image', extra: Record<string, unknown> = {}) {
  const extension = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
  return {
    id,
    kind,
    url: `https://cdn.example.com/${id}.${extension}`,
    storagePath: `uploads/user-123/${id}.${extension}`,
    fileName: `${id}.${extension}`,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    handle: `@${id}`,
    durationSeconds: kind === 'image' ? null : 4,
    sourceGenerationId: null,
    ...extra,
  };
}

const mountedTrees: renderer.ReactTestRenderer[] = [];
const createRenderer = renderer.create.bind(renderer);

/**
 * The screen invalidates the create ring's in-flight count when a run starts,
 * so it now calls `useQueryClient` and needs a provider. Supplied here, once,
 * rather than at the sixty-odd render sites below — and with a real client
 * rather than a module mock, so the screen meets the same react-query it does
 * in the app. The provider renders only its children, so the serialized tree
 * these cases assert on is unchanged.
 */
const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const withClient = (element: React.ReactElement) => (
  <QueryClientProvider client={testQueryClient}>{element}</QueryClientProvider>
);

vi.spyOn(renderer, 'create').mockImplementation((...args: Parameters<typeof renderer.create>) => {
  const [element, ...rest] = args;
  const tree = createRenderer(withClient(element as React.ReactElement), ...rest);
  // `update` replaces the root outright, so it would drop the provider and
  // throw on the next render. Two cases re-render to prove a catalog refresh
  // does not crash the screen, which is exactly where that would bite.
  const update = tree.update.bind(tree);
  tree.update = (next: React.ReactElement) => update(withClient(next));
  mountedTrees.push(tree);
  return tree;
});

// Push is already on unless a case says otherwise, so the notifications offer
// stays out of the cases that are not about it. The client above is shared, so
// the device's push state is dropped between cases too.
beforeEach(() => {
  notificationsMock.registerForMobilePushNotifications
    .mockReset()
    .mockResolvedValue({ status: 'registered', expoPushToken: 'ExponentPushToken[test]' });
  resetPushOffersForTests();
  testQueryClient.removeQueries({ queryKey: ['mobile-push-registration'] });
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
    draftStorage.getItem.mockReset().mockResolvedValue(null);
    draftStorage.setItem.mockReset().mockResolvedValue(undefined);
    draftStorage.removeItem.mockReset().mockResolvedValue(undefined);
    routerState.push.mockClear();
    resetCreatorSessionForTests();
    authState.updateCredits.mockClear();
    authState.refreshProfile.mockClear();
    authState.ensureGuestMergeTicket.mockClear();
    authState.credits = 999;
    authState.user = { id: 'user-123', email: 'creator@example.com' };
    authState.identityUserId = 'user-123';
    authState.session = null;
    authState.isGuest = false;
    authState.api.startGeneration = vi.fn();
    authState.api.startImageGeneration.mockReset();
    authState.api.getImageGeneration.mockReset();
    authState.api.startVideoGeneration.mockReset();
    authState.api.getVideoGeneration.mockReset();
    authState.api.startMotionGeneration.mockReset();
    authState.api.getMotionGeneration.mockReset();
    authState.api.quoteGenerationModel.mockReset();
    authState.api.getRemixSourceBundle.mockReset();
    authState.api.createMediaReadUrl.mockReset();
    authState.api.createSeedanceAsset.mockReset();
    authState.api.getSeedanceAsset.mockReset();
    authState.api.reportGeneration.mockReset();
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'nano-banana-2',
      catalogRevision: 'test-catalog-rev',
      normalizedSettings: { aspectRatio: '4:5', resolution: '1K' },
      costCredits: 8,
    });
    catalogState.catalog = createTestGenerationModelCatalog();
    catalogState.loadDetails = null;
    catalogState.summaries = null;
    catalogState.isLoading = false;
    catalogState.isUnavailable = false;
    catalogState.error = null;
    catalogState.refetch.mockReset();
    EMPTY_MISSING_IDS.length = 0;
    catalogHookCalls.selectedIds = [];
    nativeAlertState.alert.mockReset();
    keyboardState.dismiss.mockReset();
    backHandlerState.listeners.clear();
    animatedState.hold = false;
    animatedState.pending.length = 0;
    aiDataConsentState.ensure.mockReset().mockResolvedValue(true);
    vi.mocked(pickAudioDocument).mockReset();
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
    EMPTY_MISSING_IDS.push(remoteImageModel.id);
    expect(() => {
      renderer.act(() => {
        tree!.update(<MediaCreationScreen initialTool="image" />);
      });
    }).not.toThrow();

    expect(collectText(tree!.root)).toContain('Choose another model');
    expect(collectText(tree!.root)).toContain('This model is no longer available. Your draft is saved; choose another model.');
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

  it('uses the published default for an untouched new draft', async () => {
    const catalog = createTestGenerationModelCatalog();
    catalog.models = catalog.models.filter((model) => model.id !== 'nano-banana-2');
    catalog.defaults.image = 'nano-banana-pro';
    catalogState.catalog = catalog;
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });

    const text = collectText(tree!.root);
    expect(text).not.toContain('Your previous image model is no longer available. Switched to Nano Banana Pro.');
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

  describe('a guided first video', () => {
    const quotedModels = () => authState.api.quoteGenerationModel.mock.calls.map(([request]) => (request as { modelId: string }).modelId);

    it('starts on the starter and quotes it inside the welcome credits, never the default first', async () => {
      vi.useFakeTimers();
      catalogState.catalog = createTestGenerationModelCatalog([seedance15ProModel]);
      quoteEchoingSettings(14);
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(quotedModels()).toEqual(['seedance-1.5-pro']);
      expect(authState.api.quoteGenerationModel.mock.calls[0][0]).toMatchObject({
        settings: { resolution: '720p', duration: '4', sound: false },
      });
      expect(collectText(tree!.root)).toContain('Seedance 1.5 Pro');
      expect(collectText(tree!.root).some((item) => item.includes('14 credits'))).toBe(true);
      vi.useRealTimers();
    });

    it('is the only creator that starts there: an ordinary one keeps the catalog default', async () => {
      vi.useFakeTimers();
      catalogState.catalog = createTestGenerationModelCatalog([seedance15ProModel]);
      quoteEchoingSettings(70);
      renderer.act(() => {
        renderer.create(<MediaCreationScreen initialTool="video" insideTab />);
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(quotedModels()).toEqual(['kling-3.0-video']);
    });

    it('waits for the starter details, and takes the default once the catalog says it is gone', async () => {
      vi.useFakeTimers();
      catalogState.catalog = createTestGenerationModelCatalog();
      quoteEchoingSettings(70);
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(quotedModels()).toEqual([]);

      catalogState.catalog = createTestGenerationModelCatalog();
      EMPTY_MISSING_IDS.push(seedance15ProModel.id);
      renderer.act(() => {
        tree!.update(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(quotedModels()).toEqual(['kling-3.0-video']);
      expect(collectText(tree!.root)).not.toContain('This model is no longer available. Your draft is saved; choose another model.');
    });

    it('keeps the starter when a prompt is typed before its details arrive, with no settings notice', async () => {
      vi.useFakeTimers();
      catalogState.catalog = createTestGenerationModelCatalog();
      quoteEchoingSettings(14);
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      renderer.act(() => {
        tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('A lighthouse in a storm');
      });

      catalogState.catalog = createTestGenerationModelCatalog([seedance15ProModel]);
      renderer.act(() => {
        tree!.update(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(quotedModels()).toEqual(['seedance-1.5-pro']);
      expect(authState.api.quoteGenerationModel.mock.calls[0][0]).toMatchObject({
        settings: { resolution: '720p', duration: '4', sound: false },
      });
      expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('A lighthouse in a storm');
      expect(collectText(tree!.root).some((item) => item.includes('no longer supported'))).toBe(false);
    });

    it('asks for the starter details only while the guided draft can still take them', () => {
      catalogState.catalog = createTestGenerationModelCatalog();
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      expect(catalogHookCalls.selectedIds).toContain('seedance-1.5-pro');

      // Gone from the catalog: the draft settles on the default and lets the starter go, which
      // would otherwise keep the creator "unavailable" through any later catalog error.
      catalogState.catalog = createTestGenerationModelCatalog();
      EMPTY_MISSING_IDS.push(seedance15ProModel.id);
      renderer.act(() => {
        tree!.update(<MediaCreationScreen initialTool="video" insideTab guided />);
      });
      expect(catalogHookCalls.selectedIds).toContain('kling-3.0-video');
      expect(catalogHookCalls.selectedIds).not.toContain('seedance-1.5-pro');
    });

    it('leaves the video draft on the catalog default in a guided image session', async () => {
      vi.useFakeTimers();
      catalogState.catalog = createTestGenerationModelCatalog([seedance15ProModel]);
      quoteEchoingSettings(8);
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab guided />);
      });
      const videoTab = tree!.root.findAll((node) => (
        node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === 'Video' && typeof node.props.onPress === 'function'
      ))[0];
      renderer.act(() => {
        videoTab.props.onPress();
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(quotedModels()).toContain('kling-3.0-video');
      expect(quotedModels()).not.toContain('seedance-1.5-pro');
    });
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
    // Frames and references are no longer an either/or, so nothing claims one shape per
    // run unless the provider actually forks. (This fixture's catalog is legacy-shaped and
    // declares no reference slots for the default video model, so the rail itself is
    // covered by the web E2E and by the simulator check, not here.)
    expect(collectText(tree!.root)).not.toContain('one per run');
    renderer.act(() => {
      findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
    });
    expect(collectText(tree!.root)).not.toContain('Choose model');
  });

  it('uploads every reusable media type from a mode-gated video model', async () => {
    const catalog = catalogV2();
    const model = catalog.models.find((candidate) => candidate.id === 'fallback-video-v2')!;
    const referenceMode = model.inputModes?.find((mode) => mode.key === 'elements')!;
    referenceMode.slots.push({
      key: 'audioReferences',
      kind: 'audio',
      role: 'reference',
      label: 'Reference audio',
      min: 0,
      max: 3,
      durationMetadata: 'optional',
    });
    catalogState.catalog = catalog;
    vi.mocked(pickMediaList).mockResolvedValue([
      { uri: 'file:///product.png', fileName: 'product.png', mimeType: 'image/png', fileSize: 2048 } as never,
    ]);
    vi.mocked(pickMedia).mockResolvedValue({
      uri: 'file:///motion.mp4',
      fileName: 'motion.mp4',
      mimeType: 'video/mp4',
      fileSize: 4096,
      duration: 5000,
    } as never);
    vi.mocked(pickAudioDocument).mockResolvedValue({
      uri: 'file:///voice.mp3',
      name: 'voice.mp3',
      mimeType: 'audio/mpeg',
      size: 1024,
    } as never);
    vi.mocked(uploadPickedMedia)
      .mockResolvedValueOnce({
        signedUrl: 'https://cdn.example.com/reference.png',
        storagePath: 'uploads/user/reference.png',
        mimeType: 'image/png',
        fileName: 'product.png',
        kind: 'image',
        durationSeconds: null,
        sizeBytes: 2048,
      })
      .mockResolvedValueOnce({
        signedUrl: 'https://cdn.example.com/reference.mp4',
        storagePath: 'uploads/user/reference.mp4',
        mimeType: 'video/mp4',
        fileName: 'motion.mp4',
        kind: 'video',
        durationSeconds: 5,
        sizeBytes: 4096,
      })
      .mockResolvedValueOnce({
        signedUrl: 'https://cdn.example.com/reference.mp3',
        storagePath: 'uploads/user/reference.mp3',
        mimeType: 'audio/mpeg',
        fileName: 'voice.mp3',
        kind: 'audio',
        durationSeconds: null,
        sizeBytes: 1024,
      });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Images 0/5').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Video 0/3').props.onPress();
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Audio 0/3').props.onPress();
    });

    expect(pickMediaList).toHaveBeenCalledTimes(1);
    expect(pickMedia).toHaveBeenCalledTimes(1);
    expect(pickAudioDocument).toHaveBeenCalledTimes(1);
    const text = collectText(tree!.root);
    expect(text).not.toContain('This model does not support image references.');
    expect(text).not.toContain('This model does not support reference videos.');
    expect(text).not.toContain('This model does not support audio references.');
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

  it('offers a visible exit and anchors the persistent controls to the safe area in the focused tab workspace', async () => {
    const onClose = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab onClose={onClose} />);
    });

    const close = tree!.root.findByProps({ accessibilityLabel: 'Close creator' });
    expect(close.props.accessibilityHint).toContain('Saves your changes');
    await renderer.act(async () => { close.props.onPress(); });
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
        ['Reference', 'Templates', 'Enhance · 2 credits'].includes(node.props.accessibilityLabel) &&
        node.props.style?.minHeight === 60,
    );
    expect(actionColumns).toHaveLength(3);
    const referenceRail = tree!.root.findByProps({ testID: 'image-reference-rail' });
    expect(referenceRail.props.style).not.toEqual(expect.objectContaining({ borderTopWidth: expect.any(Number) }));
  });

  it('flushes the last keystroke before Close, without waiting for the autosave delay', async () => {
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" initialPrompt="seed" onClose={onClose} />); });
    renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('last keystroke'); });
    await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Close creator' }).props.onPress(); });
    expect(JSON.parse(draftStorage.setItem.mock.lastCall![1]).image.prompt).toBe('last keystroke');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(draftStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  // The route hangs the native back gesture off this: a pop that beats the
  // close guard would skip the flush, so an edited session has to say so.
  it('reports the first edit, and says nothing for a session only looked at', async () => {
    const onDirtyChange = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" initialPrompt="seed" onClose={vi.fn()} onDirtyChange={onDirtyChange} />); });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('an edit'); });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('closes an untouched editor without a storage write or discard prompt', async () => {
    draftStorage.setItem.mockRejectedValue(new Error('disk full'));
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" initialPrompt="seed" onClose={onClose} />); });
    await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Close creator' }).props.onPress(); });
    expect(draftStorage.setItem).not.toHaveBeenCalled();
    expect(nativeAlertState.alert).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays in the editor when saving fails and the reader keeps editing', async () => {
    draftStorage.setItem.mockRejectedValue(new Error('disk full'));
    nativeAlertState.alert.mockImplementation((_title, _message, actions) => actions[0].onPress());
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" initialPrompt="seed" onClose={onClose} />); });
    renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('unsaved work'); });
    await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Close creator' }).props.onPress(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(collectText(tree.root)).toContain('Draft not saved');
  });

  // Audit A5. The ordinary Create draft was one key for the whole phone, so
  // whoever signed in next opened the last person's prompt and references.
  // Remix sessions were already kept per account.
  describe('a phone shared by more than one identity', () => {
    const PHONE_WIDE_DRAFT_KEY = 'magicbooklet.creation.drafts.v1';
    const memory = new Map<string, string>();
    const signInAs = (id: string, signedInAt = '2026-09-16T09:00:00.000Z') => {
      authState.user = { id, email: `${id}@example.com` };
      authState.identityUserId = id;
      authState.session = { user: { id, last_sign_in_at: signedInAt } };
    };
    const promptOf = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value;
    const type = (tree: renderer.ReactTestRenderer, text: string) => renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText(text);
    });
    // Past the autosave delay, and past every storage read a load makes.
    const settle = () => renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    const keysHolding = (text: string) => [...memory.entries()].filter(([, value]) => value.includes(text)).map(([key]) => key);
    const phoneWideDraft = (prompt: string, updatedAt: string) => JSON.stringify({
      image: { ...createDefaultCreationDraft('image'), prompt },
      video: createDefaultCreationDraft('video'),
      motion: createDefaultCreationDraft('motion'),
      updatedAt,
    });

    beforeEach(() => {
      memory.clear();
      draftStorage.getItem.mockImplementation(async (key: string) => memory.get(key) ?? null);
      draftStorage.setItem.mockImplementation(async (key: string, value: string) => { memory.set(key, value); });
      draftStorage.removeItem.mockImplementation(async (key: string) => { memory.delete(key); });
    });

    it("never opens one account's draft for the next account", async () => {
      signInAs('account-a');
      let tab!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tab = renderer.create(<MediaCreationScreen initialTool="image" insideTab />); });
      await settle();
      type(tab, 'account A private prompt');
      await settle();
      expect(keysHolding('account A private prompt')).toHaveLength(1);

      // The Create tab stays mounted through a sign-out and the next sign-in.
      signInAs('account-b');
      await renderer.act(async () => { tab.update(<MediaCreationScreen initialTool="image" insideTab />); });
      await settle();
      expect(promptOf(tab)).toBe('');

      let opened!: renderer.ReactTestRenderer;
      await renderer.act(async () => { opened = renderer.create(<MediaCreationScreen initialTool="image" />); });
      await settle();
      expect(promptOf(opened)).toBe('');
      type(opened, 'account B prompt');
      await settle();
      expect(keysHolding('account B prompt')).toHaveLength(1);
      expect(keysHolding('account A private prompt')).toHaveLength(1);
      expect(keysHolding('account B prompt')[0]).not.toBe(keysHolding('account A private prompt')[0]);

      // Account A's draft is still there, for account A.
      signInAs('account-a');
      let back!: renderer.ReactTestRenderer;
      await renderer.act(async () => { back = renderer.create(<MediaCreationScreen initialTool="image" />); });
      await settle();
      expect(promptOf(back)).toBe('account A private prompt');
    });

    it('keeps what was typed with no identity for the person who then gets one', async () => {
      authState.user = null;
      authState.identityUserId = null;
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />); });
      await settle();
      type(tree, 'typed while signed out');
      await settle();
      // There is no one to keep it for yet, so it is written nowhere.
      expect(keysHolding('typed while signed out')).toEqual([]);

      // Signing in from Generate, or the guest session arriving once the phone is online.
      signInAs('account-a');
      await renderer.act(async () => { tree.update(<MediaCreationScreen initialTool="image" insideTab />); });
      await settle();
      expect(promptOf(tree)).toBe('typed while signed out');
      expect(keysHolding('typed while signed out')).toEqual([expect.stringContaining('account-a')]);
    });

    it('resumes a phone-wide draft from an older build only for the session that saved it', async () => {
      // Saved at 08:00, and account B signed in at 09:00: someone else wrote it.
      memory.set(PHONE_WIDE_DRAFT_KEY, phoneWideDraft('the last person’s prompt', '2026-09-16T08:00:00.000Z'));
      signInAs('account-b', '2026-09-16T09:00:00.000Z');
      let next!: renderer.ReactTestRenderer;
      await renderer.act(async () => { next = renderer.create(<MediaCreationScreen initialTool="image" />); });
      await settle();
      expect(promptOf(next)).toBe('');
      expect(keysHolding('the last person’s prompt')).toEqual([]);

      // Saved at 09:30, inside a session that signed in at 09:00: it is theirs, and moves under their key.
      memory.set(PHONE_WIDE_DRAFT_KEY, phoneWideDraft('my own unfinished prompt', '2026-09-16T09:30:00.000Z'));
      signInAs('account-c', '2026-09-16T09:00:00.000Z');
      let own!: renderer.ReactTestRenderer;
      await renderer.act(async () => { own = renderer.create(<MediaCreationScreen initialTool="image" />); });
      await settle();
      expect(promptOf(own)).toBe('my own unfinished prompt');
      expect(keysHolding('my own unfinished prompt')).toEqual([expect.stringContaining('account-c')]);
    });
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

  it('preserves edits saved before a previous source restore finished', async () => {
    draftStorage.getItem.mockResolvedValue(JSON.stringify({
      image: { ...createDefaultCreationDraft('image'), prompt: 'Saved while the source was loading' },
      video: createDefaultCreationDraft('video'), motion: createDefaultCreationDraft('motion'),
      remixRestored: false, remixEditedKeys: { image: ['prompt'] }, updatedAt: '2026-08-30T00:00:00Z',
    }));
    authState.api.getRemixSourceBundle.mockResolvedValue({ generation: { id: 'gen-1', title: 'Source', prompt: 'Source prompt', category: 'image', model: 'nano-banana-2' }, result: null, inputs: { image: { elements: [] } }, workflowSettings: { model: 'nano-banana-2' }, restoreIssues: [] });
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" remixSource={{ generationId: 'gen-1', postId: 'post-1' }} />); });
    expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(1);
    expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('Saved while the source was loading');
  });

  it('restarts a cancelled restore when the catalog refreshes, instead of hanging', async () => {
    const source = { generation: { id: 'gen-1', title: 'Source', prompt: 'Restored prompt', category: 'image', model: 'nano-banana-2' }, result: null, inputs: { image: { elements: [] } }, workflowSettings: { model: 'nano-banana-2' }, restoreIssues: [] };
    authState.api.getRemixSourceBundle.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(source);
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" remixSource={{ generationId: 'gen-1', postId: 'post-1' }} />); });
    expect(collectText(tree.root)).toContain('Restoring the original prompt, settings, and references…');
    await renderer.act(async () => {
      catalogState.catalog = createTestGenerationModelCatalog();
      tree.update(<MediaCreationScreen initialTool="image" remixSource={{ generationId: 'gen-1', postId: 'post-1' }} />);
    });
    expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(2);
    expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('Restored prompt');
    expect(collectText(tree.root)).not.toContain('Restoring the original prompt, settings, and references…');
  });

  // The Seedance 2 family takes a reference prepared with the provider once (an asset
  // id in place of the link on every run), which the web creator has offered since the
  // family shipped and the native creator sent as `seedanceAssets: null`.
  describe('Seedance assets on the native creator', () => {
    const element = { id: 'girl', displayName: 'Girl', handle: '@girl', url: 'https://cdn.example.com/girl.png', storagePath: 'generation_inputs/owner/gen-girl/girl.png', sourceGenerationId: null };
    const voice = { kind: 'audio', label: 'Voice', url: 'https://cdn.example.com/voice.mp3', storagePath: 'generation_inputs/owner/gen-girl/voice.mp3', sourceGenerationId: null };
    const remixOf = (model: string) => ({
      generation: { id: 'gen-girl', title: 'Original', prompt: 'The girl from @girl is crying', category: 'video', model },
      result: null,
      inputs: { video: { referenceMode: 'elements', startFrame: null, endFrame: null, elements: [element], referenceVideos: [], referenceAudios: [voice] } },
      workflowSettings: { model, referenceMode: 'elements', duration: 4, aspectRatio: '16:9', resolution: '480p' },
      restoreIssues: [],
    });
    const assetAnswer = (status: 'processing' | 'active' | 'failed', assetType: 'Image' | 'Audio') => ({
      success: true, assetId: assetType === 'Image' ? 'asset-girl' : 'asset-voice', assetType, status, rawStatus: status, error: null, sourceUrl: null, lastCheckedAt: '2026-10-08T00:00:00.000Z',
    });
    const settle = () => renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    const openEditor = async (model: string) => {
      // The production descriptors, plus a copy of Seedance 2 under another id: a model
      // with the same slots that is not in the family. Seedance 2 carries its published
      // input modes, which is what the unified request reads its inputs from.
      const catalog = createRemixRestoreCatalog();
      const seedance = { ...catalog.models.find((entry) => entry.id === 'seedance-2')!, inputModes: seedanceInputModes() };
      catalogState.catalog = {
        ...catalog,
        models: [...catalog.models.filter((entry) => entry.id !== 'seedance-2'), seedance, { ...seedance, id: 'wan-2.7', displayName: 'Wan 2.7' }],
      };
      authState.api.getRemixSourceBundle.mockResolvedValue(remixOf(model));
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="video" remixSource={{ generationId: 'gen-girl', postId: 'post-girl' }} />); });
      await settle();
      return tree;
    };
    /** Everything on screen as one string: a status line is a sentence, not a word. */
    const text = (tree: renderer.ReactTestRenderer) => collectText(tree.root).join('\n');
    const press = (tree: renderer.ReactTestRenderer, label: string) => renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: label }).props.onPress();
    });

    it('prepares a Seedance 2 reference from its details sheet, checks on it, and sends the asset id on the run', async () => {
      // The quote answers with settings that name no input mode (this suite's default answer).
      // The run takes its references shape from the draft, as its quote request did: read back
      // from this answer, it went out as a frames run and left the prepared reference out.
      authState.api.createSeedanceAsset.mockResolvedValue(assetAnswer('processing', 'Image'));
      authState.api.getSeedanceAsset.mockResolvedValue(assetAnswer('active', 'Image'));
      const tree = await openEditor('seedance-2');
      expect(text(tree)).toContain('Open a reference to prepare it with Seedance once.');

      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Open details for Girl' }).props.onPress(); });
      expect(tree.root.findAllByProps({ testID: 'seedance-asset-row' })).not.toHaveLength(0);
      expect(text(tree)).toContain('Not prepared.');

      await press(tree, 'Prepare for Seedance for Girl');
      // The creator's own file goes by its storage path; the server resolves and owns it.
      expect(authState.api.createSeedanceAsset).toHaveBeenCalledWith({ url: 'generation_inputs/owner/gen-girl/girl.png', assetType: 'Image' });
      expect(text(tree)).toContain('Seedance is processing the file.');

      await press(tree, 'Check status for Girl');
      expect(authState.api.getSeedanceAsset).toHaveBeenCalledWith('asset-girl');
      expect(text(tree)).toContain('Ready. Runs send the prepared asset in place of the file.');

      // The run sends the prepared id beside the link the server measures (C3).
      authState.api.startGeneration.mockResolvedValue({ predictionId: 'pred-1', status: 'starting' } as never);
      await press(tree, 'Close reference details');
      await settle();
      await renderer.act(async () => { findPressableByLabelPrefix(tree.root, 'Generate ·').props.onPress(); });
      await settle();
      expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
      expect(authState.api.startGeneration.mock.calls[0][0]).toMatchObject({
        modelId: 'seedance-2',
        settings: expect.objectContaining({ referenceMode: 'elements', duration: 4 }),
        inputs: expect.arrayContaining([
          expect.objectContaining({ slot: 'imageReferences', url: 'https://cdn.example.com/girl.png', assetId: 'asset-girl' }),
        ]),
      });
      expect(authState.api.startVideoGeneration).not.toHaveBeenCalled();
      tree.unmount();
    });

    it('prepares an audio reference from its tile, and shows a refusal as failed on that reference', async () => {
      authState.api.createSeedanceAsset.mockRejectedValue(new Error('Asset media must belong to the authenticated user.'));
      const tree = await openEditor('seedance-2');

      await press(tree, 'Prepare for Seedance for Voice');
      expect(authState.api.createSeedanceAsset).toHaveBeenCalledWith({ url: 'generation_inputs/owner/gen-girl/voice.mp3', assetType: 'Audio' });
      const retry = tree.root.findByProps({ accessibilityLabel: 'Try again for Voice' });
      expect(collectText(retry).join(' ')).toContain('Retry');
      // The picture beside it is untouched.
      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Open details for Girl' }).props.onPress(); });
      expect(text(tree)).toContain('Not prepared.');
      tree.unmount();
    });

    // Preparing sends the file to the AI service as a run does. It was the one way there
    // that skipped the question: someone who declined, or withdrew in Settings, still
    // sent their photo, video or audio with one tap.
    it('asks before a reference is prepared, and sends nothing when the person declines', async () => {
      aiDataConsentState.ensure.mockResolvedValue(false);
      authState.api.createSeedanceAsset.mockResolvedValue(assetAnswer('processing', 'Image'));
      const tree = await openEditor('seedance-2');

      // From the details sheet, and from an audio tile, which has none.
      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Open details for Girl' }).props.onPress(); });
      await press(tree, 'Prepare for Seedance for Girl');
      await press(tree, 'Prepare for Seedance for Voice');
      expect(aiDataConsentState.ensure).toHaveBeenCalledTimes(2);
      expect(authState.api.createSeedanceAsset).not.toHaveBeenCalled();
      // Left as it was, and free to press again.
      expect(text(tree)).toContain('Not prepared.');
      expect(tree.root.findByProps({ accessibilityLabel: 'Prepare for Seedance for Girl' }).props.disabled).toBe(false);

      // Allowed on the next press, the file goes.
      aiDataConsentState.ensure.mockResolvedValue(true);
      await press(tree, 'Prepare for Seedance for Girl');
      expect(aiDataConsentState.ensure).toHaveBeenCalledTimes(3);
      expect(authState.api.createSeedanceAsset).toHaveBeenCalledTimes(1);
      expect(authState.api.createSeedanceAsset).toHaveBeenCalledWith({ url: 'generation_inputs/owner/gen-girl/girl.png', assetType: 'Image' });
      expect(text(tree)).toContain('Seedance is processing the file.');
      tree.unmount();
    });

    it('offers no Seedance asset on a model outside the family', async () => {
      const tree = await openEditor('wan-2.7');
      expect(text(tree)).not.toContain('Open a reference to prepare it with Seedance once.');
      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Open details for Girl' }).props.onPress(); });
      expect(tree.root.findAllByProps({ testID: 'seedance-asset-row' })).toHaveLength(0);
      tree.unmount();
    });
  });

  // The "Restoring…" state belongs to one run of the restore, and a run that has been cancelled
  // can no longer clear it. The run that follows usually restores again and takes the state over.
  // When that run has nothing to do, the cancelled one has to hand the state back itself, or the
  // banner stays up, Generate stays off and autosave stops for as long as the editor is open.
  describe('a remix restore that is cancelled', () => {
    const RESTORING = 'Restoring the original prompt, settings, and references…';
    const source = {
      generation: { id: 'gen-girl', title: 'Original', prompt: 'The girl from @girl is crying', category: 'video', model: 'seedance-2' },
      result: null,
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [{ id: 'girl', displayName: 'Girl', handle: '@girl', url: 'https://cdn.example.com/girl.png', storagePath: 'generation_inputs/owner/gen-girl/girl.png', sourceGenerationId: 'gen-girl' }],
          referenceVideos: [],
          referenceAudios: [],
        },
      },
      workflowSettings: { model: 'seedance-2', mode: '', aspectRatio: '9:16', resolution: '480p', duration: 4, sound: false, referenceMode: 'elements' },
      restoreIssues: [],
    };
    /** That remix as an earlier session left it: restored, then the prompt rewritten. */
    const savedRemix = JSON.stringify({
      image: createDefaultCreationDraft('image'),
      video: {
        ...createDefaultCreationDraft('video'),
        model: 'seedance-2',
        prompt: 'My edited scene: @girl is crying',
        aspectRatio: '9:16',
        resolution: '480p',
        duration: 4,
        references: [{ id: 'girl', kind: 'image', url: 'https://cdn.example.com/girl.png', storagePath: 'generation_inputs/owner/gen-girl/girl.png', fileName: 'girl.png', displayName: 'Girl', handle: '@girl', sourceGenerationId: 'gen-girl' }],
      },
      motion: createDefaultCreationDraft('motion'),
      updatedAt: '2026-10-04T00:00:00.000Z',
      remixRestored: true,
      remixEditedKeys: { video: ['prompt'] },
    });
    const editor = () => <MediaCreationScreen initialTool="video" remixSource={{ generationId: 'gen-girl', postId: 'post-girl' }} />;
    // Past the quote's delay and the autosave's, and past every storage read a load makes.
    const settle = () => renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    const promptOf = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value;
    const generate = (tree: renderer.ReactTestRenderer) => findPressableByLabelPrefix(tree.root, 'Generate ·');
    const savedDraftReads = () => draftStorage.getItem.mock.calls.filter(([key]) => String(key).startsWith('magicbooklet.creation.drafts')).length;

    beforeEach(() => {
      catalogState.catalog = createRemixRestoreCatalog();
    });

    it('takes the restoring banner down when every effect runs again over a resumed remix', async () => {
      draftStorage.getItem.mockResolvedValue(savedRemix);
      authState.api.getRemixSourceBundle.mockResolvedValue(source);
      // React runs every effect of a subtree again, with its state kept, when a hidden
      // <Activity> is shown. Fast Refresh does the same to this screen after an edit to its
      // module, which is how the stuck banner was first met.
      const inActivity = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}>{editor()}</React.Activity>;
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(inActivity('visible')); });
      await settle();
      expect(savedDraftReads()).toBe(1);
      expect(authState.api.getRemixSourceBundle).not.toHaveBeenCalled();
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(false);

      await renderer.act(async () => { tree.update(inActivity('hidden')); });
      await renderer.act(async () => { tree.update(inActivity('visible')); });
      await settle();

      // The saved draft was read a second time, so the effects did run again.
      expect(savedDraftReads()).toBe(2);
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(false);
      // Still the session as it was saved, not the source restored over it.
      expect(promptOf(tree)).toBe('My edited scene: @girl is crying');
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Open details for Girl' })).not.toHaveLength(0);
    });

    it('takes the restoring banner down when the draft is resumed first and a new catalog then cancels the read', async () => {
      draftStorage.getItem.mockResolvedValue(savedRemix);
      // The read that starts on the stale state never answers: only cancelling it can end it.
      authState.api.getRemixSourceBundle.mockReturnValue(new Promise(() => {}));
      const inActivity = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}>{editor()}</React.Activity>;
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(inActivity('visible')); });
      await settle();
      await renderer.act(async () => { tree.update(inActivity('hidden')); });

      // The order the Pixel_9a emulator runs it in. There the saved draft is back before React
      // renders `draftsHydrated` false, so that false never reaches the screen and the stale read
      // is still out when the draft is marked resumed. `act` always renders the reset first.
      // Outside it the scheduler renders in the same task only while the task is under 5 ms old,
      // so a storage call that holds the effect flush for 12 ms makes it yield, and the draft's
      // answer gets in ahead of the render.
      draftStorage.getItem.mockImplementation(() => {
        const until = performance.now() + 12;
        while (performance.now() < until) { /* hold the effect flush */ }
        return Promise.resolve(savedRemix);
      });
      tree.update(inActivity('visible'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The stale read is out and nothing has cancelled it. If this stops holding, the reset has
      // rendered first and this case no longer tests the order it is named for.
      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(1);
      expect(collectText(tree.root)).toContain(RESTORING);

      // On the device the read is cancelled by the catalog arriving as a new object.
      await renderer.act(async () => {
        catalogState.catalog = createRemixRestoreCatalog();
        tree.update(inActivity('visible'));
      });
      await settle();

      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(false);
      expect(promptOf(tree)).toBe('My edited scene: @girl is crying');
    });

    it('resumes a saved remix when the account arrives after the editor has opened', async () => {
      // A link that opens the editor at a cold start can beat the stored session.
      authState.user = null;
      authState.identityUserId = null;
      draftStorage.getItem.mockResolvedValue(savedRemix);
      authState.api.getRemixSourceBundle.mockResolvedValue(source);
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();
      expect(savedDraftReads()).toBe(0);

      authState.user = { id: 'user-123', email: 'creator@example.com' };
      authState.identityUserId = 'user-123';
      await renderer.act(async () => { tree.update(editor()); });
      await settle();

      expect(savedDraftReads()).toBe(1);
      expect(authState.api.getRemixSourceBundle).not.toHaveBeenCalled();
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(false);
      expect(promptOf(tree)).toBe('My edited scene: @girl is crying');
    });

    it('keeps the restore on screen while a catalog refresh starts it again', async () => {
      let releaseSource: (value: unknown) => void = () => {};
      authState.api.getRemixSourceBundle
        .mockReturnValueOnce(new Promise(() => {}))
        .mockReturnValueOnce(new Promise((resolve) => { releaseSource = resolve; }));
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      expect(collectText(tree.root)).toContain(RESTORING);

      await renderer.act(async () => {
        catalogState.catalog = createRemixRestoreCatalog();
        tree.update(editor());
      });
      await settle();
      // The first read was abandoned and a second one is out: still restoring.
      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(2);
      expect(collectText(tree.root)).toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(true);

      await renderer.act(async () => {
        releaseSource(source);
        await Promise.resolve();
      });
      await settle();
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(promptOf(tree)).toBe('The girl from @girl is crying');
      expect(generate(tree).props.disabled).toBe(false);
    });

    it('retries a failed restore from its banner', async () => {
      authState.api.getRemixSourceBundle
        .mockRejectedValueOnce(new Error('The source could not be read.'))
        .mockResolvedValue(source);
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();
      expect(collectText(tree.root)).toContain('The source could not be read.');
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(true);

      await renderer.act(async () => { findPressableByText(tree.root, 'Retry restore').props.onPress(); });
      await settle();

      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(2);
      expect(collectText(tree.root)).not.toContain('The source could not be read.');
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(promptOf(tree)).toBe('The girl from @girl is crying');
      expect(generate(tree).props.disabled).toBe(false);
    });

    it('lets the creator go on with the inputs they have after a failed restore', async () => {
      authState.api.getRemixSourceBundle.mockRejectedValue(new Error('The source could not be read.'));
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('A scene of my own');
      });
      await settle();
      expect(generate(tree).props.disabled).toBe(true);

      await renderer.act(async () => { findPressableByText(tree.root, 'Use available inputs').props.onPress(); });
      await settle();

      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(1);
      expect(collectText(tree.root)).not.toContain('The source could not be read.');
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(promptOf(tree)).toBe('A scene of my own');
      expect(generate(tree).props.disabled).toBe(false);
    });
  });

  // D4: a guest restores the source of its own or a linked creation; the server keeps
  // another creator's for accounts and answers a guest 403 REGISTRATION_REQUIRED.
  describe('a remix restore for a guest (D4)', () => {
    const SIGN_IN_LINE = 'Sign in to restore remix source media.';
    const RESTORING = 'Restoring the original prompt, settings, and references…';
    const source = { generation: { id: 'gen-1', title: 'Source', prompt: 'Restored prompt', category: 'image', model: 'nano-banana-2' }, result: null, inputs: { image: { elements: [] } }, workflowSettings: { model: 'nano-banana-2' }, restoreIssues: [] };
    const accountsOnly = () => new ApiError(
      'Create an account to use this feature.',
      403,
      { error: 'Create an account to use this feature.', code: 'REGISTRATION_REQUIRED' },
      undefined,
      'REGISTRATION_REQUIRED',
    );
    const editor = () => <MediaCreationScreen initialTool="image" remixSource={{ generationId: 'gen-1', postId: 'post-1' }} />;
    // Past the quote's delay and the autosave's, and past every storage read a load makes.
    const settle = () => renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    const promptOf = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value;
    const generate = (tree: renderer.ReactTestRenderer) => findPressableByLabelPrefix(tree.root, 'Generate ·');

    beforeEach(() => {
      authState.user = null;
      authState.identityUserId = 'guest-1';
      authState.isGuest = true;
    });

    it('restores the source of the guest’s own creation', async () => {
      authState.api.getRemixSourceBundle.mockResolvedValue(source);
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();

      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledWith('gen-1', { postId: 'post-1' });
      expect(promptOf(tree)).toBe('Restored prompt');
      expect(collectText(tree.root)).not.toContain(SIGN_IN_LINE);
      expect(collectText(tree.root)).not.toContain(RESTORING);
      expect(generate(tree).props.disabled).toBe(false);
    });

    it('says to sign in for another creator’s source, and leaves Generate to what the editor holds', async () => {
      authState.api.getRemixSourceBundle.mockRejectedValue(accountsOnly());
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('A scene of my own');
      });
      await settle();

      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(1);
      const text = collectText(tree.root);
      expect(text).toContain(SIGN_IN_LINE);
      expect(text).not.toContain('Create an account to use this feature.');
      expect(text).not.toContain(RESTORING);
      // Who may read the source, not a failed restore: Generate is not held for it.
      expect(promptOf(tree)).toBe('A scene of my own');
      expect(generate(tree).props.disabled).toBe(false);
      expect(readCreatorSession()?.outcome).not.toBe('restore_failed');
    });

    it('reads nothing, and says to sign in, with no identity at all', async () => {
      authState.identityUserId = null;
      authState.isGuest = false;
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();

      expect(authState.api.getRemixSourceBundle).not.toHaveBeenCalled();
      expect(collectText(tree.root)).toContain(SIGN_IN_LINE);
    });

    // A retry would get the same answer: signing in is the way on, back to this remix.
    it.each([
      ['another creator’s source', () => { authState.api.getRemixSourceBundle.mockRejectedValue(accountsOnly()); }],
      ['no identity at all', () => { authState.identityUserId = null; authState.isGuest = false; }],
    ])('offers Sign in under the sign-in line for %s, in place of a retry', async (_label, arrange) => {
      arrange();
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();
      expect(collectText(tree.root)).toContain(SIGN_IN_LINE);
      expect(() => findPressableByText(tree.root, 'Retry restore')).toThrow();
      const reads = authState.api.getRemixSourceBundle.mock.calls.length;

      await renderer.act(async () => { findPressableByText(tree.root, 'Sign in').props.onPress(); });

      expect(routerState.push).toHaveBeenCalledTimes(1);
      expect(routerState.push).toHaveBeenCalledWith({
        pathname: '/auth',
        params: { returnTo: '/create/image?remix=gen-1&remixPost=post-1' },
      });
      // Nothing is read again until the identity changes.
      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(reads);
      // The other way on stays: the creator's own inputs.
      expect(findPressableByText(tree.root, 'Use available inputs')).toBeTruthy();
    });

    it('offers a retry, and no sign-in, for a restore that failed', async () => {
      authState.api.getRemixSourceBundle.mockRejectedValue(new Error('The source could not be read.'));
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(editor()); });
      await settle();

      expect(collectText(tree.root)).toContain('The source could not be read.');
      expect(findPressableByText(tree.root, 'Retry restore')).toBeTruthy();
      expect(() => findPressableByText(tree.root, 'Sign in')).toThrow();
    });
  });

  // The catalog reaches the screen after it mounts, so a restore usually starts in the same commit
  // as the catalog's first normalization of the default drafts, or after it. These cases deliver it
  // that way. Each update renders a fresh element: re-rendering the same element object lets React
  // skip the screen, and the catalog would never arrive.
  describe('remix restore while the catalog is still loading', () => {
    const girlSource = {
      generation: { id: 'gen-girl', title: 'The girl from @girl is crying', prompt: 'The girl from @girl is crying', category: 'video', model: 'seedance-2' },
      result: null,
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [{ id: 'element-girl', displayName: 'Girl', handle: '@girl', url: 'https://cdn.example.com/girl.png', storagePath: 'generation_inputs/owner/gen-girl/girl.png', sourceGenerationId: 'gen-girl' }],
          referenceVideos: [],
          referenceAudios: [],
        },
      },
      workflowSettings: { model: 'seedance-2', mode: '', aspectRatio: '9:16', resolution: '480p', duration: 4, sound: false, referenceMode: 'elements' },
      restoreIssues: [],
    };
    const motionSource = {
      generation: { id: 'gen-dance', title: 'Dance', prompt: 'Dance like the reference clip', category: 'video', model: 'kling-2.6' },
      result: null,
      inputs: {
        motion: {
          characterImage: { kind: 'image', url: 'https://cdn.example.com/hero.png', storagePath: 'generation_inputs/owner/gen-dance/hero.png', mediaType: 'image', fileName: 'hero.png' },
          referenceVideo: { kind: 'video', url: 'https://cdn.example.com/moves.mp4', storagePath: 'generation_inputs/owner/gen-dance/moves.mp4', mediaType: 'video', fileName: 'moves.mp4' },
        },
      },
      workflowSettings: { model: 'kling-2.6', mode: '720p', characterOrientation: 'video', duration: 8 },
      restoreIssues: [],
    };
    const imageSource = {
      generation: { id: 'gen-poster', title: 'Poster', prompt: 'A poster of @hero_product on a beach', category: 'image', model: 'gpt-image-2' },
      result: null,
      inputs: {
        image: {
          elements: [{ id: 'element-hero', displayName: 'Hero Product', handle: '@hero_product', url: 'https://cdn.example.com/hero.png', storagePath: 'generation_inputs/owner/gen-poster/hero.png', sourceGenerationId: 'gen-poster' }],
        },
      },
      workflowSettings: { model: 'gpt-image-2', aspectRatio: '9:16', resolution: '2K' },
      restoreIssues: [],
    };

    const creator = (tool: 'image' | 'video' | 'motion', generationId: string) => (
      <MediaCreationScreen initialTool={tool} remixSource={{ generationId, postId: `post-${generationId}` }} />
    );

    const wait = (ms: number) => renderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

    const lastSavedSession = () => {
      const calls = draftStorage.setItem.mock.calls;
      return calls.length ? JSON.parse(calls[calls.length - 1][1] as string) : null;
    };

    /** Mounts before the catalog exists, delivers it, lets a network-delayed source land, then runs one more catalog update. */
    async function restoreWithLateCatalog(
      tool: 'image' | 'video' | 'motion',
      generationId: string,
      source: unknown,
      { sameCommitAsDraftRead = false }: { sameCommitAsDraftRead?: boolean } = {},
    ) {
      catalogState.catalog = null;
      let releaseSource: (value: unknown) => void = () => {};
      authState.api.getRemixSourceBundle.mockReturnValue(new Promise((resolve) => { releaseSource = resolve; }));
      let releaseDraftRead: (value: string | null) => void = () => {};
      if (sameCommitAsDraftRead) {
        draftStorage.getItem.mockReturnValueOnce(new Promise((resolve) => { releaseDraftRead = resolve; }));
      }
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(creator(tool, generationId)); });
      await renderer.act(async () => {
        if (sameCommitAsDraftRead) releaseDraftRead(null);
        catalogState.catalog = createRemixRestoreCatalog();
        tree.update(creator(tool, generationId));
      });
      await renderer.act(async () => {
        releaseSource(source);
        await Promise.resolve();
      });
      await wait(450);
      await renderer.act(async () => {
        catalogState.catalog = createRemixRestoreCatalog();
        tree.update(creator(tool, generationId));
      });
      await wait(450);
      return tree;
    }

    it('restores a Seedance 2 source as it was when the catalog arrives after the saved draft', async () => {
      const tree = await restoreWithLateCatalog('video', 'gen-girl', girlSource);

      expect(collectText(tree.root)).not.toContain('Model updated');
      expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('The girl from @girl is crying');
      const video = lastSavedSession()?.video;
      expect(video).toMatchObject({ model: 'seedance-2', aspectRatio: '9:16' });
      expect(video.catalogSettings).toEqual({ aspectRatio: '9:16', resolution: '480p', duration: 4, sound: false, referenceMode: 'elements' });
    });

    it('restores a Seedance 2 source as it was when the catalog and the saved draft land in one commit', async () => {
      const tree = await restoreWithLateCatalog('video', 'gen-girl', girlSource, { sameCommitAsDraftRead: true });

      expect(collectText(tree.root)).not.toContain('Model updated');
      const video = lastSavedSession()?.video;
      expect(video).toMatchObject({ model: 'seedance-2', aspectRatio: '9:16' });
      expect(video.catalogSettings).toEqual({ aspectRatio: '9:16', resolution: '480p', duration: 4, sound: false, referenceMode: 'elements' });
    });

    it('does not save the catalog defaults as edits when the app leaves while the source loads', async () => {
      catalogState.catalog = null;
      authState.api.getRemixSourceBundle.mockReturnValue(new Promise(() => {}));
      let first!: renderer.ReactTestRenderer;
      await renderer.act(async () => { first = renderer.create(creator('video', 'gen-girl')); });
      await renderer.act(async () => {
        catalogState.catalog = createRemixRestoreCatalog();
        first.update(creator('video', 'gen-girl'));
      });
      const appStateListeners = vi.mocked(AppState.addEventListener).mock.calls;
      const onAppStateChange = appStateListeners[appStateListeners.length - 1][1] as (state: string) => void;
      await renderer.act(async () => {
        onAppStateChange('background');
        await Promise.resolve();
      });

      const interrupted = lastSavedSession();
      expect(interrupted).toMatchObject({ remixRestored: false });
      for (const tool of ['image', 'video', 'motion'] as const) {
        expect(interrupted.remixEditedKeys[tool]).toEqual([]);
      }

      renderer.act(() => { first.unmount(); });
      mountedTrees.splice(mountedTrees.indexOf(first), 1);
      draftStorage.getItem.mockResolvedValue(JSON.stringify(interrupted));
      draftStorage.setItem.mockClear();
      authState.api.getRemixSourceBundle.mockResolvedValue(girlSource);
      let reopened!: renderer.ReactTestRenderer;
      await renderer.act(async () => { reopened = renderer.create(creator('video', 'gen-girl')); });
      await wait(450);
      await renderer.act(async () => {
        catalogState.catalog = createRemixRestoreCatalog();
        reopened.update(creator('video', 'gen-girl'));
      });

      expect(collectText(reopened.root)).not.toContain('Model updated');
      expect(lastSavedSession()?.video).toMatchObject({ model: 'seedance-2', aspectRatio: '9:16' });
    });

    it("keeps a motion source's prompt and inputs when the catalog default model differs from the draft's", async () => {
      await restoreWithLateCatalog('motion', 'gen-dance', motionSource);

      expect(lastSavedSession()?.motion).toMatchObject({
        model: 'kling-2.6',
        prompt: 'Dance like the reference clip',
        duration: 8,
        characterImage: expect.objectContaining({ fileName: 'hero.png' }),
        referenceVideo: expect.objectContaining({ fileName: 'moves.mp4' }),
      });
    });

    it("keeps an image source's aspect ratio and settings when the catalog default has other controls", async () => {
      const tree = await restoreWithLateCatalog('image', 'gen-poster', imageSource);

      expect(collectText(tree.root)).not.toContain('Model updated');
      const image = lastSavedSession()?.image;
      expect(image).toMatchObject({ model: 'gpt-image-2', aspectRatio: '9:16', resolution: '2K' });
      expect(image.catalogSettings).toEqual({ aspectRatio: '9:16', resolution: '2K' });
    });

    it('keeps a prompt typed and a model chosen while the source was still loading', async () => {
      const withWan = () => {
        const catalog = createRemixRestoreCatalog();
        const seedance = catalog.models.find((model) => model.id === 'seedance-2')!;
        return { ...catalog, models: [...catalog.models, { ...seedance, id: 'wan-2.7', displayName: 'Wan 2.7' }] };
      };
      catalogState.catalog = null;
      let releaseSource: (value: unknown) => void = () => {};
      authState.api.getRemixSourceBundle.mockReturnValue(new Promise((resolve) => { releaseSource = resolve; }));
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(creator('video', 'gen-girl')); });
      await renderer.act(async () => {
        catalogState.catalog = withWan();
        tree.update(creator('video', 'gen-girl'));
      });

      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('my own take');
      });
      renderer.act(() => {
        findPressableByLabelPrefix(tree.root, 'Selected model').props.onPress();
      });
      renderer.act(() => {
        findPressableByText(tree.root, 'Wan 2.7').props.onPress();
      });
      await renderer.act(async () => {
        releaseSource(girlSource);
        await Promise.resolve();
      });
      await wait(450);

      expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('my own take');
      expect(lastSavedSession()?.video).toMatchObject({ model: 'wan-2.7', prompt: 'my own take' });
    });
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
      findPressableByText(tree!.root, 'Enhance · 2 credits').props.onPress();
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

    // Drawn from the picker's own copy this session, not the signed link to the whole upload.
    const thumbnail = tree!.root.find((node) => String(node.type) === 'stable-media-image' && node.props.url === 'file:///hero.png');
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
    // Letterboxed, so the clip fills its square tile and sits in the middle of
    // it: as a 4:5 card of the tile's height it was narrower and to the left.
    expect(previews).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        kind: 'video',
        // The picker's own copy, while this session lasts.
        url: 'file:///motion.mp4',
        letterbox: true,
        nativeControls: false,
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
    const thumbnail = tree!.root.find((node) => String(node.type) === 'stable-media-image' && node.props.url === 'file:///hero.png');
    expect(thumbnail.props).toEqual(expect.objectContaining({
      contentFit: 'cover',
      style: { width: '100%', height: '100%' },
    }));
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
    });

    const text = collectText(tree!.root);
    expect(text).toContain('Reference details');
    // Letterboxed: the whole reference, centred across the sheet. Without it the
    // preview was a 240pt card against the left edge (see media-preview.test).
    expect(tree!.root.findAll((node) => String(node.type) === 'media-preview')).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({
        url: 'file:///hero.png',
        height: 300,
        letterbox: true,
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
      // `showConfirmDialog`'s fallback settles its promise on an Android
      // dismissal too, so the answer never strands the caller — see `lib/dialog`.
      expect.any(Object),
    );
    const buttons = nativeAlertState.alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    // The removal runs when the confirmation resolves, a microtask after the
    // press, so the tick has to be flushed before the prompt is read back.
    await renderer.act(async () => {
      buttons.find((button) => button.text === 'Remove')?.onPress?.();
      await Promise.resolve();
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

  describe('the Reference details sheet', () => {
    /** The image composer with one uploaded picture, "hero", and its details sheet open. */
    async function openHeroDetails() {
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
      // Nothing has been asked of the keyboard or the back key by the page alone.
      expect(keyboardState.dismiss).not.toHaveBeenCalled();
      expect(backHandlerState.listeners.size).toBe(0);
      renderer.act(() => {
        tree!.root.findByProps({ accessibilityLabel: 'Open details for hero' }).props.onPress();
      });
      return tree!;
    }

    function ancestors(node: renderer.ReactTestInstance) {
      const found: renderer.ReactTestInstance[] = [];
      for (let current = node.parent; current; current = current.parent) found.push(current);
      return found;
    }

    const nameField = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ accessibilityLabel: 'Reference name for hero' });
    /** The sheet's own scroll view: the nearest one above its name field. (With no overlay host in a test, the sheet draws in place, inside the page's.) */
    const sheetBody = (tree: renderer.ReactTestRenderer) => ancestors(nameField(tree)).find((node) => String(node.type) === 'scrollview')!;

    it('draws in the app’s own window, in an area that gives way to the keyboard, with its body in a scroll view', async () => {
      const tree = await openHeroDetails();
      const above = ancestors(nameField(tree));

      // A Modal is a window of its own on Android, where the keyboard tracker
      // reads nothing: the field sat under the keys while it was typed in.
      expect(above.some((node) => String(node.type) === 'modal')).toBe(false);
      expect(above.some((node) => node.props.testID === 'reference-details-keyboard-area')).toBe(true);

      // Both halves of the keyboard pairing: Android shortens the area and
      // scrolls the focused field into what is left of the scroll view; iOS
      // has the scroll view make the room itself.
      const body = sheetBody(tree);
      expect(body.props).toEqual(expect.objectContaining({
        automaticallyAdjustKeyboardInsets: true,
        // A row answers with the keyboard up; a touch on anything else in the body puts it away.
        keyboardShouldPersistTaps: 'handled',
      }));

      // The way out stays put while the body scrolls under it.
      const close = tree.root.findByProps({ accessibilityLabel: 'Close reference details' });
      expect(ancestors(close)).not.toContain(body);
      // And the area is the sheet's own, not the page's: the panel's height is a share of what it leaves.
      expect(ancestors(body).findIndex((node) => node.props.testID === 'reference-details-keyboard-area')).toBeGreaterThan(-1);
    });

    it('takes the keyboard from the page as it opens, and puts its own away as it closes', async () => {
      const tree = await openHeroDetails();
      // Opening over the prompt while it is being typed in: a Modal's window
      // took the keyboard by taking the focus, and an overlay takes nothing.
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(1);

      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Close reference details' }).props.onPress();
      });
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(2);
    });

    it('closes on Android’s back key, and gives the key back once it is closed', async () => {
      const tree = await openHeroDetails();
      expect(backHandlerState.listeners.size).toBe(1);

      let claimed: boolean | undefined;
      renderer.act(() => {
        claimed = [...backHandlerState.listeners][0]();
      });
      expect(claimed).toBe(true);
      expect(collectText(tree.root)).not.toContain('Reference details');
      expect(backHandlerState.listeners.size).toBe(0);
    });

    it('leaves showing the reference it was opened for, and takes no press while it does', async () => {
      const tree = await openHeroDetails();
      const surface = () => ancestors(nameField(tree)).find((node) => node.props.pointerEvents !== undefined);
      expect(surface()?.props.pointerEvents).toBe('auto');

      // A rename on the way: its "saved" line is part of what the panel is as tall as.
      renderer.act(() => {
        nameField(tree).props.onChangeText('hero');
      });
      renderer.act(() => {
        nameField(tree).props.onBlur();
      });
      expect(collectText(tree.root)).toContain('Saved to draft');

      animatedState.hold = true;
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Close reference details' }).props.onPress();
      });
      // The page has dropped the reference; the panel is still on its way out
      // with the same rows, or it would change height under its own exit.
      const leaving = collectText(tree.root);
      expect(leaving).toContain('Reference details');
      expect(leaving).toContain('Insert @hero');
      expect(leaving.some((text) => text.startsWith('Replace media'))).toBe(true);
      expect(leaving).toContain('Saved to draft');
      expect(nameField(tree).props.value).toBe('hero');
      expect(surface()?.props.pointerEvents).toBe('none');

      renderer.act(() => finishAnimations());
      expect(collectText(tree.root)).not.toContain('Reference details');
    });

    /** The sheet's preview, and the panel whose first layout its slide waits for. */
    const sheetPreview = (tree: renderer.ReactTestRenderer) => sheetBody(tree).findAll((node) => String(node.type) === 'media-preview')[0];
    const sheetPanel = (tree: renderer.ReactTestRenderer) => ancestors(sheetBody(tree)).find((node) => typeof node.props.onLayout === 'function')!;

    it('holds a clip’s player back until the sheet has arrived, and keeps it while the sheet leaves', async () => {
      const tree = await openHeroDetails();
      // The slide has not begun: it waits for the panel's height.
      expect(sheetPreview(tree).props.playerHeld).toBe(true);

      animatedState.hold = true;
      renderer.act(() => {
        sheetPanel(tree).props.onLayout({ nativeEvent: { layout: { height: 584 } } });
      });
      // On its way in. A player is built on the main thread, where this slide
      // is drawn: built now, it took the first 32 to 197 ms out of it.
      expect(sheetPreview(tree).props.playerHeld).toBe(true);
      renderer.act(() => finishAnimations());
      expect(sheetPreview(tree).props.playerHeld).toBe(false);

      // Leaving, the player stays to the end: taken down as the exit began it
      // would be work on the thread that draws the exit, and a black box
      // sliding out where the clip had been.
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Close reference details' }).props.onPress();
      });
      expect(sheetPreview(tree).props.playerHeld).toBe(false);
      renderer.act(() => finishAnimations());
      expect(collectText(tree.root)).not.toContain('Reference details');
    });

    it('takes a pull from its title as from its grabber, and leaves a touch-down on its body to the scroll view', async () => {
      type Config = Record<string, (...args: unknown[]) => boolean>;
      // For this case the double hands each responder's own config back as its
      // handlers, so the tree shows which view carries which.
      vi.mocked(PanResponder.create).mockImplementation(((config: unknown) => ({ panHandlers: { panConfig: config } })) as never);
      try {
        const tree = await openHeroDetails();
        const touch = { nativeEvent: { target: 57 }, stopPropagation: () => undefined };
        const title = tree.root.findByProps({ children: 'Reference details' });

        // The title row: taken as it lands, as the grabber's strip is, with no
        // question about where the body is scrolled to. The panel's own drag
        // waits for the body to be at its top, and with the keyboard up the
        // body has always scrolled a little: a pull from the title did nothing.
        const titleRow = ancestors(title).find((node) => node.props.panConfig)!;
        const header = titleRow.props.panConfig as Config;
        expect(header.onStartShouldSetPanResponder(touch, { dy: 0, dx: 0 })).toBe(true);
        expect('onMoveShouldSetPanResponderCapture' in header).toBe(false);

        // The panel: in its own window nothing above it takes an unowned
        // touch, so it waits for the pull. Held from its start, the touch is
        // intercepted from the scroll view inside on Android, and a slow drag
        // that began on the picture scrolled nothing.
        const panel = ancestors(titleRow).find((node) => node.props.panConfig && node.props.panConfig !== header)!.props.panConfig as Config;
        expect(panel.onStartShouldSetPanResponder(touch, { dy: 0, dx: 0 })).toBe(false);
        expect(panel.onMoveShouldSetPanResponder(touch, { dy: 12, dx: 0 })).toBe(true);
      } finally {
        vi.mocked(PanResponder.create).mockImplementation((() => ({ panHandlers: {} })) as never);
      }
    });
  });

  describe('the model picker', () => {
    /** The image composer with its model picker open. */
    function openPicker() {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="image" />);
      });
      // Nothing has been asked of the keyboard or the back key by the page alone.
      expect(keyboardState.dismiss).not.toHaveBeenCalled();
      expect(backHandlerState.listeners.size).toBe(0);
      renderer.act(() => {
        findPressableByLabelPrefix(tree!.root, 'Selected model').props.onPress();
      });
      return tree!;
    }

    function ancestors(node: renderer.ReactTestInstance) {
      const found: renderer.ReactTestInstance[] = [];
      for (let current = node.parent; current; current = current.parent) found.push(current);
      return found;
    }

    const searchField = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ accessibilityLabel: 'Search model names' });
    const closeButton = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ accessibilityLabel: 'Close model picker' });
    /** The picker's list: the scroll view its rows are in. */
    const modelList = (tree: renderer.ReactTestRenderer) => ancestors(findPressableByText(tree.root, 'Grok Imagine')).find((node) => String(node.type) === 'scrollview')!;

    it('draws in the app’s own window, in an area that gives way to the keyboard, with its list in a scroll view that does', () => {
      const tree = openPicker();
      const above = ancestors(searchField(tree));

      // A Modal is a window of its own on Android, where the keyboard tracker
      // reads nothing, and this one had no avoidance on either platform: with
      // the keys up the last three rows of sixteen could not be reached.
      expect(above.some((node) => String(node.type) === 'modal')).toBe(false);
      expect(above.some((node) => node.props.testID === 'model-picker-keyboard-area')).toBe(true);

      // Both halves of the keyboard pairing: Android shortens the area, and
      // the panel and its list with it; iOS has the list make the room itself.
      const list = modelList(tree);
      expect(list.props).toEqual(expect.objectContaining({
        automaticallyAdjustKeyboardInsets: true,
        // A model answers its press with the keyboard up; a touch on anything else in the list puts it away.
        keyboardShouldPersistTaps: 'handled',
      }));
      expect(ancestors(list).some((node) => node.props.testID === 'model-picker-keyboard-area')).toBe(true);

      // The search field and the way out stay put while the list scrolls under them.
      expect(above).not.toContain(list);
      expect(ancestors(closeButton(tree))).not.toContain(list);
    });

    it('takes the keyboard from the page as it opens, and puts its own away as it closes', () => {
      const tree = openPicker();
      // Opening over the prompt while it is being typed in: a Modal's window
      // took the keyboard by taking the focus, and an overlay takes nothing.
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(1);

      renderer.act(() => {
        closeButton(tree).props.onPress();
      });
      expect(keyboardState.dismiss).toHaveBeenCalledTimes(2);
    });

    it('closes on Android’s back key, and gives the key back once it is closed', () => {
      const tree = openPicker();
      expect(backHandlerState.listeners.size).toBe(1);

      let claimed: boolean | undefined;
      renderer.act(() => {
        claimed = [...backHandlerState.listeners][0]();
      });
      expect(claimed).toBe(true);
      expect(collectText(tree.root)).not.toContain('Choose model');
      expect(backHandlerState.listeners.size).toBe(0);
    });

    it('leaves on the search it was showing, takes no press while it does, and opens next on every model', () => {
      const tree = openPicker();
      const surface = () => ancestors(searchField(tree)).find((node) => node.props.pointerEvents !== undefined);
      expect(surface()?.props.pointerEvents).toBe('auto');

      renderer.act(() => {
        searchField(tree).props.onChangeText('grok');
      });
      expect(collectText(tree.root)).not.toContain('GPT Image 2');

      animatedState.hold = true;
      renderer.act(() => {
        findPressableByText(tree.root, 'Grok Imagine').props.onPress();
      });
      // On its way out with the choice made. Cleared now, the search would let
      // every model back into the list under the sheet's own exit.
      const leaving = collectText(tree.root);
      expect(leaving).toContain('Choose model');
      expect(leaving).toContain('Grok Imagine');
      expect(leaving).not.toContain('GPT Image 2');
      expect(searchField(tree).props.value).toBe('grok');
      expect(surface()?.props.pointerEvents).toBe('none');

      renderer.act(() => finishAnimations());
      expect(collectText(tree.root)).not.toContain('Choose model');

      // The next opening starts from nothing typed. A Modal's `onDismiss` did
      // this on iOS only: on Android the picker reopened on its last search.
      animatedState.hold = false;
      renderer.act(() => {
        findPressableByLabelPrefix(tree.root, 'Selected model').props.onPress();
      });
      expect(searchField(tree).props.value).toBe('');
      expect(collectText(tree.root)).toContain('GPT Image 2');
    });

    it('takes a pull from its title as from its grabber, and leaves a touch-down on its list to the scroll view', () => {
      type Config = Record<string, (...args: unknown[]) => boolean>;
      // For this case the double hands each responder's own config back as its
      // handlers, so the tree shows which view carries which.
      vi.mocked(PanResponder.create).mockImplementation(((config: unknown) => ({ panHandlers: { panConfig: config } })) as never);
      try {
        const tree = openPicker();
        const touch = { nativeEvent: { target: 57 }, stopPropagation: () => undefined };
        const title = tree.root.findByProps({ children: 'Choose model' });

        // The title row: taken as it lands, as the grabber's strip is, with no
        // question about where the list is scrolled to. The panel's own drag
        // waits for the list to be at its top: a pull from the title did
        // nothing once the list had scrolled.
        const titleRow = ancestors(title).find((node) => node.props.panConfig)!;
        const header = titleRow.props.panConfig as Config;
        expect(header.onStartShouldSetPanResponder(touch, { dy: 0, dx: 0 })).toBe(true);
        expect('onMoveShouldSetPanResponderCapture' in header).toBe(false);

        // The panel: in its own window nothing above it takes an unowned
        // touch, so it waits for the pull. Held from its start, the touch is
        // intercepted from the list on Android at the finger's next movement.
        const panel = ancestors(titleRow).find((node) => node.props.panConfig && node.props.panConfig !== header)!.props.panConfig as Config;
        expect(panel.onStartShouldSetPanResponder(touch, { dy: 0, dx: 0 })).toBe(false);
        expect(panel.onMoveShouldSetPanResponder(touch, { dy: 12, dx: 0 })).toBe(true);
      } finally {
        vi.mocked(PanResponder.create).mockImplementation((() => ({ panHandlers: {} })) as never);
      }
    });
  });

  // D9: the catalog's New models at the top of the Create tab, read from the pages the screen
  // already has, and opened the way a pick from the model picker is.
  describe('the What’s new strip', () => {
    const [newInTwoKinds, noneNew] = whatsNewContract.cases;
    /** A fixture case as the catalog read hands it over: summaries, by sortOrder and then id. */
    const summaries = (models: readonly { id: string; kind: string; badge: string | null; sortOrder: number; displayName: string }[]): ModelCatalogSummary[] => models
      .map((model) => ({ ...model, kind: model.kind as ModelCatalogKind, description: `${model.displayName} summary`, recommended: false }))
      .sort((left, right) => left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    /** Orbit Max and Pixel Flash as the catalog describes them once their details are in. */
    const orbitMax = (): GenerationModelDescriptor => ({ ...parityKlingVideo(), id: 'orbit-max', displayName: 'Orbit Max', badge: 'new', recommended: false, sortOrder: 60 });
    const pixelFlash = (): GenerationModelDescriptor => ({ ...parityImageModel('pixel-flash', 'Pixel Flash', 2), badge: 'NEW', sortOrder: 50 });
    const strips = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'whats-new-models');
    const chips = (tree: renderer.ReactTestRenderer) => strips(tree)[0].findAll((node) => String(node.type) === 'pressable');
    const chip = (tree: renderer.ReactTestRenderer, label: string) => chips(tree).find((node) => node.props.accessibilityLabel === label)!;
    const toolTab = (tree: renderer.ReactTestRenderer, title: string) => tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === title);
    const modelChip = (tree: renderer.ReactTestRenderer) => findPressableByLabelPrefix(tree.root, 'Selected model').props.accessibilityLabel as string;
    const generateButton = (tree: renderer.ReactTestRenderer) => findPressableByLabelPrefix(tree.root, 'Generate');
    /** Mounted, with the drafts read back from storage before anything is pressed. */
    const open = async (element: React.ReactElement) => {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(element); });
      await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      return tree;
    };

    it('lists the fixture’s models in its order from the screen’s catalog read, under the header and above the composer', async () => {
      catalogState.summaries = summaries(newInTwoKinds.models);
      const tree = await open(<MediaCreationScreen initialTool="image" insideTab />);

      expect(chips(tree).map((node) => node.props.accessibilityLabel)).toEqual(['Pixel Flash, Image', 'Orbit Max, Video', 'Aurora, Image', 'Orbit, Video']);
      const text = collectText(tree.root);
      expect(text.indexOf('Motion')).toBeLessThan(text.indexOf('What’s new'));
      expect(text.indexOf('What’s new')).toBeLessThan(text.indexOf('Prompt'));
    });

    it('switches to the tapped model’s tool with the model in that tool’s draft, and leaves the others’ alone', async () => {
      catalogState.catalog = createTestGenerationModelCatalog([orbitMax()]);
      catalogState.summaries = summaries(newInTwoKinds.models);
      const tree = await open(<MediaCreationScreen initialTool="image" insideTab />);
      expect(modelChip(tree)).toContain('Nano Banana 2.0');

      renderer.act(() => { chip(tree, 'Orbit Max, Video').props.onPress(); });

      expect(toolTab(tree, 'Video').props.accessibilityState).toEqual({ selected: true });
      expect(modelChip(tree)).toBe('Selected model Orbit Max. Change model');
      expect(chip(tree, 'Orbit Max, Video').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
      // Its details were in, so the pick landed without the picker.
      expect(collectText(tree.root)).not.toContain('Choose model');

      renderer.act(() => { toolTab(tree, 'Image').props.onPress(); });
      expect(modelChip(tree)).toContain('Nano Banana 2.0');
    });

    it('turns the chip while the model’s details load, holds Generate, and lands the model without the picker', async () => {
      vi.useFakeTimers();
      const full = createTestGenerationModelCatalog([pixelFlash()]);
      catalogState.summaries = summaries(newInTwoKinds.models);
      let release: () => void = () => undefined;
      catalogState.loadDetails = async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        catalogState.catalog = full;
        return full;
      };
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => { tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />); });
      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('A bottle on linen'); });
      await renderer.act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(generateButton(tree).props.disabled).toBe(false);

      renderer.act(() => { chip(tree, 'Pixel Flash, Image').props.onPress(); });

      expect(chip(tree, 'Pixel Flash, Image').findAllByProps({ testID: 'whats-new-model-loading' })).not.toHaveLength(0);
      expect(chips(tree).map((node) => node.props.disabled)).toEqual([true, true, true, true]);
      expect(modelChip(tree)).toContain('Nano Banana 2.0');
      expect(generateButton(tree).props.disabled).toBe(true);
      // The newest models end their kind's list: a picker opened for the wait would show the rows above.
      expect(collectText(tree.root)).not.toContain('Choose model');

      await renderer.act(async () => {
        release();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(modelChip(tree)).toBe('Selected model Pixel Flash. Change model');
      expect(tree.root.findAllByProps({ testID: 'whats-new-model-loading' })).toHaveLength(0);
      expect(chip(tree, 'Pixel Flash, Image').props.accessibilityState).toEqual(expect.objectContaining({ selected: true, disabled: false }));
      expect(collectText(tree.root)).not.toContain('Choose model');
    });

    it('says under the strip why a model could not be picked, and tries again from its chip', async () => {
      const full = createTestGenerationModelCatalog([orbitMax()]);
      catalogState.summaries = summaries(newInTwoKinds.models);
      const loadDetails = vi.fn()
        .mockRejectedValueOnce(new Error('Could not load model settings.'))
        .mockImplementationOnce(async () => {
          catalogState.catalog = full;
          return full;
        });
      catalogState.loadDetails = loadDetails;
      const tree = await open(<MediaCreationScreen initialTool="image" insideTab />);

      await renderer.act(async () => {
        chip(tree, 'Orbit Max, Video').props.onPress();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(toolTab(tree, 'Video').props.accessibilityState).toEqual({ selected: true });
      const failure = strips(tree)[0].find((node) => String(node.type) === 'text' && node.props.accessibilityRole === 'alert');
      expect(failure.props.children).toBe('Could not load model settings.');
      expect(modelChip(tree)).toContain('Kling 3.0 Cinematic');
      expect(chip(tree, 'Orbit Max, Video').props.disabled).toBe(false);

      await renderer.act(async () => {
        chip(tree, 'Orbit Max, Video').props.onPress();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(loadDetails).toHaveBeenCalledTimes(2);
      expect(modelChip(tree)).toBe('Selected model Orbit Max. Change model');
      expect(strips(tree)[0].findAll((node) => String(node.type) === 'text' && node.props.accessibilityRole === 'alert')).toHaveLength(0);
    });

    it('drops a pick still loading when the tool changes, and leaves that tool’s draft alone', async () => {
      const full = createTestGenerationModelCatalog([orbitMax()]);
      catalogState.summaries = summaries(newInTwoKinds.models);
      let release: () => void = () => undefined;
      catalogState.loadDetails = async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        catalogState.catalog = full;
        return full;
      };
      const tree = await open(<MediaCreationScreen initialTool="image" insideTab />);

      renderer.act(() => { chip(tree, 'Orbit Max, Video').props.onPress(); });
      expect(tree.root.findAllByProps({ testID: 'whats-new-model-loading' })).not.toHaveLength(0);
      renderer.act(() => { toolTab(tree, 'Image').props.onPress(); });
      expect(tree.root.findAllByProps({ testID: 'whats-new-model-loading' })).toHaveLength(0);

      await renderer.act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      renderer.act(() => { toolTab(tree, 'Video').props.onPress(); });

      expect(modelChip(tree)).toContain('Kling 3.0 Cinematic');
    });

    it('keeps the tool while a run is going, back on the run, and picks nothing', async () => {
      vi.useFakeTimers();
      authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));
      catalogState.summaries = summaries(newInTwoKinds.models);
      const loadDetails = vi.fn(async () => catalogState.catalog);
      catalogState.loadDetails = loadDetails;
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => { tree = renderer.create(<MediaCreationScreen initialTool="image" insideTab />); });
      renderer.act(() => {
        tree.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('Create an editorial product image.');
      });
      await renderer.act(async () => { await vi.advanceTimersByTimeAsync(200); });
      await renderer.act(async () => {
        void findPressableByText(tree.root, 'Generate · 8 credits').props.onPress();
        await vi.advanceTimersByTimeAsync(0);
      });
      renderer.act(() => { findPressableByText(tree.root, 'Minimize').props.onPress(); });
      expect(collectText(tree.root)).not.toContain('Creating image');

      renderer.act(() => { chip(tree, 'Orbit Max, Video').props.onPress(); });

      expect(toolTab(tree, 'Image').props.accessibilityState).toEqual({ selected: true });
      expect(collectText(tree.root)).toContain('Creating image');
      expect(collectText(tree.root)).not.toContain('Choose model');
      expect(loadDetails).not.toHaveBeenCalled();
    });

    it('draws nothing when no model carries New, or while the catalog is still loading', async () => {
      catalogState.summaries = summaries(newInTwoKinds.models);
      expect(strips(await open(<MediaCreationScreen initialTool="image" insideTab />))).toHaveLength(1);

      catalogState.summaries = summaries(noneNew.models);
      expect(strips(await open(<MediaCreationScreen initialTool="image" insideTab />))).toHaveLength(0);

      catalogState.catalog = null;
      catalogState.summaries = null;
      catalogState.isLoading = true;
      expect(strips(await open(<MediaCreationScreen initialTool="video" insideTab />))).toHaveLength(0);
    });

    it('is the Create tab’s alone: not on a creator opened from a link, nor on a first creation', async () => {
      catalogState.summaries = summaries(newInTwoKinds.models);

      expect(strips(await open(<MediaCreationScreen initialTool="image" insideTab />))).toHaveLength(1);
      expect(strips(await open(<MediaCreationScreen initialTool="image" />))).toHaveLength(0);
      expect(strips(await open(<MediaCreationScreen initialTool="image" insideTab guided />))).toHaveLength(0);
    });
  });

  describe('the parameter sheet', () => {
    type Config = Record<string, (...args: unknown[]) => unknown>;

    /**
     * The image composer with its parameter sheet open. The double hands each
     * responder's own config back as its handlers, so the tree shows which
     * view carries which.
     */
    function openParameters() {
      vi.mocked(PanResponder.create).mockImplementation(((config: unknown) => ({ panHandlers: { panConfig: config } })) as never);
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="image" />);
      });
      renderer.act(() => {
        findPressableByLabelPrefix(tree!.root, 'Generation parameters.').props.onPress();
      });
      return tree!;
    }

    afterEach(() => {
      vi.mocked(PanResponder.create).mockImplementation((() => ({ panHandlers: {} })) as never);
    });

    function ancestors(node: renderer.ReactTestInstance) {
      const found: renderer.ReactTestInstance[] = [];
      for (let current = node.parent; current; current = current.parent) found.push(current);
      return found;
    }

    const touch = { nativeEvent: { target: 57 }, stopPropagation: () => undefined };
    const sheetPanel = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ testID: 'creator-parameter-sheet' });
    const isOpen = (tree: renderer.ReactTestRenderer) => tree.root.findAllByProps({ testID: 'creator-parameter-sheet' }).length > 0;
    /** The row the title and the close button are in, and the responder it carries. */
    const titleRow = (tree: renderer.ReactTestRenderer) => (
      ancestors(sheetPanel(tree).findByProps({ children: 'Generation parameters' })).find((node) => node.props.panConfig)!
    );

    it('takes a pull from its title as from its grabber, wherever its list is scrolled to', () => {
      const tree = openParameters();
      const panel = sheetPanel(tree).props.panConfig as Config;
      const header = titleRow(tree).props.panConfig as Config;

      // The title row has a responder of its own, the grabber's: taken as the
      // touch lands, with no question about the list. Left to the panel, a pull
      // from the title waited for the list to be at its top, and did nothing
      // once the list had scrolled.
      expect(header).not.toBe(panel);
      expect('onMoveShouldSetPanResponderCapture' in header).toBe(false);

      const list = sheetPanel(tree).find((node) => String(node.type) === 'scrollview');
      renderer.act(() => {
        list.props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } });
      });
      // Scrolled into the list, a downward pull on the panel is the list's to scroll back.
      expect(panel.onMoveShouldSetPanResponderCapture(touch, { dy: 12, dx: 0 })).toBe(false);
      // The row still takes the touch-down, and a pull that began on its close
      // button, which reaches the row as a move.
      expect(header.onStartShouldSetPanResponder(touch, { dy: 0, dx: 0 })).toBe(true);
      expect(header.onMoveShouldSetPanResponder(touch, { dy: 12, dx: 0 })).toBe(true);

      renderer.act(() => {
        header.onPanResponderGrant(touch, { dy: 0, dx: 0 });
        header.onPanResponderMove(touch, { dy: 140, dx: 0 });
        header.onPanResponderRelease(touch, { dy: 140, dx: 0, vy: 0 });
      });
      expect(isOpen(tree)).toBe(false);
    });

    it('keeps its panel taking a touch-down, as a sheet in a Modal has to, and its close button a press', () => {
      const tree = openParameters();
      const panel = sheetPanel(tree).props.panConfig as Config;

      // It holds no field, so it is still a Modal, and the two go together:
      // inside a Modal on Android a view that declines a touch-down is never
      // asked about the moves after it, so the panel takes a touch nothing
      // below it wanted. The three sheets drawn in the app's own window ask
      // their panels to wait instead; moved there, this one would have to too.
      expect(ancestors(sheetPanel(tree)).some((node) => String(node.type) === 'modal')).toBe(true);
      expect(panel.onStartShouldSetPanResponder(touch, { dy: 0, dx: 0 })).toBe(true);

      // The way out sits in the title row, below the row's responder: a press
      // that lands on it is asked of the button first.
      const close = tree.root.findByProps({ accessibilityLabel: 'Close generation parameters' });
      expect(String(close.type)).not.toBe('view');
      expect(ancestors(close)).toContain(titleRow(tree));
      expect(titleRow(tree).props.panConfig).not.toBe(panel);
      renderer.act(() => {
        close.props.onPress();
      });
      expect(isOpen(tree)).toBe(false);
    });
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

  // The blocker named "@Nike" and "@example" as unknown elements and held
  // Generate back, though the server takes both as the text they are (2026-10-03).
  it('raises no unknown-mention blocker for a word with a capital or for an address', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    const typePrompt = (prompt: string) => {
      const promptInput = tree!.root.findAll((node) => String(node.type) === 'textinput')[0];
      renderer.act(() => {
        promptInput.props.onChangeText(prompt);
      });
      return collectText(tree!.root).filter((item) => item.includes('Unknown element mention'));
    };

    expect(typePrompt('A runner beside @missing_reference.')).toEqual(['Unknown element mention: @missing_reference']);
    expect(typePrompt('A runner in the style of @Nike. Write to studio@example.com.')).toEqual([]);
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
    authState.api.startGeneration.mockResolvedValue({
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
    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
    expect(routerState.push).not.toHaveBeenCalled();
  });

  it('asks before a generation leaves the phone, and sends nothing when the person declines', async () => {
    // App Review rejected 0.1.6 (55) under guidelines 5.1.1(i) and 5.1.2(i):
    // prompts and media went to third-party AI services without permission.
    vi.useFakeTimers();
    aiDataConsentState.ensure.mockResolvedValue(false);

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('A product shot on linen.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate \u00b7 8 credits').props.onPress();
    });

    expect(aiDataConsentState.ensure).toHaveBeenCalledTimes(1);
    expect(authState.api.startGeneration).not.toHaveBeenCalled();
    // Not even saved as an attempt: there is no request to check later.
    expect(draftStorage.setItem.mock.calls.map(([key]) => key))
      .not.toContainEqual(expect.stringContaining('generation.pendingAttempt'));
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value)
      .toBe('A product shot on linen.');

    // Allowed on the next press, the same draft goes out.
    aiDataConsentState.ensure.mockResolvedValue(true);
    authState.api.startGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-after-consent',
      generationId: 'gen-after-consent',
      status: 'processing',
      remainingCredits: 990,
    });
    authState.api.getImageGeneration.mockResolvedValue({ status: 'processing' });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate \u00b7 8 credits').props.onPress();
    });
    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
    expect(authState.api.startGeneration.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      prompt: 'A product shot on linen.',
    }));
  });

  it('asks before a prompt is enhanced, and leaves the prompt alone when the person declines', async () => {
    aiDataConsentState.ensure.mockResolvedValue(false);
    authState.api.enhancePrompt.mockReset().mockResolvedValue({ enhancedPrompt: 'Enhanced.', remainingCredits: 900 });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="image" />);
    });
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('serum on a stone');
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Enhance · 2 credits').props.onPress();
    });

    expect(aiDataConsentState.ensure).toHaveBeenCalledTimes(1);
    expect(authState.api.enhancePrompt).not.toHaveBeenCalled();
    expect(tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('serum on a stone');
  });

  it('offers a post handoff after a generation succeeds with a generation id', async () => {
    vi.useFakeTimers();
    authState.api.startGeneration.mockResolvedValue({
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

    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
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

  // 02-2: Report AI output lived only in the library reel, which a guest could
  // not open, so a guest who generated had no way to flag what came back. The
  // result offers it to everyone; the server takes a guest's report of its own run.
  it.each([
    ['an account', { user: { id: 'user-123', email: 'creator@example.com' }, isGuest: false, identityUserId: 'user-123' }],
    ['a guest', { user: null, isGuest: true, identityUserId: 'guest-1' }],
  ] as const)('reports the result from the result card for %s, after asking', async (_who, identity) => {
    vi.useFakeTimers();
    Object.assign(authState, identity);
    authState.api.reportGeneration.mockResolvedValue({ success: true });
    authState.api.startGeneration.mockResolvedValue({
      success: true,
      predictionId: 'prediction-report',
      generationId: 'gen-report',
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
    renderer.act(() => {
      tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('A product shot on linen.');
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
    });

    const report = findPressableByText(tree!.root, 'Report AI output');
    expect(report.props.accessibilityHint).toBe('Sends this result to the safety team');
    await renderer.act(async () => {
      report.props.onPress();
    });

    // Asked first, in red, and nothing filed until the answer.
    const [title, , buttons] = nativeAlertState.alert.mock.calls.at(-1) as [
      string,
      string,
      Array<{ text: string; style?: string; onPress?: () => void }>,
    ];
    expect(title).toBe('Report offensive AI output?');
    expect(authState.api.reportGeneration).not.toHaveBeenCalled();
    const confirm = buttons.find((button) => button.text === 'Report AI output');
    expect(confirm?.style).toBe('destructive');
    await renderer.act(async () => {
      confirm?.onPress?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(authState.api.reportGeneration).toHaveBeenCalledWith('gen-report', {
      reason: 'offensive_ai_output',
      sourceSurface: 'generation-viewer',
      details: 'Reported from the mobile creator result.',
    });
    expect(nativeAlertState.alert).toHaveBeenLastCalledWith(
      'Report received',
      'Thank you. The generated output was sent to the safety team.',
    );
    // Filed where the result is: a guest is not sent to sign in first.
    expect(routerState.push).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  describe('notifications offer', () => {
    const OFFER_TITLE = 'Get a notification when it’s ready';

    /** Starts an image run that never settles, then lets the push check and offer history land. */
    async function openWaitingWorkspace() {
      authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));
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
      await renderer.act(async () => {
        void findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
        await vi.advanceTimersByTimeAsync(0);
      });
      await settle();
      return tree!;
    }

    async function settle() {
      for (let pass = 0; pass < 3; pass += 1) {
        await renderer.act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
    }

    function askFirstThen(outcome: () => Promise<unknown>) {
      notificationsMock.registerForMobilePushNotifications.mockImplementation(
        (_api: unknown, options?: { requestPermission?: boolean }) => (
          options?.requestPermission ? outcome() : Promise.resolve({ status: 'permission-required' })
        ),
      );
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('offers notifications while a creation runs, and reports a failed enable instead of leaving it unhandled', async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      askFirstThen(() => Promise.reject(new Error('push token upload failed')));
      try {
        const tree = await openWaitingWorkspace();
        expect(collectText(tree.root)).toContain('Creating image');
        expect(collectText(tree.root)).toContain(OFFER_TITLE);

        await renderer.act(async () => {
          findPressableByText(tree.root, 'Notify me').props.onPress();
        });
        await settle();

        expect(notificationsMock.registerForMobilePushNotifications).toHaveBeenCalledWith(authState.api, { requestPermission: true });
        const text = collectText(tree.root);
        expect(text).toContain('Couldn’t turn on notifications. Try again.');
        expect(text).toContain('Notify me');
        expect(consoleError).toHaveBeenCalledWith('Failed to register mobile push notifications', expect.any(Error));

        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        consoleError.mockRestore();
      }
    });

    it('confirms in place once notifications are on', async () => {
      vi.useFakeTimers();
      askFirstThen(() => Promise.resolve({ status: 'registered', expoPushToken: 'ExponentPushToken[new]' }));
      const tree = await openWaitingWorkspace();

      await renderer.act(async () => {
        findPressableByText(tree.root, 'Notify me').props.onPress();
      });
      await settle();

      const text = collectText(tree.root);
      expect(text).toContain('Notifications are on. We’ll tell you when it’s ready.');
      expect(text).not.toContain('Notify me');
    });

    it('hides the offer when the system alert is declined', async () => {
      vi.useFakeTimers();
      askFirstThen(() => Promise.resolve({ status: 'denied' }));
      const tree = await openWaitingWorkspace();

      await renderer.act(async () => {
        findPressableByText(tree.root, 'Notify me').props.onPress();
      });
      await settle();

      expect(collectText(tree.root)).toContain('Creating image');
      expect(collectText(tree.root)).not.toContain(OFFER_TITLE);
    });

    it('keeps the same offer through a minimize and reopen, and counts it once', async () => {
      vi.useFakeTimers();
      askFirstThen(() => new Promise(() => undefined));
      const tree = await openWaitingWorkspace();
      expect(collectText(tree.root)).toContain(OFFER_TITLE);

      renderer.act(() => {
        findPressableByText(tree.root, 'Minimize').props.onPress();
      });
      renderer.act(() => {
        findPressableByText(tree.root, 'View progress').props.onPress();
      });
      await settle();

      expect(collectText(tree.root)).toContain(OFFER_TITLE);
      const offerWrites = draftStorage.setItem.mock.calls.filter(([key]) => key === PUSH_OFFER_STORAGE_KEY);
      expect(offerWrites).toHaveLength(1);
    });

    it('does not offer notifications that are already on', async () => {
      vi.useFakeTimers();
      const tree = await openWaitingWorkspace();

      expect(collectText(tree.root)).toContain('Creating image');
      expect(collectText(tree.root)).not.toContain(OFFER_TITLE);
    });

    it('does not offer a guest, who cannot register for push, or even check', async () => {
      vi.useFakeTimers();
      authState.isGuest = true;
      askFirstThen(() => Promise.resolve({ status: 'registered', expoPushToken: 'ExponentPushToken[guest]' }));
      const tree = await openWaitingWorkspace();

      expect(collectText(tree.root)).toContain('Creating image');
      expect(collectText(tree.root)).not.toContain(OFFER_TITLE);
      expect(notificationsMock.registerForMobilePushNotifications).not.toHaveBeenCalled();
    });

    it('no longer asks after a guided creation has already finished', async () => {
      vi.useFakeTimers();
      askFirstThen(() => Promise.resolve({ status: 'registered', expoPushToken: 'ExponentPushToken[late]' }));
      (authState.api as Record<string, unknown>).recordOnboardingEvent = vi.fn().mockResolvedValue({ success: true });
      authState.api.startGeneration.mockResolvedValue({
        success: true,
        predictionId: 'prediction-1',
        generationId: 'gen-1',
        status: 'processing',
        remainingCredits: 980,
      });
      authState.api.getImageGeneration.mockResolvedValue({ status: 'succeeded', output: 'https://cdn.example.com/output.png' });

      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<MediaCreationScreen initialTool="image" guided />);
      });
      renderer.act(() => {
        tree!.root.findAll((node) => String(node.type) === 'textinput')[0].props.onChangeText('Create a glossy product hero shot.');
      });
      await renderer.act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      await renderer.act(async () => {
        await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
      });
      await settle();

      const text = collectText(tree!.root);
      expect(text).toContain('Post to feed');
      expect(text).not.toContain('Know when longer creations finish');
      expect(text).not.toContain(OFFER_TITLE);
    });
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

  it('asks the viewer to confirm a new price when the server measures a longer reference', async () => {
    vi.useFakeTimers();
    catalogState.catalog = catalogV2();
    const startGeneration = vi.fn().mockRejectedValue(Object.assign(
      new Error('Your reference media runs longer than the length this price was based on.'),
      { details: { code: 'REFERENCE_DURATION_CHANGED', costCredits: 60, quotedCostCredits: 29, inputs: [] } },
    ));
    authState.api.startGeneration = startGeneration;
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

    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(collectText(tree!.root)).toContain(
      'We measured your reference media, and it changes the cost. Check the new price, then generate again.',
    );
    expect(authState.api.getVideoGeneration).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Audit A3, counterexample 3: a retry after a lost start response sent the
  // same request under a new idempotency key, so the server could start and
  // charge a second run.
  it('checks a start whose response was lost under the same key, saved before it was sent', async () => {
    vi.useFakeTimers();
    catalogState.catalog = catalogV2();
    const attemptKey = 'magicbooklet.generation.pendingAttempt.v1:user-123';
    const startGeneration = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Could not reach Magicbooklet.'), {
        status: 0,
        details: { cause: 'Network request failed' },
      }))
      .mockResolvedValueOnce({
        success: true,
        predictionId: 'unified-video-prediction',
        generationId: 'unified-video-generation',
        status: 'processing',
        remainingCredits: 970,
        idempotentReplay: true,
      });
    authState.api.startGeneration = startGeneration;
    authState.api.getVideoGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/unified-output.mp4',
    });
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'fallback-video-v2',
      catalogRevision: 'catalog-v2-revision',
      normalizedSettings: { referenceMode: 'elements', resolution: '720p', duration: 7 },
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

    const firstKey = startGeneration.mock.calls[0]?.[1];
    const savedAt = draftStorage.setItem.mock.calls.findIndex(([key]) => key === attemptKey);
    expect(savedAt).toBeGreaterThanOrEqual(0);
    expect(draftStorage.setItem.mock.invocationCallOrder[savedAt])
      .toBeLessThan(startGeneration.mock.invocationCallOrder[0]);
    expect(collectText(tree!.root)).toContain('Generation not confirmed');

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Check again').props.onPress();
    });

    expect(startGeneration).toHaveBeenCalledTimes(2);
    expect(startGeneration.mock.calls[1]?.[1]).toBe(firstKey);
    expect(startGeneration.mock.calls[1]?.[0]).toEqual(startGeneration.mock.calls[0]?.[0]);
    expect(authState.api.getVideoGeneration).toHaveBeenCalledWith('unified-video-prediction');
    expect(draftStorage.removeItem).toHaveBeenCalledWith(attemptKey);
    vi.useRealTimers();
  });

  it('does not send a generation until its attempt can be saved', async () => {
    vi.useFakeTimers();
    const start = vi.fn().mockRejectedValue(Object.assign(new Error('Lost response'), { status: 0 }));
    authState.api.startGeneration = start;
    draftStorage.setItem.mockImplementation(async (key: string) => {
      if (key.startsWith('magicbooklet.generation.pendingAttempt')) throw new Error('Storage unavailable');
    });
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => { tree = renderer.create(<MediaCreationScreen initialTool="image" />); });
    renderer.act(() => { tree!.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText('A product photograph'); });
    await renderer.act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await renderer.act(async () => { await findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress(); });
    expect(start).not.toHaveBeenCalled();
    expect(collectText(tree!.root).join(' ')).toContain('Could not save your generation attempt');
    draftStorage.setItem.mockResolvedValue(undefined);
    await renderer.act(async () => { await findPressableByText(tree!.root, 'Check again').props.onPress(); });
    expect(start).toHaveBeenCalledTimes(1);
    renderer.act(() => tree!.unmount());
    vi.useRealTimers();
  });

  it('offers to check a start a restart left unconfirmed, replaying the saved request and key', async () => {
    vi.useFakeTimers();
    catalogState.catalog = catalogV2();
    const attemptKey = 'magicbooklet.generation.pendingAttempt.v1:user-123';
    const savedRequest = {
      kind: 'video',
      modelId: 'fallback-video-v2',
      catalogRevision: 'catalog-v2-revision',
      settings: { duration: 7 },
      prompt: 'The run from before the restart.',
      inputs: [],
    };
    draftStorage.getItem.mockImplementation(async (key: string) => (key === attemptKey
      ? JSON.stringify({
        version: 1,
        identityUserId: 'user-123',
        tool: 'video',
        route: 'unified',
        idempotencyKey: 'video:before-restart',
        requestJson: JSON.stringify(savedRequest),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })
      : null));
    const startGeneration = vi.fn().mockResolvedValue({
      success: true,
      predictionId: 'restored-prediction',
      generationId: 'restored-generation',
      status: 'processing',
      remainingCredits: 970,
      idempotentReplay: true,
    });
    authState.api.startGeneration = startGeneration;
    authState.api.getVideoGeneration.mockResolvedValue({
      status: 'succeeded',
      output: 'https://cdn.example.com/restored-output.mp4',
    });
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'fallback-video-v2',
      catalogRevision: 'catalog-v2-revision',
      normalizedSettings: { referenceMode: 'elements', resolution: '720p', duration: 7 },
      costCredits: 29,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(collectText(tree!.root)).toContain('Generation not confirmed');
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Check again').props.onPress();
    });

    expect(startGeneration).toHaveBeenCalledWith(savedRequest, 'video:before-restart');
    expect(authState.api.getVideoGeneration).toHaveBeenCalledWith('restored-prediction');
    vi.useRealTimers();
  });

  // Product decision 21: the per-kind start routes answer 410, so an attempt a build from
  // before POST /api/generations saved under one is not sent again.
  it('sends nothing for an attempt saved under a per-kind route, and offers a new run', async () => {
    vi.useFakeTimers();
    catalogState.catalog = catalogV2();
    const attemptKey = 'magicbooklet.generation.pendingAttempt.v1:user-123';
    draftStorage.getItem.mockImplementation(async (key: string) => (key === attemptKey
      ? JSON.stringify({
        version: 1,
        identityUserId: 'user-123',
        tool: 'video',
        route: 'video',
        idempotencyKey: 'video:per-kind',
        requestJson: JSON.stringify({ model: 'fallback-video-v2', prompt: 'A run from an older build.' }),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })
      : null));
    authState.api.startGeneration = vi.fn();
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'fallback-video-v2',
      catalogRevision: 'catalog-v2-revision',
      normalizedSettings: { referenceMode: 'elements', resolution: '720p', duration: 7 },
      costCredits: 29,
    });

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<MediaCreationScreen initialTool="video" />);
    });
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Check again').props.onPress();
    });

    expect(authState.api.startVideoGeneration).not.toHaveBeenCalled();
    expect(authState.api.startGeneration).not.toHaveBeenCalled();
    expect(collectText(tree!.root)).toContain('This version of the app can’t check that generation. Start a new run instead.');
    expect(draftStorage.removeItem).toHaveBeenCalledWith(attemptKey);
    vi.useRealTimers();
  });

  it('forgets an attempt the server refused outright', async () => {
    vi.useFakeTimers();
    catalogState.catalog = catalogV2();
    const attemptKey = 'magicbooklet.generation.pendingAttempt.v1:user-123';
    authState.api.startGeneration = vi.fn().mockRejectedValue(Object.assign(new Error('This model needs a shorter prompt.'), {
      status: 422,
      details: { code: 'INVALID_GENERATION_REQUEST' },
    }));
    authState.api.quoteGenerationModel.mockResolvedValue({
      modelId: 'fallback-video-v2',
      catalogRevision: 'catalog-v2-revision',
      normalizedSettings: { referenceMode: 'elements', resolution: '720p', duration: 7 },
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

    expect(draftStorage.removeItem).toHaveBeenCalledWith(attemptKey);
    expect(collectText(tree!.root)).not.toContain('Generation not confirmed');
    vi.useRealTimers();
  });

  it('opens the shared video result workspace and posts with the generation id', async () => {
    vi.useFakeTimers();
    authState.api.startGeneration.mockResolvedValue({
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

    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
    expect(collectText(tree!.root)).toContain('Your video');
    // Letterboxed: the whole result, across its column. As a 4:5 card of its
    // height it was 384pt wide in a 366pt column (see media-preview.test).
    expect(tree!.root.find((node) => String(node.type) === 'media-preview' && node.props.url === 'https://cdn.example.com/output.mp4').props).toMatchObject({
      kind: 'video',
      height: 480,
      letterbox: true,
    });
    renderer.act(() => {
      findPressableByText(tree!.root, 'Post to feed').props.onPress();
    });
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/post/new', params: { generationId: 'video-gen-1' } });
    vi.useRealTimers();
  });

  it('minimizes and reopens an in-progress image workspace without cancelling generation', async () => {
    vi.useFakeTimers();
    authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));

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

    // The start never settles here, so the press is not awaited; flushing lets
    // the attempt save that precedes every start land first.
    await renderer.act(async () => {
      void findPressableByText(tree!.root, 'Generate · 8 credits').props.onPress();
      await vi.advanceTimersByTimeAsync(0);
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
    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('retries an interrupted status check without starting or charging for a second generation', async () => {
    vi.useFakeTimers();
    authState.api.startGeneration.mockResolvedValue({
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
    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      await findPressableByText(tree!.root, 'Retry status check').props.onPress();
    });

    expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
    expect(authState.api.getImageGeneration).toHaveBeenCalledTimes(2);
    expect(collectText(tree!.root)).toContain('Post to feed');
    vi.useRealTimers();
  });

  it('shows failed generation actions and retries with the preserved draft', async () => {
    vi.useFakeTimers();
    authState.api.startGeneration.mockResolvedValue({
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

    authState.api.startGeneration.mockReturnValueOnce(new Promise(() => undefined));
    await renderer.act(async () => {
      void findPressableByText(tree!.root, 'Try again · 8 credits').props.onPress();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(authState.api.startGeneration).toHaveBeenCalledTimes(2);
    expect(promptInput.props.value).toBe('Create a dramatic studio portrait.');
    vi.useRealTimers();
  });

  it('creates another image while preserving prompt and parameters', async () => {
    vi.useFakeTimers();
    authState.api.startGeneration.mockResolvedValue({
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
      await findPressableByText(tree!.root, 'Enhance · 2 credits').props.onPress();
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

  it('repairs a completed saved remix with a missing named source reference without resetting edits', async () => {
    catalogState.catalog = createRemixRestoreCatalog();
    const video = {...createDefaultCreationDraft('video'), model:'seedance-2', prompt:'My edited scene: @girl is crying', aspectRatio:'9:16', resolution:'480p', duration:4, references:[]};
    draftStorage.getItem.mockResolvedValue(JSON.stringify({image:createDefaultCreationDraft('image'),video,motion:createDefaultCreationDraft('motion'),updatedAt:new Date().toISOString(),remixRestored:true,remixEditedKeys:{video:['prompt','references']}}));
    authState.api.getRemixSourceBundle.mockResolvedValue({generation:{id:'gen-girl',title:'Original',prompt:'The girl from @girl is crying',category:'video',model:'seedance-2'},result:null,inputs:{video:{referenceMode:'elements',startFrame:null,endFrame:null,elements:[{id:'girl',displayName:'Girl',handle:'@girl',url:'https://cdn.example.com/girl.png',storagePath:'generation_inputs/owner/girl.png',sourceGenerationId:null}],referenceVideos:[],referenceAudios:[]}},workflowSettings:{model:'seedance-2',referenceMode:'elements',duration:4,aspectRatio:'16:9',resolution:'480p'},restoreIssues:[]});
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async()=>{tree=renderer.create(<MediaCreationScreen initialTool="video" remixSource={{generationId:'gen-girl',postId:'post-girl'}}/>);});
    expect(tree.root.findByProps({accessibilityLabel:'Open details for Girl'})).toBeTruthy();
    expect(tree.root.findByProps({accessibilityLabel:'Generation prompt'}).props.value).toBe(video.prompt);
    expect(collectText(tree.root)).not.toContain('Unknown element mention');
    await renderer.act(async()=>{tree.unmount();});
  });

  // Audit A6. Source media are restored behind signed links that last an hour,
  // and a saved draft keeps them. Diagnostic counterexample 6: a saved remix
  // whose rail still held its references was never read again, so links that
  // had run out stayed dead, and the thumbnail's retry asked for the same link.
  describe('reference links that have run out', () => {
    const STORAGE = 'https://project.supabase.co';
    const signed = (path: string, expiresAtMs: number) => (
      `${STORAGE}/storage/v1/object/sign/${path}?token=head.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString('base64url')}.signature`
    );
    const girlPath = 'uploads/owner/girl.png';
    const otherPath = 'uploads/owner/other.png';
    const settle = () => renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    const thumbnail = (tree: renderer.ReactTestRenderer, name: string) => tree.root
      .findByProps({ accessibilityLabel: `Open details for ${name}` })
      .find((node) => String(node.type) === 'stable-media-image');
    const sourceBundle = (girlUrl: string) => ({
      generation: { id: 'gen-girl', title: 'Original', prompt: 'The girl from @girl is crying', category: 'video', model: 'seedance-2' },
      result: null,
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [
            { id: 'girl', displayName: 'Girl', handle: '@girl', url: girlUrl, storagePath: girlPath, sourceGenerationId: null },
            { id: 'other', displayName: 'Other', handle: '@other', url: signed(otherPath, Date.now() + 3_600_000), storagePath: otherPath, sourceGenerationId: null },
          ],
          referenceVideos: [],
          referenceAudios: [],
        },
      },
      workflowSettings: { model: 'seedance-2', referenceMode: 'elements', duration: 4, aspectRatio: '16:9', resolution: '480p' },
      restoreIssues: [],
    });
    /** A completed remix, then edited: the girl renamed, @other removed, the frame made vertical. */
    const savedRemix = (girlUrl: string) => JSON.stringify({
      image: createDefaultCreationDraft('image'),
      video: {
        ...createDefaultCreationDraft('video'),
        model: 'seedance-2',
        prompt: 'My edited scene: @girl is crying',
        aspectRatio: '9:16',
        resolution: '480p',
        duration: 4,
        references: [{ id: 'girl', kind: 'image', url: girlUrl, storagePath: girlPath, fileName: 'girl.png', displayName: 'My girl', handle: '@girl', sourceGenerationId: null }],
      },
      motion: createDefaultCreationDraft('motion'),
      updatedAt: new Date().toISOString(),
      remixRestored: true,
      remixEditedKeys: { video: ['prompt', 'references', 'aspectRatio'] },
    });
    const openRemix = async () => {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="video" remixSource={{ generationId: 'gen-girl', postId: 'post-girl' }} />); });
      await settle();
      return tree;
    };

    beforeEach(() => {
      catalogState.catalog = createRemixRestoreCatalog();
    });

    it('reads the source again for a saved remix whose links have expired, and keeps every edit', async () => {
      const fresh = signed(girlPath, Date.now() + 3_600_000);
      draftStorage.getItem.mockResolvedValue(savedRemix(signed(girlPath, Date.now() - 60_000)));
      authState.api.getRemixSourceBundle.mockResolvedValue(sourceBundle(fresh));

      const tree = await openRemix();
      await settle();

      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledTimes(1);
      // What Settings' support line will say about this draft.
      expect(readCreatorSession()).toMatchObject({ tool: 'video', outcome: 'recovered', referenceCount: 1 });
      expect(thumbnail(tree, 'My girl').props.url).toBe(fresh);
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Open details for Other' })).toHaveLength(0);
      expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('My edited scene: @girl is crying');
      expect(JSON.parse(draftStorage.setItem.mock.lastCall![1]).video).toMatchObject({
        aspectRatio: '9:16',
        references: [expect.objectContaining({ id: 'girl', displayName: 'My girl', url: fresh })],
      });
    });

    it('resumes a saved remix whose links are still good without reading the source', async () => {
      const good = signed(girlPath, Date.now() + 3_600_000);
      draftStorage.getItem.mockResolvedValue(savedRemix(good));

      const tree = await openRemix();

      expect(authState.api.getRemixSourceBundle).not.toHaveBeenCalled();
      expect(readCreatorSession()).toMatchObject({ tool: 'video', outcome: 'resumed', referenceCount: 1 });
      expect(thumbnail(tree, 'My girl').props.url).toBe(good);
    });

    it('renews a remix thumbnail from its source when it is retried', async () => {
      draftStorage.getItem.mockResolvedValue(savedRemix(signed(girlPath, Date.now() + 3_600_000)));
      const renewedLink = `${STORAGE}/storage/v1/object/sign/${girlPath}?token=renewed`;
      authState.api.getRemixSourceBundle.mockResolvedValue(sourceBundle(renewedLink));
      const tree = await openRemix();

      let renewed: string | undefined;
      await renderer.act(async () => { renewed = await thumbnail(tree, 'My girl').props.resolveRetryUrl(); });

      expect(renewed).toBe(renewedLink);
      expect(authState.api.getRemixSourceBundle).toHaveBeenCalledWith('gen-girl', { postId: 'post-girl' });
      expect(authState.api.createMediaReadUrl).not.toHaveBeenCalled();
      expect(thumbnail(tree, 'My girl').props.url).toBe(renewedLink);
    });

    it("renews the creator's own upload by signing it again when it is retried", async () => {
      catalogState.catalog = createTestGenerationModelCatalog();
      const ownPath = 'uploads/user-123/product.png';
      draftStorage.getItem.mockResolvedValue(JSON.stringify({
        image: {
          ...createDefaultCreationDraft('image'),
          prompt: 'A product shot with @product',
          references: [{ id: 'product', kind: 'image', url: signed(ownPath, Date.now() - 60_000), storagePath: ownPath, fileName: 'product.png', displayName: 'Product', handle: '@product', sourceGenerationId: null }],
        },
        video: createDefaultCreationDraft('video'),
        motion: createDefaultCreationDraft('motion'),
        updatedAt: new Date().toISOString(),
      }));
      const renewedLink = `${STORAGE}/storage/v1/object/sign/${ownPath}?token=renewed`;
      authState.api.createMediaReadUrl.mockResolvedValue({ success: true, signedUrl: renewedLink, expiresInSeconds: 3600 });
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(<MediaCreationScreen initialTool="image" />); });
      await settle();

      let renewed: string | undefined;
      await renderer.act(async () => { renewed = await thumbnail(tree, 'Product').props.resolveRetryUrl(); });

      expect(renewed).toBe(renewedLink);
      expect(authState.api.createMediaReadUrl).toHaveBeenCalledWith({ storagePath: ownPath });
      expect(authState.api.getRemixSourceBundle).not.toHaveBeenCalled();
      expect(thumbnail(tree, 'Product').props.url).toBe(renewedLink);
    });
  });

  // The creators parity pass (archive/web-mobile-creators-compare-2026-10-13, package P7a): what a
  // run sends, what the failure view offers first, and what a draft keeps across a model change,
  // a finished run, a closed creator and a swept upload.
  describe('what a run sends and what a draft keeps', () => {
    const memory = new Map<string, string>();
    const ordinaryKey = creationDraftStorageKey(ordinaryDraftScope('user-123'));
    const activeRunKey = activeGenerationRecordStorageKey('user-123');
    // Past the quote's delay and the autosave's, and past every storage read a load makes.
    const settle = () => renderer.act(async () => { await vi.advanceTimersByTimeAsync(450); });
    const savedDrafts = (overrides: { image?: Record<string, unknown>; video?: Record<string, unknown>; motion?: Record<string, unknown> }) => JSON.stringify({
      image: { ...createDefaultCreationDraft('image'), ...overrides.image },
      video: { ...createDefaultCreationDraft('video'), ...overrides.video },
      motion: { ...createDefaultCreationDraft('motion'), ...overrides.motion },
      updatedAt: new Date().toISOString(),
    });
    const storedDrafts = () => JSON.parse(memory.get(ordinaryKey) ?? 'null');
    const text = (tree: renderer.ReactTestRenderer) => collectText(tree.root).join('\n');
    const pressables = (root: renderer.ReactTestInstance) => root.findAll((node) => String(node.type) === 'pressable');
    const labelled = (root: renderer.ReactTestInstance, label: string) => root.find((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === label
    ));
    const generateButton = (tree: renderer.ReactTestRenderer) => findPressableByLabelPrefix(tree.root, 'Generate');
    const blocker = (tree: renderer.ReactTestRenderer) => collectText(tree.root.findByProps({ testID: 'creator-contextual-blocker' })).join(' ');
    const modelChip = (tree: renderer.ReactTestRenderer) => findPressableByLabelPrefix(tree.root, 'Selected model').props.accessibilityLabel as string;
    const pickModel = async (tree: renderer.ReactTestRenderer, displayName: string) => {
      renderer.act(() => { findPressableByLabelPrefix(tree.root, 'Selected model').props.onPress(); });
      await renderer.act(async () => { findPressableByLabelPrefix(tree.root, `${displayName}.`).props.onPress(); });
    };
    const open = async (element: React.ReactElement, options?: Parameters<typeof renderer.create>[1]) => {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(element, options); });
      await settle();
      return tree;
    };
    const typePrompt = async (tree: renderer.ReactTestRenderer, prompt: string) => {
      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.onChangeText(prompt); });
      await settle();
    };
    const pressGenerate = async (tree: renderer.ReactTestRenderer) => {
      await renderer.act(async () => { void findPressableByLabelPrefix(tree.root, 'Generate ·').props.onPress(); });
      await settle();
    };
    const started = (predictionId: string, extra: Record<string, unknown> = {}) => ({
      success: true, predictionId, generationId: `gen-${predictionId}`, status: 'processing', remainingCredits: 990, cost: 8, ...extra,
    });
    const refusal = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code, details: { code, error: message } });
    const missingUpload = () => Object.assign(new Error('That upload is no longer available.'), { status: 404, code: 'MEDIA_OBJECT_NOT_FOUND' });
    const expiredLink = (path: string) => `https://project.supabase.co/storage/v1/object/sign/${path}?token=head.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() - 3_600_000) / 1000) })).toString('base64url')}.signature`;

    beforeEach(() => {
      vi.useFakeTimers();
      memory.clear();
      draftStorage.getItem.mockImplementation(async (key: string) => memory.get(key) ?? null);
      draftStorage.setItem.mockImplementation(async (key: string, value: string) => { memory.set(key, value); });
      draftStorage.removeItem.mockImplementation(async (key: string) => { memory.delete(key); });
      quoteEchoingSettings();
    });

    describe('a model picked with fewer reference slots', () => {
      const wide = () => parityImageModel('wide-image', 'Wide Image', 5);
      const narrow = () => parityImageModel('narrow-image', 'Narrow Image', 2);
      const fourReferences = () => ['alpha', 'bravo', 'charlie', 'delta'].map((id) => stagedMedia(id));

      it('waits for its descriptor, keeps every reference, and blocks Generate until the extras go; the first model takes them all again', async () => {
        const full = parityCatalog([wide(), narrow()]);
        // The screen holds details for the draft's model only; the picker lists the other by its summary.
        catalogState.catalog = parityCatalog([wide()]);
        catalogState.summaries = full.models;
        let release: () => void = () => undefined;
        catalogState.loadDetails = async () => {
          await new Promise<void>((resolve) => { release = resolve; });
          catalogState.catalog = full;
          return full;
        };
        memory.set(ordinaryKey, savedDrafts({ image: { model: 'wide-image', catalogRevision: 'parity-rev', prompt: 'A bottle on linen', references: fourReferences() } }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        expect(text(tree)).toContain('4 / 5');
        expect(generateButton(tree).props.disabled).toBe(false);

        await pickModel(tree, 'Narrow Image');
        // The row turns while the details load, and the draft stays where it was.
        expect(tree.root.findAllByProps({ testID: 'model-picker-row-loading' })).not.toHaveLength(0);
        expect(modelChip(tree)).toContain('Wide Image');
        await renderer.act(async () => { release(); });
        await settle();

        expect(modelChip(tree)).toContain('Narrow Image');
        expect(text(tree)).not.toContain('Choose model');
        // Two go with the run; two wait, each with its own Remove, under the slot's own message.
        expect(pressables(tree.root).filter((node) => String(node.props.accessibilityLabel).startsWith('Open details for'))).toHaveLength(2);
        const standby = tree.root.findByProps({ testID: 'standby-references' });
        expect(collectText(standby)).toEqual(expect.arrayContaining(['Not sent with this run', 'Reference images supports up to 2 inputs.']));
        expect(pressables(standby).map((node) => node.props.accessibilityLabel)).toEqual(['Remove Charlie', 'Remove Delta']);
        expect(blocker(tree)).toContain('Reference images supports up to 2 inputs.');
        expect(generateButton(tree).props.disabled).toBe(true);
        expect(storedDrafts().image.references.map((media: { id: string }) => media.id)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);

        await pickModel(tree, 'Wide Image');
        await settle();
        expect(modelChip(tree)).toContain('Wide Image');
        expect(tree.root.findAllByProps({ testID: 'standby-references' })).toHaveLength(0);
        expect(text(tree)).toContain('4 / 5');
        expect(generateButton(tree).props.disabled).toBe(false);
      });

      it('lets a waiting extra be removed from the rail, which clears the block', async () => {
        catalogState.catalog = parityCatalog([wide(), narrow()]);
        memory.set(ordinaryKey, savedDrafts({ image: { model: 'narrow-image', catalogRevision: 'parity-rev', prompt: 'A bottle on linen', references: fourReferences().slice(0, 3) } }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        expect(generateButton(tree).props.disabled).toBe(true);

        renderer.act(() => { labelled(tree.root, 'Remove Charlie').props.onPress(); });
        await settle();
        expect(tree.root.findAllByProps({ testID: 'standby-references' })).toHaveLength(0);
        expect(text(tree)).toContain('Charlie was removed from this draft.');
        expect(generateButton(tree).props.disabled).toBe(false);
      });

      it('shows a prompt-only model’s note where the rail was, with the references it keeps waiting beside it', async () => {
        catalogState.catalog = parityCatalog([wide(), parityImageModel('text-image', 'Text Image', 0)]);
        memory.set(ordinaryKey, savedDrafts({ image: { model: 'wide-image', catalogRevision: 'parity-rev', prompt: 'A bottle on linen', references: fourReferences().slice(0, 2) } }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        await pickModel(tree, 'Text Image');
        await settle();
        expect(text(tree)).toContain('Prompt-only model');
        expect(text(tree)).toContain('Text Image does not accept reference images. Switch models whenever you need identity, product, or style anchors.');
        expect(text(tree)).not.toContain('0 / 0');
        expect(collectText(tree.root.findByProps({ testID: 'standby-references' }))).toContain('Text Image does not support image references.');
        expect(generateButton(tree).props.disabled).toBe(true);

        renderer.act(() => { labelled(tree.root, 'Remove Alpha').props.onPress(); });
        renderer.act(() => { labelled(tree.root, 'Remove Bravo').props.onPress(); });
        await settle();
        expect(tree.root.findAllByProps({ testID: 'standby-references' })).toHaveLength(0);
        expect(text(tree)).toContain('Prompt-only model');
        expect(generateButton(tree).props.disabled).toBe(false);
      });

      it('draws no reference as left out while its model’s details are still loading', async () => {
        catalogState.catalog = parityCatalog([wide()]);
        memory.set(ordinaryKey, savedDrafts({ image: { model: 'narrow-image', catalogRevision: 'parity-rev', prompt: 'A bottle on linen', references: fourReferences() } }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        expect(modelChip(tree)).toContain('Loading model settings…');
        expect(tree.root.findAllByProps({ testID: 'standby-references' })).toHaveLength(0);
        expect(pressables(tree.root).filter((node) => String(node.props.accessibilityLabel).startsWith('Open details for'))).toHaveLength(4);
      });

      it('keeps the draft on its model when the picked model’s details cannot be loaded', async () => {
        catalogState.catalog = parityCatalog([wide()]);
        catalogState.summaries = parityCatalog([wide(), narrow()]).models;
        catalogState.loadDetails = async () => { throw new Error('Could not load model settings.'); };
        memory.set(ordinaryKey, savedDrafts({ image: { model: 'wide-image', catalogRevision: 'parity-rev', prompt: 'A bottle on linen', references: fourReferences() } }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        await pickModel(tree, 'Narrow Image');
        expect(text(tree)).toContain('Could not load model settings. Tap to retry.');
        expect(modelChip(tree)).toContain('Wide Image');
        renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Close model picker' }).props.onPress(); });
        await settle();
        expect(text(tree)).toContain('4 / 5');
        expect(storedDrafts().image.model).toBe('wide-image');
      });
    });

    describe('Kling 3.0, the default video model', () => {
      it('adds named video elements, sends them beside its start frame, and offers them to mention', async () => {
        catalogState.catalog = parityCatalog([parityKlingVideo()]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'kling-3.0-video',
          catalogRevision: 'parity-rev',
          prompt: 'The dancer spins',
          startFrame: stagedMedia('door', 'image', { displayName: 'Start Frame' }),
        } }));
        vi.mocked(pickMedia).mockResolvedValue({ uri: 'file:///move.mp4', fileName: 'move.mp4', mimeType: 'video/mp4', fileSize: 4096, duration: 4000 } as never);
        vi.mocked(uploadPickedMedia).mockResolvedValue({
          signedUrl: 'https://cdn.example.com/move.mp4', storagePath: 'uploads/user-123/move.mp4', mimeType: 'video/mp4', fileName: 'move.mp4', kind: 'video', durationSeconds: 4, sizeBytes: 4096,
        });
        authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        expect(text(tree)).toContain('Frames and references');

        await renderer.act(async () => { await labelled(tree.root, 'Add Video 0/3').props.onPress(); });
        await settle();
        expect(text(tree)).not.toContain('This model does not support reference videos.');
        expect(labelled(tree.root, 'Open details for Reference Video')).toBeTruthy();

        let prompt = tree.root.findByProps({ accessibilityLabel: 'Generation prompt' });
        renderer.act(() => prompt.props.onFocus());
        renderer.act(() => prompt.props.onChangeText('The dancer from @ref spins'));
        prompt = tree.root.findByProps({ accessibilityLabel: 'Generation prompt' });
        renderer.act(() => prompt.props.onSelectionChange({ nativeEvent: { selection: { start: 20, end: 20 } } }));
        renderer.act(() => labelled(tree.root, 'Insert @reference_video, Reference Video').props.onPress());
        await settle();

        await pressGenerate(tree);
        expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
        const request = authState.api.startGeneration.mock.calls[0][0] as { prompt: string; inputs: Array<Record<string, unknown>> };
        expect(request.prompt).toBe('The dancer from @reference_video spins');
        expect(request.inputs).toEqual(expect.arrayContaining([
          expect.objectContaining({ slot: 'startFrame', url: 'https://cdn.example.com/door.png' }),
          expect.objectContaining({ slot: 'videoElements', handle: '@reference_video', url: 'https://cdn.example.com/move.mp4', durationSeconds: 4 }),
        ]));
      });

      it('keeps clips from Seedance 2 waiting on Seedance 1.5 Pro, without locking its frames or offering them to mention', async () => {
        const seedanceOneFive: GenerationModelDescriptor = {
          ...paritySeedanceVideo(),
          id: 'seedance-1.5-pro',
          displayName: 'Seedance 1.5 Pro',
          inputs: { imageReferences: { max: 2, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: true, endFrame: true, combineFramesWithReferences: false },
          inputModes: [
            { key: 'frames', label: 'Frames', default: true, conditions: referenceModeIs('frames'), slots: frameSlots },
            {
              key: 'references',
              label: 'Reusable references',
              default: false,
              conditions: referenceModeIs('elements'),
              slots: [{ key: 'imageReferences', kind: 'image', role: 'reference', label: 'Reference images', min: 0, max: 2, supportsNaming: true }],
            },
          ],
        };
        catalogState.catalog = parityCatalog([paritySeedanceVideo(), seedanceOneFive]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'seedance-2',
          catalogRevision: 'parity-rev',
          prompt: 'A walk at dusk',
          referenceVideos: [stagedMedia('stroll', 'video'), stagedMedia('turn', 'video')],
        } }));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        // On Seedance 2 both go with the run.
        expect(tree.root.findAllByProps({ testID: 'standby-references' })).toHaveLength(0);

        await pickModel(tree, 'Seedance 1.5 Pro');
        await settle();
        const standby = tree.root.findByProps({ testID: 'standby-references' });
        expect(pressables(standby).map((node) => node.props.accessibilityLabel)).toEqual(['Remove Stroll', 'Remove Turn']);
        // Nothing the run sends is a reference, so the frames stay open to a start frame.
        let framesGroup: renderer.ReactTestInstance | null = tree.root.findByProps({ testID: 'video-frame-slots' });
        while (framesGroup && framesGroup.props.pointerEvents === undefined) framesGroup = framesGroup.parent;
        expect(framesGroup?.props.pointerEvents).toBe('auto');
        expect(text(tree)).not.toContain('unavailable with references attached');
        expect(generateButton(tree).props.disabled).toBe(false);

        let prompt = tree.root.findByProps({ accessibilityLabel: 'Generation prompt' });
        renderer.act(() => prompt.props.onFocus());
        renderer.act(() => prompt.props.onChangeText('A walk with @st'));
        prompt = tree.root.findByProps({ accessibilityLabel: 'Generation prompt' });
        renderer.act(() => prompt.props.onSelectionChange({ nativeEvent: { selection: { start: 15, end: 15 } } }));
        expect(text(tree)).toContain('No named references match “@st”.');
      });
    });

    describe('a multi-shot run', () => {
      const shot = (id: string, prompt: string, duration: number) => ({ id, prompt, duration });

      it('is quoted and sent at its shots’ total, which the shot editor shows against the cap', async () => {
        catalogState.catalog = parityCatalog([parityKlingVideo()]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'kling-3.0-video',
          catalogRevision: 'parity-rev',
          isMultiShot: true,
          duration: 5,
          multiPrompts: [shot('s1', 'A door opens', 5), shot('s2', 'She walks in', 6)],
        } }));
        authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));
        const tree = await open(<MediaCreationScreen initialTool="video" />);

        expect(collectText(tree.root.findByProps({ testID: 'video-shot-totals' }))).toEqual(['2 of 5 shots · 11s of 15s']);
        expect(authState.api.quoteGenerationModel.mock.lastCall?.[0]).toMatchObject({ settings: expect.objectContaining({ duration: 11 }) });

        await pressGenerate(tree);
        expect(authState.api.startGeneration.mock.calls[0][0]).toMatchObject({
          settings: expect.objectContaining({ duration: 11 }),
          shots: [{ prompt: 'A door opens', duration: 5 }, { prompt: 'She walks in', duration: 6 }],
        });
      });

      it('stops adding shots at the cap, and says when the total runs over', async () => {
        catalogState.catalog = parityCatalog([parityKlingVideo()]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'kling-3.0-video',
          catalogRevision: 'parity-rev',
          isMultiShot: true,
          multiPrompts: ['s1', 's2', 's3', 's4'].map((id) => shot(id, `Beat ${id}`, 3)),
        } }));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        const addShot = () => labelled(tree.root, 'Add shot');
        expect(collectText(tree.root.findByProps({ testID: 'video-shot-totals' }))).toEqual(['4 of 5 shots · 12s of 15s']);
        expect(addShot().props.disabled).toBe(false);

        renderer.act(() => { addShot().props.onPress(); });
        renderer.act(() => { tree.root.findByProps({ testID: 'selected-shot-prompt' }).props.onChangeText('Beat s5'); });
        await settle();
        expect(collectText(tree.root.findByProps({ testID: 'video-shot-totals' }))).toEqual(['5 of 5 shots · 17s of 15s']);
        expect(addShot().props.disabled).toBe(true);
        expect(addShot().props.accessibilityState).toEqual({ disabled: true });
        expect(blocker(tree)).toContain('Kling 3.0 Cinematic multi-shot runs can be at most 15 seconds in total.');
        expect(generateButton(tree).props.disabled).toBe(true);
      });
    });

    // A run is the request its price was quoted for: it carries the draft's settings in the shape
    // the quote request sent them, and the server, which quotes every run again, is the only place
    // they are normalized. The quote here answers with its price and no settings. A run read back
    // from the answer went out at the model's defaults, and a references run lost its input mode.
    describe('the settings each kind of run carries', () => {
      const quotedSettings = () => (authState.api.quoteGenerationModel.mock.lastCall?.[0] as { settings: Record<string, unknown> }).settings;
      const sentRun = () => {
        expect(authState.api.startGeneration).toHaveBeenCalledTimes(1);
        return authState.api.startGeneration.mock.calls[0][0] as {
          settings: Record<string, unknown>;
          inputs: Array<Record<string, unknown>>;
          shots?: Array<Record<string, unknown>>;
        };
      };

      beforeEach(() => {
        authState.api.quoteGenerationModel.mockImplementation(async (request: { modelId: string; catalogRevision: string }) => ({
          modelId: request.modelId,
          catalogRevision: request.catalogRevision,
          normalizedSettings: {},
          costCredits: 8,
        }));
        authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));
      });

      it('an image run', async () => {
        const nanoBanana: GenerationModelDescriptor = {
          ...parityImageModel('nano-banana-2', 'Nano Banana 2.0', 14),
          controls: createRemixRestoreCatalog().models.find((model) => model.id === 'nano-banana-2')!.controls,
        };
        catalogState.catalog = parityCatalog([nanoBanana]);
        memory.set(ordinaryKey, savedDrafts({ image: {
          model: 'nano-banana-2',
          catalogRevision: 'parity-rev',
          prompt: 'A bottle on linen',
          aspectRatio: '9:16',
          resolution: '2K',
          outputFormat: 'png',
          googleSearch: true,
        } }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await pressGenerate(tree);

        expect(sentRun().settings).toEqual({ aspectRatio: '9:16', resolution: '2K', outputFormat: 'png', googleSearch: true });
        expect(sentRun().settings).toEqual(quotedSettings());
      });

      it('a single-shot video run, its duration a choice the server answers as a number', async () => {
        catalogState.catalog = parityCatalog([{ ...seedance15ProModel, availability: { web: true, mobile: true } }]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'seedance-1.5-pro',
          catalogRevision: 'parity-rev',
          prompt: 'A lighthouse in a storm',
          aspectRatio: '16:9',
          resolution: '720p',
          duration: 8,
          sound: true,
          fixedLens: true,
        } }));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        await pressGenerate(tree);

        expect(sentRun().settings).toEqual({
          aspectRatio: '16:9', resolution: '720p', duration: '8', sound: true, fixedLens: true, referenceMode: 'frames',
        });
        expect(sentRun().settings).toEqual(quotedSettings());
        expect(sentRun().inputs).toEqual([]);
      });

      it('a video run with references, in the shape its references take', async () => {
        catalogState.catalog = parityCatalog([paritySeedanceVideo()]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'seedance-2',
          catalogRevision: 'parity-rev',
          prompt: 'The bottle from @hero turns',
          aspectRatio: '9:16',
          duration: 10,
          references: [stagedMedia('hero')],
          referenceVideos: [stagedMedia('stroll', 'video')],
        } }));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        await pressGenerate(tree);

        expect(sentRun().settings).toEqual({ aspectRatio: '9:16', duration: 10, referenceMode: 'elements' });
        expect(sentRun().settings).toEqual(quotedSettings());
        expect(sentRun().inputs).toEqual([
          expect.objectContaining({ slot: 'imageReferences', url: 'https://cdn.example.com/hero.png', handle: '@hero' }),
          expect.objectContaining({ slot: 'videoReferences', url: 'https://cdn.example.com/stroll.mp4', durationSeconds: 4 }),
        ]);
      });

      it('a multi-shot video run, at its shots’ total', async () => {
        catalogState.catalog = parityCatalog([parityKlingVideo()]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'kling-3.0-video',
          catalogRevision: 'parity-rev',
          aspectRatio: '9:16',
          mode: 'pro',
          sound: true,
          duration: 5,
          isMultiShot: true,
          multiPrompts: [{ id: 's1', prompt: 'A door opens', duration: 5 }, { id: 's2', prompt: 'She walks in', duration: 6 }],
        } }));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        await pressGenerate(tree);

        expect(sentRun().settings).toEqual({
          aspectRatio: '9:16', mode: 'pro', duration: 11, sound: true, isMultiShot: true, referenceMode: 'frames',
        });
        expect(sentRun().settings).toEqual(quotedSettings());
        expect(sentRun().shots).toEqual([{ prompt: 'A door opens', duration: 5 }, { prompt: 'She walks in', duration: 6 }]);
      });

      it('a motion run', async () => {
        const kling: GenerationModelDescriptor = {
          ...parityMotionModel(),
          controls: createTestGenerationModelCatalog().models.find((model) => model.id === 'kling-3.0')!.controls,
        };
        catalogState.catalog = parityCatalog([kling]);
        memory.set(ordinaryKey, savedDrafts({ motion: {
          model: 'kling-3.0',
          catalogRevision: 'parity-rev',
          characterImage: stagedMedia('dancer'),
          referenceVideo: stagedMedia('routine', 'video', { durationSeconds: 6 }),
          mode: '1080p',
          characterOrientation: 'image',
          duration: 6,
        } }));
        const tree = await open(<MediaCreationScreen initialTool="motion" />);
        await pressGenerate(tree);

        expect(sentRun().settings).toEqual({ resolution: '1080p', characterOrientation: 'image', duration: 6 });
        expect(sentRun().settings).toEqual(quotedSettings());
        expect(sentRun().inputs).toEqual([
          expect.objectContaining({ slot: 'characterImage', url: 'https://cdn.example.com/dancer.png' }),
          expect.objectContaining({ slot: 'referenceVideo', url: 'https://cdn.example.com/routine.mp4', durationSeconds: 6 }),
        ]);
      });
    });

    describe('a start the server refuses outright', () => {
      const openTyped = async (options?: Parameters<typeof renderer.create>[1]) => {
        const tree = await open(<MediaCreationScreen initialTool="image" />, options);
        await typePrompt(tree, 'A bottle on linen');
        return tree;
      };
      const workspaceButtons = (tree: renderer.ReactTestRenderer) => {
        const workspace = tree.root.findByProps({ testID: 'generation-workspace' });
        return {
          primary: workspace.findAll((node) => node.type === PrimaryButton).map((node) => node.props.label as string),
          secondary: workspace.findAll((node) => node.type === SecondaryButton).map((node) => node.props.label as string),
        };
      };

      it.each([
        ['prompt_blocked', 422, 'Edit prompt'],
        ['insufficient_credits', 402, 'Get credits'],
        ['invalid_input_media', 400, 'Replace reference'],
        ['cost_changed', 409, 'Check the new price'],
        ['CATALOG_CHANGED', 409, 'Review options'],
      ] as const)('leads with what to change for %s, with Try again second', async (code, status, action) => {
        authState.api.startGeneration.mockRejectedValue(refusal(status, code, 'Refused for a reason.'));
        const tree = await openTyped();
        await pressGenerate(tree);

        expect(text(tree)).not.toContain('Generation not confirmed');
        expect(memory.has('magicbooklet.generation.pendingAttempt.v1:user-123')).toBe(false);
        expect(workspaceButtons(tree)).toEqual({ primary: [action], secondary: ['Try again · 8 credits', 'Back to creator'] });
      });

      it('keeps Try again first for a refusal with nothing else to change, and never calls it unconfirmed', async () => {
        authState.api.startGeneration.mockRejectedValue(refusal(503, 'provider_unavailable', 'The video service is unavailable right now. No credits were used.'));
        const tree = await openTyped();
        await pressGenerate(tree);

        expect(text(tree)).not.toContain('Generation not confirmed');
        expect(text(tree)).toContain('The video service is unavailable right now. No credits were used.');
        expect(workspaceButtons(tree)).toEqual({ primary: ['Try again · 8 credits'], secondary: ['Back to creator'] });
      });

      it('takes a blocked prompt back to the prompt, with the reason under it', async () => {
        const focus = vi.fn();
        authState.api.startGeneration.mockRejectedValue(refusal(422, 'prompt_blocked', 'This prompt was blocked by our safety checks.'));
        const tree = await openTyped({
          createNodeMock: (element) => (String(element.type) === 'textinput' ? { focus, setNativeProps: vi.fn() } : null),
        });
        await pressGenerate(tree);
        focus.mockClear();

        renderer.act(() => { labelled(tree.root.findByProps({ testID: 'generation-workspace' }), 'Edit prompt').props.onPress(); });
        expect(tree.root.findAllByProps({ testID: 'generation-workspace' })).toHaveLength(0);
        expect(text(tree)).toContain('This prompt was blocked by our safety checks.');
        expect(focus).toHaveBeenCalled();
      });

      it('reads the balance again on a refusal for credits, and opens credits from the failure', async () => {
        authState.api.startGeneration.mockRejectedValue(refusal(402, 'insufficient_credits', 'Insufficient credits.'));
        const tree = await openTyped();
        await pressGenerate(tree);
        expect(authState.refreshProfile).toHaveBeenCalledTimes(1);

        renderer.act(() => { labelled(tree.root.findByProps({ testID: 'generation-workspace' }), 'Get credits').props.onPress(); });
        expect(routerState.push).toHaveBeenCalledWith('/(tabs)/pricing');
        expect(tree.root.findAllByProps({ testID: 'generation-workspace' })).toHaveLength(0);
      });

      it('prices the run again when the price changed', async () => {
        authState.api.startGeneration.mockRejectedValue(refusal(409, 'cost_changed', 'The price of this run changed. Check the updated cost and generate again.'));
        const tree = await openTyped();
        const quotesBefore = authState.api.quoteGenerationModel.mock.calls.length;
        await pressGenerate(tree);
        expect(authState.api.quoteGenerationModel.mock.calls.length).toBeGreaterThan(quotesBefore);

        renderer.act(() => { labelled(tree.root.findByProps({ testID: 'generation-workspace' }), 'Check the new price').props.onPress(); });
        expect(blocker(tree)).toContain('The price of this run changed.');
      });

      it('asks storage which reference is gone when the server cannot use the run’s media, and marks it', async () => {
        memory.set(ordinaryKey, savedDrafts({ image: { prompt: 'A bottle with @alpha', references: [stagedMedia('alpha')] } }));
        authState.api.startGeneration.mockRejectedValue(refusal(400, 'invalid_input_media', 'This reference upload has expired. Add it again.'));
        authState.api.createMediaReadUrl.mockRejectedValue(missingUpload());
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        // Its link cannot be dated, so opening the draft asked nothing.
        expect(authState.api.createMediaReadUrl).not.toHaveBeenCalled();

        await pressGenerate(tree);
        expect(authState.api.createMediaReadUrl).toHaveBeenCalledWith({ storagePath: 'uploads/user-123/alpha.png' });
        renderer.act(() => { labelled(tree.root.findByProps({ testID: 'generation-workspace' }), 'Replace reference').props.onPress(); });
        expect(tree.root.findAllByProps({ testID: 'reference-unavailable-alpha' })).not.toHaveLength(0);
        expect(blocker(tree)).toContain('This reference upload has expired. Add it again.');
      });
    });

    describe('a run the creator closed on', () => {
      const activeRun = (tool: 'image' | 'video', predictionId: string) => JSON.stringify({
        version: 1, identityUserId: 'user-123', tool, predictionId, generationId: `gen-${predictionId}`, startedAt: Date.now() - 60_000, estimatedTotalMs: null,
      });

      it('is kept from the start’s answer until it ends', async () => {
        authState.api.startGeneration.mockResolvedValue(started('pred-live'));
        let finish: (status: unknown) => void = () => undefined;
        authState.api.getImageGeneration.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await pressGenerate(tree);

        expect(JSON.parse(memory.get(activeRunKey)!)).toMatchObject({
          version: 1, identityUserId: 'user-123', tool: 'image', predictionId: 'pred-live', generationId: 'gen-pred-live',
        });
        await renderer.act(async () => { finish({ status: 'succeeded', output: 'https://cdn.example.com/out.png' }); });
        await settle();
        expect(text(tree)).toContain('Your image');
        expect(memory.has(activeRunKey)).toBe(false);
      });

      it('is watched again when the creator opens on its tool, rather than offering Generate', async () => {
        memory.set(activeRunKey, activeRun('image', 'pred-earlier'));
        authState.api.getImageGeneration.mockResolvedValue({ status: 'succeeded', output: 'https://cdn.example.com/earlier.png' });
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        expect(authState.api.getImageGeneration).toHaveBeenCalledWith('pred-earlier');
        expect(text(tree)).toContain('Your image');
        renderer.act(() => { labelled(tree.root, 'Post to feed').props.onPress(); });
        expect(routerState.push).toHaveBeenCalledWith({ pathname: '/post/new', params: { generationId: 'gen-pred-earlier' } });
        expect(authState.api.startGeneration).not.toHaveBeenCalled();
        expect(memory.has(activeRunKey)).toBe(false);
      });

      it('is offered from another tool, and opens with its progress', async () => {
        memory.set(activeRunKey, activeRun('video', 'pred-video'));
        authState.api.getVideoGeneration.mockReturnValue(new Promise(() => undefined));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        expect(text(tree)).toContain('A video run is in progress.');
        expect(authState.api.getVideoGeneration).not.toHaveBeenCalled();
        await renderer.act(async () => { labelled(tree.root, 'Open').props.onPress(); });
        expect(authState.api.getVideoGeneration).toHaveBeenCalledWith('pred-video');
        expect(text(tree)).toContain('Creating video');
        expect(text(tree)).not.toContain('A video run is in progress.');
      });
    });

    it('says a failed run’s credits came back, and reads the balance again', async () => {
      authState.api.startGeneration.mockResolvedValue(started('pred-failed'));
      authState.api.getImageGeneration.mockResolvedValue({ status: 'failed', error: 'The image provider timed out.' });
      const tree = await open(<MediaCreationScreen initialTool="image" />);
      await typePrompt(tree, 'A bottle on linen');
      await pressGenerate(tree);

      expect(text(tree)).toContain('The image provider timed out.');
      expect(text(tree)).toContain('Your 8 credits were returned.');
      expect(authState.refreshProfile).toHaveBeenCalledTimes(1);
    });

    describe('the wait', () => {
      const waitPanel = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => (
        String(node.type) === 'view' && node.props.accessibilityRole === 'progressbar'
      ));
      const estimate = (tree: renderer.ReactTestRenderer) => waitPanel(tree).findAll((node) => (
        String(node.type) === 'view' && node.props.testID === 'generation-wait-estimate'
      ));
      const barWidth = (tree: renderer.ReactTestRenderer) => (waitPanel(tree).find((node) => (
        String(node.type) === 'view' && node.props.testID === 'generation-wait-bar'
      )).props.style as { width: string }).width;
      const spinners = (tree: renderer.ReactTestRenderer) => waitPanel(tree).findAll((node) => String(node.type) === 'activity-indicator');
      /** The status as the server's image route sends it, from a start fixed at the first read. */
      const processing = (estimatedTotalMs: number | null) => {
        let startedAtMs: number | null = null;
        return async () => {
          startedAtMs ??= Date.now() - 15_000;
          return {
            status: 'processing',
            timing: { appStatus: 'processing', providerState: 'generating', phaseLabel: 'Generating', startedAtMs, updatedAtMs: null, completedAtMs: null, elapsedMs: 15_000, completedInMs: null, estimatedTotalMs },
          };
        };
      };

      it('counts down the server’s estimate on a filling bar, and says so once the estimate has passed', async () => {
        authState.api.startGeneration.mockResolvedValue(started('pred-estimate'));
        authState.api.getImageGeneration.mockImplementation(processing(60_000));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await pressGenerate(tree);

        expect(estimate(tree)).toHaveLength(1);
        expect(spinners(tree)).toHaveLength(0);
        expect(collectText(waitPanel(tree))).toContain('Est. 0:45 left');
        expect(barWidth(tree)).toBe('25%');
        // The phase and the time it has run stay under it.
        expect(collectText(waitPanel(tree)).join(' ')).toContain('The model is working on it now. Running for');

        await renderer.act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(collectText(waitPanel(tree))).toContain('Est. 0:15 left');
        expect(barWidth(tree)).toBe('75%');

        await renderer.act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(collectText(waitPanel(tree))).toContain('Taking longer than usual');
        expect(barWidth(tree)).toBe('96%');
      });

      it('keeps the spinner, the phase and the time it has run for a status with no estimate', async () => {
        authState.api.startGeneration.mockResolvedValue(started('pred-no-estimate'));
        authState.api.getImageGeneration.mockImplementation(processing(null));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await pressGenerate(tree);

        expect(estimate(tree)).toHaveLength(0);
        expect(spinners(tree)).toHaveLength(1);
        const said = collectText(waitPanel(tree)).join(' ');
        expect(said).toContain('Making your image');
        expect(said).toContain('The model is working on it now. Running for 0:00.');
        expect(said).not.toContain('Est.');
      });

      it('tells a guest whose run outlasts the watch to sign in for an alert, rather than to check Alerts', async () => {
        // A guest gets no push, and Alerts asks them to sign in.
        authState.user = null;
        authState.isGuest = true;
        authState.api.startGeneration.mockResolvedValue(started('pred-guest-long'));
        authState.api.getImageGeneration.mockResolvedValue({ status: 'processing' });
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await pressGenerate(tree);

        await renderer.act(async () => { await vi.advanceTimersByTimeAsync(13 * 60_000); });

        const said = text(tree);
        expect(said).toContain('Progress check interrupted');
        expect(said).toContain('Generation is still processing. Sign in to get an alert when it’s done. Until then, come back to this screen.');
        expect(said).not.toContain('Check Alerts');
      });
    });

    describe('saved drafts', () => {
      it('keeps every tool’s draft after a run succeeds, as saved', async () => {
        memory.set(ordinaryKey, savedDrafts({ video: { prompt: 'My video idea' } }));
        authState.api.startGeneration.mockResolvedValue(started('pred-done'));
        authState.api.getImageGeneration.mockResolvedValue({ status: 'succeeded', output: 'https://cdn.example.com/done.png' });
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'An image prompt');
        await pressGenerate(tree);

        expect(text(tree)).toContain('Your image');
        expect(draftStorage.removeItem).not.toHaveBeenCalledWith(ordinaryKey);
        expect(storedDrafts()).toMatchObject({ image: { prompt: 'An image prompt' }, video: { prompt: 'My video idea' } });
      });

      it('ends a remix’s saved session when a run in it succeeds', async () => {
        const source = { generationId: 'gen-1', postId: 'post-1' };
        authState.api.getRemixSourceBundle.mockResolvedValue({
          generation: { id: 'gen-1', title: 'Source', prompt: 'Restore this prompt.', category: 'image', model: 'nano-banana-2' },
          result: null,
          inputs: { image: { elements: [] } },
          workflowSettings: { model: 'nano-banana-2', aspectRatio: '4:5', resolution: '1K' },
          restoreIssues: [],
        });
        authState.api.startGeneration.mockResolvedValue(started('pred-remix'));
        authState.api.getImageGeneration.mockResolvedValue({ status: 'succeeded', output: 'https://cdn.example.com/remix.png' });
        const tree = await open(<MediaCreationScreen initialTool="image" remixSource={source} />);
        await settle();
        expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('Restore this prompt.');
        await pressGenerate(tree);

        expect(text(tree)).toContain('Your image');
        expect(draftStorage.removeItem).toHaveBeenCalledWith(creationDraftStorageKey(remixDraftScope('user-123', source)!));
      });

      it('opens a prompt-only link on the saved drafts, replacing only its own tool’s prompt', async () => {
        memory.set(ordinaryKey, savedDrafts({ image: { prompt: 'My old image prompt' }, video: { prompt: 'My video draft' } }));
        const tree = await open(<MediaCreationScreen initialTool="image" initialPrompt="From a deep link" />);

        expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('From a deep link');
        expect(storedDrafts()).toMatchObject({ image: { prompt: 'From a deep link' }, video: { prompt: 'My video draft' } });
        renderer.act(() => { labelled(tree.root, 'Video').props.onPress(); });
        expect(tree.root.findByProps({ accessibilityLabel: 'Generation prompt' }).props.value).toBe('My video draft');
      });
    });

    describe('a staged upload the server has swept', () => {
      it('is marked to add again when the resumed draft’s link renews to a 404, and holds Generate until it is removed', async () => {
        memory.set(ordinaryKey, savedDrafts({ image: {
          prompt: 'A bottle on linen',
          references: [stagedMedia('alpha', 'image', { url: expiredLink('uploads/user-123/alpha.png') }), stagedMedia('bravo')],
        } }));
        authState.api.createMediaReadUrl.mockRejectedValue(missingUpload());
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        // Only the upload whose link had run out was asked about.
        expect(authState.api.createMediaReadUrl).toHaveBeenCalledTimes(1);
        expect(authState.api.createMediaReadUrl).toHaveBeenCalledWith({ storagePath: 'uploads/user-123/alpha.png' });
        expect(collectText(tree.root.findByProps({ testID: 'reference-unavailable-alpha' }))).toEqual(['Add this reference again']);
        expect(tree.root.findAllByProps({ testID: 'reference-unavailable-bravo' })).toHaveLength(0);
        expect(blocker(tree)).toContain('Alpha is no longer available. Add this reference again.');
        expect(generateButton(tree).props.disabled).toBe(true);

        renderer.act(() => { labelled(tree.root, 'Open details for Alpha').props.onPress(); });
        renderer.act(() => { labelled(tree.root, 'Remove Alpha').props.onPress(); });
        const buttons = nativeAlertState.alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
        await renderer.act(async () => {
          buttons.find((button) => button.text === 'Remove')?.onPress?.();
          await Promise.resolve();
        });
        await settle();
        expect(generateButton(tree).props.disabled).toBe(false);
      });

      it('is marked when a tile’s retry renews its link to a 404', async () => {
        memory.set(ordinaryKey, savedDrafts({ image: { prompt: 'A bottle on linen', references: [stagedMedia('alpha')] } }));
        authState.api.createMediaReadUrl.mockRejectedValue(missingUpload());
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        const thumbnail = labelled(tree.root, 'Open details for Alpha').find((node) => String(node.type) === 'stable-media-image');

        await renderer.act(async () => { await expect(thumbnail.props.resolveRetryUrl()).rejects.toThrow('That upload is no longer available.'); });
        expect(tree.root.findAllByProps({ testID: 'reference-unavailable-alpha' })).not.toHaveLength(0);
        expect(generateButton(tree).props.disabled).toBe(true);
      });
    });

    it('asks for no motion quote until both inputs are attached, and says what to add', async () => {
      vi.mocked(pickMedia)
        .mockResolvedValueOnce({ uri: 'file:///dancer.png', fileName: 'dancer.png', mimeType: 'image/png', fileSize: 2048 } as never)
        .mockResolvedValueOnce({ uri: 'file:///moves.mp4', fileName: 'moves.mp4', mimeType: 'video/mp4', fileSize: 4096, duration: 6000 } as never);
      vi.mocked(uploadPickedMedia)
        .mockResolvedValueOnce({ signedUrl: 'https://cdn.example.com/dancer.png', storagePath: 'uploads/user-123/dancer.png', mimeType: 'image/png', fileName: 'dancer.png', kind: 'image', durationSeconds: null, sizeBytes: 2048 })
        .mockResolvedValueOnce({ signedUrl: 'https://cdn.example.com/moves.mp4', storagePath: 'uploads/user-123/moves.mp4', mimeType: 'video/mp4', fileName: 'moves.mp4', kind: 'video', durationSeconds: 6, sizeBytes: 4096 });
      const tree = await open(<MediaCreationScreen initialTool="motion" />);

      expect(authState.api.quoteGenerationModel).not.toHaveBeenCalled();
      expect(blocker(tree)).toBe('Add a character image and a motion clip.');
      expect(generateButton(tree).props.accessibilityLabel).toBe('Generate');
      expect(generateButton(tree).props.disabled).toBe(true);

      await renderer.act(async () => { await labelled(tree.root, 'Add character image').props.onPress(); });
      await settle();
      expect(authState.api.quoteGenerationModel).not.toHaveBeenCalled();

      await renderer.act(async () => { await labelled(tree.root, 'Add motion video').props.onPress(); });
      await settle();
      expect(authState.api.quoteGenerationModel).toHaveBeenCalledTimes(1);
      expect(authState.api.quoteGenerationModel.mock.calls[0][0]).toMatchObject({ kind: 'motion', inputCounts: { images: 1, videos: 1 } });
      expect(generateButton(tree).props.accessibilityLabel).toBe('Generate · 8 credits');
    });
  });

  describe('uploads, the result, the enhancer and the way back from sign-in', () => {
    const memory = new Map<string, string>();
    const ordinaryKey = creationDraftStorageKey(ordinaryDraftScope('user-123'));
    // Past the quote's delay and the autosave's, and past every storage read a load makes.
    const settle = () => renderer.act(async () => { await vi.advanceTimersByTimeAsync(450); });
    const savedDrafts = (overrides: { image?: Record<string, unknown>; video?: Record<string, unknown>; motion?: Record<string, unknown> }) => JSON.stringify({
      image: { ...createDefaultCreationDraft('image'), ...overrides.image },
      video: { ...createDefaultCreationDraft('video'), ...overrides.video },
      motion: { ...createDefaultCreationDraft('motion'), ...overrides.motion },
      updatedAt: new Date().toISOString(),
    });
    const storedDrafts = () => JSON.parse(memory.get(ordinaryKey) ?? 'null');
    const text = (tree: renderer.ReactTestRenderer) => collectText(tree.root).join('\n');
    const labelled = (root: renderer.ReactTestInstance, label: string) => root.find((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === label
    ));
    const hasLabel = (root: renderer.ReactTestInstance, label: string) => root.findAll((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === label
    )).length > 0;
    const blocker = (tree: renderer.ReactTestRenderer) => collectText(tree.root.findByProps({ testID: 'creator-contextual-blocker' })).join(' ');
    const open = async (element: React.ReactElement) => {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => { tree = renderer.create(element); });
      await settle();
      return tree;
    };
    const typePrompt = async (tree: renderer.ReactTestRenderer, prompt: string, label = 'Generation prompt') => {
      renderer.act(() => { tree.root.findByProps({ accessibilityLabel: label }).props.onChangeText(prompt); });
      await settle();
    };
    // A press whose work is still running when the case looks: its first steps land, and nothing waits on the rest.
    const pressAndLook = (pressable: renderer.ReactTestInstance) => renderer.act(async () => {
      void pressable.props.onPress();
      await vi.advanceTimersByTimeAsync(0);
    });
    const pressGenerate = async (tree: renderer.ReactTestRenderer) => {
      await renderer.act(async () => { void findPressableByLabelPrefix(tree.root, 'Generate ·').props.onPress(); });
      await settle();
    };
    const started = (predictionId: string) => ({
      success: true, predictionId, generationId: `gen-${predictionId}`, status: 'processing', remainingCredits: 990, cost: 8,
    });
    const pickedImage = (fileName: string, fileSize = 2048) => ({ uri: `file:///${fileName}`, fileName, mimeType: 'image/png', fileSize });
    const uploaded = (fileName: string, extra: Partial<UploadedMedia> = {}): UploadedMedia => ({
      signedUrl: `https://cdn.example.com/${fileName}`,
      storagePath: `uploads/user-123/${fileName}`,
      mimeType: 'image/png',
      fileName,
      kind: 'image',
      durationSeconds: null,
      sizeBytes: 2048,
      ...extra,
    });
    const thumbnailUrl = (tree: renderer.ReactTestRenderer, name: string) => labelled(tree.root, `Open details for ${name}`)
      .find((node) => String(node.type) === 'stable-media-image').props.url as string;

    beforeEach(() => {
      vi.useFakeTimers();
      memory.clear();
      draftStorage.getItem.mockImplementation(async (key: string) => memory.get(key) ?? null);
      draftStorage.setItem.mockImplementation(async (key: string, value: string) => { memory.set(key, value); });
      draftStorage.removeItem.mockImplementation(async (key: string) => { memory.delete(key); });
      quoteEchoingSettings();
      authState.api.enhancePrompt.mockReset();
    });

    describe('picked references', () => {
      it('upload two at a time, keep every one that arrives, and name the one that did not', async () => {
        vi.mocked(pickMediaList).mockResolvedValue([pickedImage('alpha.png'), pickedImage('bravo.png'), pickedImage('charlie.png')] as never);
        const finishes: Array<() => void> = [];
        vi.mocked(uploadPickedMedia).mockImplementation((uri) => new Promise<UploadedMedia>((resolve, reject) => {
          finishes.push(() => (uri === 'file:///bravo.png'
            ? reject(new Error('Upload failed with status 500.'))
            : resolve(uploaded(uri.replace('file:///', '')))));
        }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        await pressAndLook(labelled(tree.root, 'Add reference images'));
        // Two at once, each able to report its bytes and to be stopped, where the loop sent one at a time.
        expect(uploadPickedMedia).toHaveBeenCalledTimes(2);
        expect(vi.mocked(uploadPickedMedia).mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
        await renderer.act(async () => { finishes[0](); finishes[1](); });
        expect(uploadPickedMedia).toHaveBeenCalledTimes(3);
        await renderer.act(async () => { finishes[2](); });
        await settle();

        expect(labelled(tree.root, 'Open details for alpha')).toBeTruthy();
        expect(labelled(tree.root, 'Open details for charlie')).toBeTruthy();
        expect(hasLabel(tree.root, 'Open details for bravo')).toBe(false);
        expect(blocker(tree)).toBe('Added 2 of 3. Could not add bravo.png. Upload failed with status 500.');
        expect(storedDrafts().image.references.map((media: { fileName: string }) => media.fileName)).toEqual(['alpha.png', 'charlie.png']);
      });

      it('show on the add tile how far their bytes have got', async () => {
        vi.mocked(pickMediaList).mockResolvedValue([pickedImage('alpha.png', 4096)] as never);
        let finish: () => void = () => undefined;
        vi.mocked(uploadPickedMedia).mockImplementation((_uri, options) => new Promise<UploadedMedia>((resolve) => {
          options?.onProgress?.({ bytesSent: 1024, totalBytes: 4096, fraction: 0.25 });
          finish = () => resolve(uploaded('alpha.png', { sizeBytes: 4096 }));
        }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        await pressAndLook(labelled(tree.root, 'Add reference images'));
        expect(collectText(tree.root.findByProps({ testID: 'reference-upload-progress' }))).toEqual(['25%']);
        expect(labelled(tree.root, 'Uploading reference images, 25%').props.disabled).toBe(true);

        await renderer.act(async () => { finish(); });
        await settle();
        expect(tree.root.findAllByProps({ testID: 'reference-upload-progress' })).toHaveLength(0);
        expect(labelled(tree.root, 'Open details for alpha')).toBeTruthy();
      });

      it('get handles of their own when the same photo is picked again or two are named alike', async () => {
        memory.set(ordinaryKey, savedDrafts({ image: { prompt: 'Put @bravo on the table', references: [stagedMedia('alpha'), stagedMedia('bravo')] } }));
        vi.mocked(pickMediaList).mockResolvedValue([pickedImage('alpha.png')] as never);
        vi.mocked(uploadPickedMedia).mockResolvedValue(uploaded('alpha.png'));
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        await renderer.act(async () => { await labelled(tree.root, 'Add reference images').props.onPress(); });
        await settle();
        expect(storedDrafts().image.references.map((media: { handle: string }) => media.handle)).toEqual(['@alpha', '@bravo', '@alpha_2']);

        renderer.act(() => { labelled(tree.root, 'Open details for Bravo').props.onPress(); });
        renderer.act(() => { tree.root.findByProps({ accessibilityLabel: 'Reference name for Bravo' }).props.onChangeText('Alpha'); });
        await settle();
        expect(storedDrafts().image.references.map((media: { handle: string }) => media.handle)).toEqual(['@alpha', '@alpha_3', '@alpha_2']);
        expect(storedDrafts().image.prompt).toBe('Put @alpha_3 on the table');
      });

      it('are drawn from the picker’s copy this session, saved and sent as their link, and drawn from the link after a restart', async () => {
        // A descriptor with input modes, as production publishes, so the run carries its references.
        catalogState.catalog = parityCatalog([parityImageModel('wide-image', 'Wide Image', 5)]);
        memory.set(ordinaryKey, savedDrafts({ image: { model: 'wide-image', catalogRevision: 'parity-rev' } }));
        vi.mocked(pickMediaList).mockResolvedValue([pickedImage('hero.png')] as never);
        vi.mocked(uploadPickedMedia).mockResolvedValue(uploaded('hero.png'));
        authState.api.startGeneration.mockReturnValue(new Promise(() => undefined));
        const first = await open(<MediaCreationScreen initialTool="image" />);
        await renderer.act(async () => { await labelled(first.root, 'Add reference images').props.onPress(); });
        await typePrompt(first, 'A bottle beside @hero');

        expect(thumbnailUrl(first, 'hero')).toBe('file:///hero.png');
        expect(memory.get(ordinaryKey)).toContain('https://cdn.example.com/hero.png');
        expect(memory.get(ordinaryKey)).not.toContain('file://');
        await pressGenerate(first);
        const request = JSON.stringify(authState.api.startGeneration.mock.calls[0][0]);
        expect(request).toContain('https://cdn.example.com/hero.png');
        expect(request).not.toContain('file://');
        renderer.act(() => { first.unmount(); });

        const second = await open(<MediaCreationScreen initialTool="image" />);
        expect(thumbnailUrl(second, 'hero')).toBe('https://cdn.example.com/hero.png');
      });
    });

    describe('clips', () => {
      /** An upload that runs until it is cancelled, as a large clip on mobile data does. */
      const uploadUntilCancelled = () => {
        const seen: { signal?: AbortSignal } = {};
        vi.mocked(uploadPickedMedia).mockImplementation((_uri, options) => new Promise<UploadedMedia>((_resolve, reject) => {
          seen.signal = options?.signal;
          options?.signal?.addEventListener('abort', () => reject(new UploadCancelledError()));
        }));
        return seen;
      };

      it('can be cancelled from the video rail, which adds nothing', async () => {
        catalogState.catalog = parityCatalog([parityKlingVideo()]);
        vi.mocked(pickMedia).mockResolvedValue({ uri: 'file:///move.mp4', fileName: 'move.mp4', mimeType: 'video/mp4', fileSize: 80 * 1024 * 1024, duration: 4000 } as never);
        const upload = uploadUntilCancelled();
        const tree = await open(<MediaCreationScreen initialTool="video" />);

        await pressAndLook(labelled(tree.root, 'Add Video 0/3'));
        expect(labelled(tree.root, 'Uploading Video 0/3, 0%')).toBeTruthy();
        await pressAndLook(labelled(tree.root, 'Cancel upload'));
        await settle();

        expect(upload.signal?.aborted).toBe(true);
        expect(blocker(tree)).toBe('Upload cancelled.');
        expect(hasLabel(tree.root, 'Cancel upload')).toBe(false);
        expect(hasLabel(tree.root, 'Open details for Reference Video')).toBe(false);
        expect(labelled(tree.root, 'Add Video 0/3').props.disabled).toBe(false);
      });

      it('can be cancelled from the motion slot', async () => {
        vi.mocked(pickMedia).mockResolvedValue({ uri: 'file:///dance.mp4', fileName: 'dance.mp4', mimeType: 'video/mp4', fileSize: 90 * 1024 * 1024, duration: 12_000 } as never);
        const upload = uploadUntilCancelled();
        const tree = await open(<MediaCreationScreen initialTool="motion" />);

        await pressAndLook(labelled(tree.root, 'Add motion video'));
        expect(labelled(tree.root, 'Uploading motion video, 0%')).toBeTruthy();
        await pressAndLook(labelled(tree.root, 'Cancel upload'));
        await settle();

        expect(upload.signal?.aborted).toBe(true);
        expect(blocker(tree)).toBe('Upload cancelled.');
        expect(labelled(tree.root, 'Add motion video')).toBeTruthy();
      });

      it.each([
        ['longer than its slot takes', { duration: 31_000, fileSize: 20 * 1024 * 1024 }, 'Reference video exceeds 30s. Please choose a shorter clip.'],
        ['over 100 MB', { duration: 12_000, fileSize: 101 * 1024 * 1024 }, '"dance.mp4" is over 100 MB. Please upload a smaller video.'],
      ])('for motion are refused at the pick when %s, before a byte is sent, in the web creator’s words', async (_case, asset, refusal) => {
        vi.mocked(pickMedia).mockResolvedValue({ uri: 'file:///dance.mp4', fileName: 'dance.mp4', mimeType: 'video/mp4', ...asset } as never);
        const tree = await open(<MediaCreationScreen initialTool="motion" />);

        await renderer.act(async () => { await labelled(tree.root, 'Add motion video').props.onPress(); });
        await settle();
        expect(uploadPickedMedia).not.toHaveBeenCalled();
        expect(blocker(tree)).toBe(refusal);
      });

      it('for motion are held to the length the model’s slot publishes', async () => {
        const model = parityMotionModel();
        model.inputModes![0].slots[1] = { ...model.inputModes![0].slots[1], maxDurationSeconds: 20 };
        catalogState.catalog = parityCatalog([model]);
        vi.mocked(pickMedia).mockResolvedValue({ uri: 'file:///dance.mp4', fileName: 'dance.mp4', mimeType: 'video/mp4', fileSize: 4096, duration: 25_000 } as never);
        const tree = await open(<MediaCreationScreen initialTool="motion" />);

        // The slot is named by the descriptor.
        await renderer.act(async () => { await labelled(tree.root, 'Add reference video').props.onPress(); });
        await settle();
        expect(uploadPickedMedia).not.toHaveBeenCalled();
        expect(blocker(tree)).toBe('Reference video exceeds 20s. Please choose a shorter clip.');
      });

      it('for motion are replaced in place from the details sheet, and from Inputs, keeping the clip’s name', async () => {
        memory.set(ordinaryKey, savedDrafts({ motion: {
          characterImage: stagedMedia('dancer', 'image', { displayName: 'Dancer' }),
          referenceVideo: stagedMedia('moves', 'video', { displayName: 'Moves', durationSeconds: 6 }),
          duration: 6,
        } }));
        vi.mocked(pickMedia)
          .mockResolvedValueOnce({ uri: 'file:///twirl.mp4', fileName: 'twirl.mp4', mimeType: 'video/mp4', fileSize: 4096, duration: 9000 } as never)
          .mockResolvedValueOnce({ uri: 'file:///spin.mp4', fileName: 'spin.mp4', mimeType: 'video/mp4', fileSize: 4096, duration: 7000 } as never);
        vi.mocked(uploadPickedMedia)
          .mockResolvedValueOnce(uploaded('twirl.mp4', { mimeType: 'video/mp4', kind: 'video', durationSeconds: 9 }))
          .mockResolvedValueOnce(uploaded('spin.mp4', { mimeType: 'video/mp4', kind: 'video', durationSeconds: 7 }));
        const tree = await open(<MediaCreationScreen initialTool="motion" />);

        renderer.act(() => { labelled(tree.root, 'Open details for Moves').props.onPress(); });
        await renderer.act(async () => { await labelled(tree.root, 'Replace Moves').props.onPress(); });
        await settle();
        expect(storedDrafts().motion.referenceVideo).toMatchObject({ displayName: 'Moves', url: 'https://cdn.example.com/twirl.mp4', storagePath: 'uploads/user-123/twirl.mp4', durationSeconds: 9 });
        expect(storedDrafts().motion.duration).toBe(9);

        renderer.act(() => { labelled(tree.root, 'Close reference details').props.onPress(); });
        await renderer.act(async () => { await labelled(tree.root, 'Inputs').props.onPress(); });
        await settle();
        expect(text(tree)).not.toContain('This model supports up to 1 reference video.');
        expect(storedDrafts().motion.referenceVideo).toMatchObject({ displayName: 'Moves', url: 'https://cdn.example.com/spin.mp4', durationSeconds: 7 });
      });
    });

    describe('the result', () => {
      it('pages through every output of a run, and Post to feed posts the run, whose first output is its primary', async () => {
        authState.api.startGeneration.mockResolvedValue(started('pred-many'));
        authState.api.getImageGeneration.mockResolvedValue({
          status: 'succeeded',
          output: 'https://cdn.example.com/one.png',
          outputs: ['https://cdn.example.com/one.png', 'https://cdn.example.com/two.png', 'https://cdn.example.com/three.png'],
        });
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'Three takes on a bottle');
        await pressGenerate(tree);

        const workspace = () => tree.root.findByProps({ testID: 'generation-workspace' });
        const shown = () => workspace().find((node) => String(node.type) === 'media-preview').props.url;
        expect(shown()).toBe('https://cdn.example.com/one.png');
        expect(collectText(workspace())).toContain('1 of 3');
        expect(labelled(workspace(), 'Previous output').props.disabled).toBe(true);

        renderer.act(() => { labelled(workspace(), 'Next output').props.onPress(); });
        expect(shown()).toBe('https://cdn.example.com/two.png');
        renderer.act(() => { labelled(workspace(), 'Next output').props.onPress(); });
        expect(shown()).toBe('https://cdn.example.com/three.png');
        expect(collectText(workspace())).toContain('3 of 3');
        expect(labelled(workspace(), 'Next output').props.disabled).toBe(true);

        renderer.act(() => { labelled(workspace(), 'Post to feed').props.onPress(); });
        expect(routerState.push).toHaveBeenCalledWith({ pathname: '/post/new', params: { generationId: 'gen-pred-many' } });
      });

      it('shares through the composer, which posts it and then opens the share sheet, and marks Profile’s creations stale at the start and the end', async () => {
        const invalidate = vi.spyOn(testQueryClient, 'invalidateQueries');
        const creationsMarked = () => invalidate.mock.calls.filter(([filters]) => (filters as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === 'profile-generations');
        authState.api.startGeneration.mockResolvedValue(started('pred-share'));
        let finish: (status: unknown) => void = () => undefined;
        authState.api.getImageGeneration.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await pressGenerate(tree);

        // The Rendering strip shows the run from its start.
        expect(creationsMarked()).toEqual([[{ queryKey: ['profile-generations', 'user-123'], refetchType: 'none' }]]);
        await renderer.act(async () => { finish({ status: 'succeeded', output: 'https://cdn.example.com/out.png' }); });
        await settle();
        expect(creationsMarked()).toHaveLength(2);
        expect(tree.root.findAllByProps({ testID: 'result-output-pager' })).toHaveLength(0);

        renderer.act(() => { labelled(tree.root, 'Share').props.onPress(); });
        expect(routerState.push).toHaveBeenCalledWith({ pathname: '/post/new', params: { generationId: 'gen-pred-share', shareAfterPublish: '1' } });
        expect(tree.root.findAllByProps({ testID: 'generation-workspace' })).toHaveLength(0);
        invalidate.mockRestore();
      });

      // 02-1: a guest's Creations are its library, keyed by its identity, so a
      // guest's run marks that library stale, at its start and at its end.
      it('marks a guest’s creations stale under its identity, at the start and the end', async () => {
        authState.user = null;
        authState.isGuest = true;
        authState.identityUserId = 'guest-1';
        const invalidate = vi.spyOn(testQueryClient, 'invalidateQueries');
        const creationsMarked = () => invalidate.mock.calls.filter(([filters]) => (filters as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === 'profile-generations');
        authState.api.startGeneration.mockResolvedValue(started('pred-guest'));
        let finish: (status: unknown) => void = () => undefined;
        authState.api.getImageGeneration.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await pressGenerate(tree);

        const guestLibrary = [{ queryKey: ['profile-generations', 'guest-1'], refetchType: 'none' }];
        expect(creationsMarked()).toEqual([guestLibrary]);
        await renderer.act(async () => { finish({ status: 'succeeded', output: 'https://cdn.example.com/out.png' }); });
        await settle();
        expect(creationsMarked()).toEqual([guestLibrary, guestLibrary]);
        invalidate.mockRestore();
      });

      // 02-7: a guest's creation exists only on its identity, so from its first success the
      // device keeps a merge ticket that carries it to the account at the next sign-in.
      describe('the merge ticket a guest keeps', () => {
        const runToTheEnd = async (outcome: Record<string, unknown>) => {
          authState.api.startGeneration.mockResolvedValue(started('pred-ticket'));
          let finish: (status: unknown) => void = () => undefined;
          authState.api.getImageGeneration.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
          const tree = await open(<MediaCreationScreen initialTool="image" />);
          await typePrompt(tree, 'A bottle on linen');
          await pressGenerate(tree);
          // Nothing is asked while the run is still rendering.
          expect(authState.ensureGuestMergeTicket).not.toHaveBeenCalled();
          await renderer.act(async () => { finish(outcome); });
          await settle();
          return tree;
        };
        const asGuest = () => {
          authState.user = null;
          authState.isGuest = true;
          authState.identityUserId = 'guest-1';
        };

        it('is asked for once when a guest’s run succeeds', async () => {
          asGuest();
          await runToTheEnd({ status: 'succeeded', output: 'https://cdn.example.com/out.png' });

          expect(authState.ensureGuestMergeTicket).toHaveBeenCalledTimes(1);
        });

        it('is not asked for after a guest’s run fails', async () => {
          asGuest();
          const tree = await runToTheEnd({ status: 'failed', error: 'The image provider timed out.' });

          expect(text(tree)).toContain('The image provider timed out.');
          expect(authState.ensureGuestMergeTicket).not.toHaveBeenCalled();
        });

        it('is not asked for when an account’s run succeeds', async () => {
          await runToTheEnd({ status: 'succeeded', output: 'https://cdn.example.com/out.png' });

          expect(authState.ensureGuestMergeTicket).not.toHaveBeenCalled();
        });
      });
    });

    describe('Enhance', () => {
      it.each([
        ['image', 'Generation prompt'],
        ['video', 'Generation prompt'],
        ['motion', 'Optional motion prompt'],
      ] as const)('states its price on the %s creator, and keeps it in what is announced while it runs', async (tool, promptLabel) => {
        authState.api.enhancePrompt.mockReturnValue(new Promise(() => undefined));
        const tree = await open(<MediaCreationScreen initialTool={tool} />);
        expect(collectText(labelled(tree.root, 'Enhance · 2 credits'))).toContain('Enhance · 2 credits');

        await typePrompt(tree, 'A dancer turns', promptLabel);
        await pressAndLook(labelled(tree.root, 'Enhance · 2 credits'));
        const running = labelled(tree.root, 'Enhancing · 2 credits');
        expect(collectText(running)).toContain('Enhancing');
        expect(running.props.disabled).toBe(true);
      });

      it('polishes a prompt that names a reference, with the run’s settings and only what the run sends, and shows up to three notes', async () => {
        memory.set(ordinaryKey, savedDrafts({ image: { prompt: 'A bottle beside @hero', references: [stagedMedia('hero')] } }));
        authState.api.enhancePrompt.mockResolvedValue({
          enhancedPrompt: 'A bottle beside @hero, soft window light.',
          remainingCredits: 900,
          warnings: [
            { code: 'length', severity: 'warning', message: 'The prompt exceeds the 990-character limit.' },
            { code: 'refused', severity: 'blocking', message: 'Not a note.' },
            { code: 'subject', severity: 'info', message: 'Name the subject first.' },
            { code: 'light', severity: 'info', message: 'Say where the light comes from.' },
            { code: 'fourth', severity: 'info', message: 'A fourth note.' },
          ],
        });
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        // Polish has no level, as on the web: the named sentence is kept as written.
        expect(tree.root.findAllByProps({ accessibilityLabel: 'Full enhancement' })).toHaveLength(0);
        expect(text(tree)).toContain('Your @references stay as written. Polish only adds light visual detail around them.');
        await renderer.act(async () => { await labelled(tree.root, 'Polish · 2 credits').props.onPress(); });

        expect(authState.api.enhancePrompt).toHaveBeenCalledWith({
          medium: 'image',
          selectedModel: 'nano-banana-2',
          prompt: 'A bottle beside @hero',
          context: {
            referenceImageCount: 1,
            elementReferences: [{ handle: '@hero', displayName: 'Hero' }],
            modelId: 'nano-banana-2',
            aspectRatio: '4:5',
            resolution: '1K',
            googleSearch: false,
            elementEnhancementMode: 'append-only',
          },
        });
        expect(collectText(tree.root.findByProps({ testID: 'prompt-quality-notes' }))).toEqual([
          'Prompt quality notes',
          'The prompt exceeds the 990-character limit.',
          'Name the subject first.',
          'Say where the light comes from.',
        ]);
        expect(authState.updateCredits).toHaveBeenCalledWith(900);

        // The notes speak of the prompt the enhancer wrote, so an edit takes them away.
        await typePrompt(tree, 'A bottle on linen');
        expect(tree.root.findAllByProps({ testID: 'prompt-quality-notes' })).toHaveLength(0);
        expect(labelled(tree.root, 'Enhance · 2 credits')).toBeTruthy();
        expect(tree.root.findAllByProps({ accessibilityLabel: 'Full enhancement' })).not.toHaveLength(0);
      });

      it('sends only the references a run would send', async () => {
        catalogState.catalog = parityCatalog([parityImageModel('narrow-image', 'Narrow Image', 1)]);
        memory.set(ordinaryKey, savedDrafts({ image: {
          model: 'narrow-image', catalogRevision: 'parity-rev', prompt: 'A bottle on linen', references: [stagedMedia('alpha'), stagedMedia('bravo')],
        } }));
        authState.api.enhancePrompt.mockResolvedValue({ enhancedPrompt: 'A bottle on linen, morning light.' });
        const tree = await open(<MediaCreationScreen initialTool="image" />);

        await renderer.act(async () => { await labelled(tree.root, 'Enhance · 2 credits').props.onPress(); });
        const context = authState.api.enhancePrompt.mock.calls[0][0].context;
        expect(context).toMatchObject({ referenceImageCount: 1, elementReferences: [{ handle: '@alpha', displayName: 'Alpha' }] });
        expect(context).not.toHaveProperty('elementEnhancementMode');
      });

      // Product decision 19: in a multi-shot run each shot has its own Enhance, as on the web.
      describe('a shot of a multi-shot run', () => {
        const shotPrompt = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({ testID: 'selected-shot-prompt' }).props.value as string;
        const openStory = async () => {
          catalogState.catalog = parityCatalog([parityKlingVideo()]);
          memory.set(ordinaryKey, savedDrafts({ video: {
            model: 'kling-3.0-video',
            catalogRevision: 'parity-rev',
            isMultiShot: true,
            duration: 11,
            multiPrompts: [{ id: 's1', prompt: 'A door opens', duration: 5 }, { id: 's2', prompt: 'She walks in', duration: 6 }],
          } }));
          const tree = await open(<MediaCreationScreen initialTool="video" />);
          renderer.act(() => { labelled(tree.root, 'Edit shot 2').props.onPress(); });
          return tree;
        };

        it('enhances the shot on screen at its stated price, and writes back that shot alone', async () => {
          authState.api.enhancePrompt.mockResolvedValue({ enhancedPrompt: 'She walks in slowly, lit from the hall.', remainingCredits: 900 });
          const tree = await openStory();
          const enhanceShot = labelled(tree.root, 'Enhance shot 2 · 2 credits');
          expect(collectText(enhanceShot)).toContain('Enhance shot 2 · 2 credits');

          await renderer.act(async () => { await enhanceShot.props.onPress(); });
          await settle();

          expect(aiDataConsentState.ensure).toHaveBeenCalledTimes(1);
          expect(authState.api.enhancePrompt).toHaveBeenCalledTimes(1);
          expect(authState.api.enhancePrompt.mock.calls[0][0]).toMatchObject({
            medium: 'video',
            selectedModel: 'kling-3.0-video',
            prompt: 'She walks in',
            context: { isMultiShot: true, shotIndex: 1, shotCount: 2, duration: 6 },
          });
          expect(shotPrompt(tree)).toBe('She walks in slowly, lit from the hall.');
          expect(authState.updateCredits).toHaveBeenCalledWith(900);
          expect(storedDrafts().video.multiPrompts).toEqual([
            { id: 's1', prompt: 'A door opens', duration: 5 },
            { id: 's2', prompt: 'She walks in slowly, lit from the hall.', duration: 6 },
          ]);

          // Undo puts back that shot's own words, and the other shot never changed.
          renderer.act(() => { labelled(tree.root, 'Undo enhancement').props.onPress(); });
          expect(shotPrompt(tree)).toBe('She walks in');
          renderer.act(() => { labelled(tree.root, 'Edit shot 1').props.onPress(); });
          expect(shotPrompt(tree)).toBe('A door opens');
        });

        it('sends nothing without permission, and keeps the shot as written when the enhancer refuses', async () => {
          aiDataConsentState.ensure.mockResolvedValue(false);
          const tree = await openStory();
          await renderer.act(async () => { await labelled(tree.root, 'Enhance shot 2 · 2 credits').props.onPress(); });
          expect(authState.api.enhancePrompt).not.toHaveBeenCalled();

          aiDataConsentState.ensure.mockResolvedValue(true);
          authState.api.enhancePrompt.mockRejectedValue(Object.assign(new Error('Insufficient credits. Enhancing a prompt costs 2 credits.'), {
            status: 402,
            details: { error: 'Insufficient credits. Enhancing a prompt costs 2 credits.', remainingCredits: 1 },
          }));
          await renderer.act(async () => { await labelled(tree.root, 'Enhance shot 2 · 2 credits').props.onPress(); });

          expect(shotPrompt(tree)).toBe('She walks in');
          expect(collectText(tree.root.findByProps({ testID: 'video-shot-editor' })))
            .toContain('Insufficient credits. Enhancing a prompt costs 2 credits.');
          expect(authState.updateCredits).toHaveBeenCalledWith(1);
        });
      });

      it('applies the balance a failed enhancement returns with its refund', async () => {
        authState.api.enhancePrompt.mockRejectedValue(Object.assign(new Error('Prompt enhancement failed. Your credits have been refunded.'), {
          status: 502,
          details: { error: 'Prompt enhancement failed. Your credits have been refunded.', remainingCredits: 950 },
        }));
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        await renderer.act(async () => { await labelled(tree.root, 'Enhance · 2 credits').props.onPress(); });

        expect(authState.updateCredits).toHaveBeenCalledWith(950);
        expect(text(tree)).toContain('Prompt enhancement failed. Your credits have been refunded.');
      });
    });

    describe('the prompt and the parameter sheet', () => {
      // Motion is held to Kie's own 2,500 (product decision 20); image and video keep 10,000.
      it.each([
        ['image', 'Generation prompt', 10000, '10,000'],
        ['video', 'Generation prompt', 10000, '10,000'],
        ['motion', 'Optional motion prompt', 2500, '2,500'],
      ] as const)('count the %s prompt against its limit', async (tool, promptLabel, limit, limitLabel) => {
        const tree = await open(<MediaCreationScreen initialTool={tool} />);
        expect(collectText(tree.root.findByProps({ testID: 'prompt-length' }))).toEqual([`0/${limitLabel}`]);
        expect(tree.root.findByProps({ accessibilityLabel: promptLabel }).props.maxLength).toBe(limit);

        await typePrompt(tree, 'x'.repeat(1234), promptLabel);
        const counter = tree.root.findByProps({ testID: 'prompt-length' });
        expect(collectText(counter)).toEqual([`1,234/${limitLabel}`]);
        expect(counter.props.accessibilityLabel).toBe(`1,234 of ${limitLabel} characters`);
      });

      // The server holds every shot to the video limit, and the web's shot boxes stop there.
      it('holds each shot of a multi-shot run to the video limit', async () => {
        catalogState.catalog = parityCatalog([parityKlingVideo()]);
        memory.set(ordinaryKey, savedDrafts({ video: {
          model: 'kling-3.0-video',
          catalogRevision: 'parity-rev',
          isMultiShot: true,
          multiPrompts: [{ id: 's1', prompt: 'A door opens', duration: 5 }],
        } }));
        const tree = await open(<MediaCreationScreen initialTool="video" />);
        expect(tree.root.findByProps({ testID: 'selected-shot-prompt' }).props.maxLength).toBe(10000);
      });

      it('offers Get credits in the sheet when the balance is short, closing the sheet on the way', async () => {
        authState.credits = 0;
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        await typePrompt(tree, 'A bottle on linen');
        renderer.act(() => { findPressableByLabelPrefix(tree.root, 'Generation parameters.').props.onPress(); });

        const sheetBlocker = tree.root.findByProps({ testID: 'parameter-sheet-blocker' });
        expect(collectText(sheetBlocker)).toEqual(['Insufficient credits. This generation costs 8 credits.', 'Get credits']);
        renderer.act(() => { labelled(sheetBlocker, 'Get credits').props.onPress(); });
        expect(tree.root.findAllByProps({ testID: 'creator-parameter-sheet' })).toHaveLength(0);
        expect(routerState.push).toHaveBeenCalledWith('/(tabs)/pricing');
      });

      it.each([[1, '1 credit'], [26863, '26,863 credits']])('says a balance of %i as “%s”', async (credits, label) => {
        authState.credits = credits;
        const tree = await open(<MediaCreationScreen initialTool="image" />);
        renderer.act(() => { findPressableByLabelPrefix(tree.root, 'Generation parameters.').props.onPress(); });
        expect(tree.root.findByProps({ accessibilityLabel: `Available balance, ${label}` })).toBeTruthy();
      });
    });

    describe('sign-in from the creator', () => {
      beforeEach(() => {
        authState.user = null;
        authState.identityUserId = null;
      });

      it('returns to this creator with its remix and its prompt', async () => {
        const tree = await open(
          <MediaCreationScreen
            initialTool="video"
            initialPrompt="A dancer & a drum"
            guided
            remixSource={{ generationId: 'gen-9', postId: 'post-9', title: 'Night run', creatorLabel: 'Ana', thumbnailUrl: 'https://cdn.example.com/t.jpg?x=1' }}
          />,
        );
        await renderer.act(async () => { await labelled(tree.root, 'Enhance · 2 credits').props.onPress(); });

        expect(routerState.push).toHaveBeenCalledWith({
          pathname: '/auth',
          params: {
            returnTo: '/create/video?remix=gen-9&remixPost=post-9&prompt=A%20dancer%20%26%20a%20drum&guided=1&sourceTitle=Night%20run&sourceCreator=Ana&sourceThumbnail=https%3A%2F%2Fcdn.example.com%2Ft.jpg%3Fx%3D1',
          },
        });
      });

      it('returns to the Create tab on the tool it was opened on', async () => {
        const tree = await open(<MediaCreationScreen initialTool="image" insideTab />);
        renderer.act(() => { labelled(tree.root, 'Video').props.onPress(); });
        await typePrompt(tree, 'A dancer turns');
        await renderer.act(async () => { await labelled(tree.root, 'Enhance · 2 credits').props.onPress(); });

        expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/(tabs)/creator?tool=image' } });
      });
    });
  });

});
