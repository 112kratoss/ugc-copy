// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const authState = vi.hoisted(() => ({
  api: {},
  user: { id: 'user-1' } as { id: string } | null,
  identityUserId: 'user-1',
  credits: 500,
  isLoading: false,
  refreshProfile: vi.fn(),
}));

const queryState = vi.hoisted(() => ({
  run: null as unknown,
  template: null as unknown,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === 'media-template-run' ? queryState.run : queryKey[0] === 'media-template' ? queryState.template : null,
    error: null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  Stack: { Screen: () => null },
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(name, props);
  return {
    ArrowRight: icon('arrow-right'),
    Check: icon('check'),
    CircleDollarSign: icon('circle-dollar-sign'),
    CircleUserRound: icon('circle-user-round'),
    Download: icon('download'),
    Image: icon('image-icon'),
    ImageOff: icon('image-off'),
    Play: icon('play'),
    RefreshCw: icon('refresh-cw'),
    ShieldCheck: icon('shield-check'),
    TriangleAlert: icon('triangle-alert'),
    Upload: icon('upload'),
    Video: icon('video-icon'),
    VideoOff: icon('video-off'),
  };
});

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  FlatList: (props: MockProps) => React.createElement('flat-list', props),
  Linking: { canOpenURL: vi.fn(), openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  RefreshControl: (props: MockProps) => React.createElement('refresh-control', props),
  Share: { share: vi.fn(), sharedAction: 'sharedAction' },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: (props: MockProps) => React.createElement('media-preview', props),
}));

// The demo clip used to be drawn by this player directly, in a frame of its
// own. Named here so that a return to it shows up as a missing preview below.
vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-preview', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  IconButton: (props: MockProps) => React.createElement('icon-button', props),
  Kicker: ({ children, ...props }: MockProps) => React.createElement('kicker', props, children),
  Pill: (props: MockProps) => React.createElement('pill', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionHeader: (props: MockProps) => React.createElement('section-header', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/ai-data-consent', () => ({ withAiDataConsent: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: vi.fn() }));
vi.mock('@/lib/dialog', () => ({ showConfirmDialog: vi.fn(), showErrorDialog: vi.fn(), showMessageDialog: vi.fn() }));
vi.mock('@/lib/media', () => ({ pickMedia: vi.fn(), uploadTemplateRunInput: vi.fn() }));
vi.mock('@/lib/template-run-resume', () => ({
  forgetTemplateRun: vi.fn(async () => false),
  loadResumableTemplateRun: vi.fn(async () => null),
  loadResumableTemplateRuns: vi.fn(async () => ({})),
  rememberTemplateRun: vi.fn(async () => false),
}));

import { MediaTemplateDetailScreen, MediaTemplateRunScreen } from '../components/media-template-screens';
import { normalizeMediaTemplateDetailResponse, normalizeTemplateRunResponse } from '../lib/media-templates';

const TEMPLATE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function template(media: { videoUrl?: string; thumbnailUrl?: string }) {
  return normalizeMediaTemplateDetailResponse({
    template: { id: TEMPLATE_ID, slug: 'car-reveal', name: 'Car reveal', outputKind: 'video', inputSlots: [], ...media },
  });
}

function run(overrides: Record<string, unknown>) {
  return normalizeTemplateRunResponse({
    run: { id: 'run-1', templateId: TEMPLATE_ID, templateTitle: 'Car reveal', inputSlots: [], inputs: [], steps: [], result: null, creditsUsed: 0, ...overrides },
  });
}

function step(mediaKind: 'image' | 'video', urls: Record<string, string>) {
  return { id: `step-${mediaKind}`, kind: 'generation', mediaKind, status: 'succeeded', label: `The ${mediaKind}`, ...urls };
}

function previewsOf(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  const previews = tree.root.findAll((node) => String(node.type) === 'media-preview').map((node) => node.props);
  renderer.act(() => tree.unmount());
  return previews;
}

beforeEach(() => {
  queryState.run = null;
  queryState.template = template({});
});

// Each of these previews passes a height, and each was a 4:5 card of that
// height: narrower than its column and against its left edge, and cropped to
// fill (media-preview.test has the cause). Measured on the Pixel 9a emulator
// and the iPhone 17 Pro simulator, 2026-10-04: the poster 344 wide in a column
// of 379dp / 369pt, a step's picture 312 and its clip 240, the final result
// 352, and an upload 168 in the middle of its box. Letterboxed, each spans its
// column and shows the whole picture or clip. The layout engine does not run
// here, so this holds what each screen asks of the preview.
describe('template previews', () => {
  it('shows a template’s poster in the frame its demo clip gets', () => {
    queryState.template = template({ videoUrl: 'https://cdn.example.com/demo.mp4', thumbnailUrl: 'https://cdn.example.com/poster.webp' });
    const [clip, ...noMoreClips] = previewsOf(<MediaTemplateDetailScreen slug="car-reveal" />);
    queryState.template = template({ thumbnailUrl: 'https://cdn.example.com/poster.webp' });
    const [poster, ...noMorePosters] = previewsOf(<MediaTemplateDetailScreen slug="car-reveal" />);

    expect(clip).toMatchObject({ url: 'https://cdn.example.com/demo.mp4', kind: 'video', height: 430, letterbox: true });
    // The clip's frame shows the poster until it is played, as the web's does (01-9).
    expect(clip.poster).toEqual({ url: 'https://cdn.example.com/poster.webp', cacheKey: 'https://cdn.example.com/poster.webp' });
    expect(poster).toMatchObject({ url: 'https://cdn.example.com/poster.webp', kind: 'image', height: 430, letterbox: true });
    // The same frame down to its corners: neither sets a radius of its own.
    expect(clip.radius).toBe(poster.radius);
    expect(noMoreClips).toHaveLength(0);
    expect(noMorePosters).toHaveLength(0);
  });

  it('renews a demo clip’s link through the template, and asks nothing of a poster', async () => {
    const fresh = template({ videoUrl: 'https://cdn.example.com/demo-renewed.mp4' });
    const getMediaTemplate = vi.fn(async () => fresh);
    authState.api = { getMediaTemplate };
    queryState.template = template({ videoUrl: 'https://cdn.example.com/demo.mp4' });
    const [clip] = previewsOf(<MediaTemplateDetailScreen slug="car-reveal" />);
    queryState.template = template({ thumbnailUrl: 'https://cdn.example.com/poster.webp' });
    const [poster] = previewsOf(<MediaTemplateDetailScreen slug="car-reveal" />);

    await expect((clip.resolveRetryUrl as () => Promise<string>)()).resolves.toBe('https://cdn.example.com/demo-renewed.mp4');
    // Past the client's copy, which may hold the very link that failed; with
    // the session, as the page itself was read.
    expect(getMediaTemplate).toHaveBeenCalledWith(TEMPLATE_ID, { withSession: true, fresh: true });
    expect(poster.resolveRetryUrl).toBeUndefined();
    authState.api = {};
  });

  // The slot is one button that opens the picker. A touch on a native player
  // inside it reaches that button too, so on both platforms a tap on the clip's
  // play control played it and opened the picker (seen on the emulator and the
  // simulator, 2026-10-04). The clip is drawn without controls instead.
  it.each(['image', 'video'] as const)('shows an uploaded %s whole across its slot, with no controls of its own', (kind) => {
    queryState.run = run({
      status: 'collecting_inputs',
      inputSlots: [{ key: 'subject', kind, label: 'Your subject', required: true }],
      inputs: [{ slotKey: 'subject', status: 'uploaded', previewUrl: `https://cdn.example.com/upload-${kind}` }],
    });

    expect(previewsOf(<MediaTemplateRunScreen runId="run-1" />)).toEqual([
      expect.objectContaining({ url: `https://cdn.example.com/upload-${kind}`, kind, height: 210, letterbox: true, nativeControls: false }),
    ]);
  });

  it('leaves the controls on a step’s clip and on the final clip, which sit in no button', () => {
    queryState.run = run({ status: 'awaiting_approval', steps: [step('video', { outputUrl: 'https://cdn.example.com/step.mp4' })] });
    const [stepClip] = previewsOf(<MediaTemplateRunScreen runId="run-1" />);
    queryState.run = run({ status: 'succeeded', result: { generationId: 'generation-1', kind: 'video', url: 'https://cdn.example.com/final.mp4' } });
    const [finalClip] = previewsOf(<MediaTemplateRunScreen runId="run-1" />);

    // Unset, so MediaPreview's own default (controls on) applies.
    expect(stepClip.nativeControls).toBeUndefined();
    expect(finalClip.nativeControls).toBeUndefined();
  });

  it('shows each step’s output whole across the column, a clip from its playable copy', () => {
    queryState.run = run({
      status: 'awaiting_approval',
      steps: [
        step('image', { outputUrl: 'https://cdn.example.com/opening.webp' }),
        step('video', { outputUrl: 'https://cdn.example.com/final-original.mp4', renditionUrl: 'https://cdn.example.com/final-playable.mp4' }),
      ],
    });

    expect(previewsOf(<MediaTemplateRunScreen runId="run-1" />)).toEqual([
      expect.objectContaining({ url: 'https://cdn.example.com/opening.webp', kind: 'image', height: 390, letterbox: true }),
      expect.objectContaining({ url: 'https://cdn.example.com/final-playable.mp4', kind: 'video', height: 300, letterbox: true }),
    ]);
  });

  it.each(['image', 'video'] as const)('shows the final %s whole across the column', (kind) => {
    queryState.run = run({
      status: 'succeeded',
      result: { generationId: 'generation-1', kind, url: `https://cdn.example.com/final-${kind}` },
    });

    expect(previewsOf(<MediaTemplateRunScreen runId="run-1" />)).toEqual([
      expect.objectContaining({ url: `https://cdn.example.com/final-${kind}`, kind, height: 440, letterbox: true }),
    ]);
  });
});
