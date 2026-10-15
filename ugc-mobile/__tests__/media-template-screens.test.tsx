// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

const authState = vi.hoisted(() => ({
  api: {
    listMediaTemplates: vi.fn(),
    getTemplateRun: vi.fn(),
    getMediaTemplate: vi.fn(),
    startTemplateRun: vi.fn(),
    retryTemplateRunStep: vi.fn(),
    approveTemplateRunStep: vi.fn(),
    cancelTemplateRun: vi.fn(),
    createMediaTemplateRun: vi.fn(),
    reportTemplate: vi.fn(),
    shareShowcasePost: vi.fn(),
  },
  // A guest holds an identity and no account: `user` null, `identityUserId` its
  // own (lib/auth.tsx). Templates run on the identity (D4).
  user: { id: 'user-1' } as { id: string } | null,
  identityUserId: 'user-1' as string | null,
  isGuest: false,
  credits: 500,
  isLoading: false,
  refreshProfile: vi.fn(async () => undefined),
  // Never rejects, and mints nothing while the guest already keeps a ticket (lib/auth.tsx).
  ensureGuestMergeTicket: vi.fn(async () => undefined),
}));

const dialogState = vi.hoisted(() => ({ showConfirmDialog: vi.fn(), showErrorDialog: vi.fn(), showMessageDialog: vi.fn() }));

// The sheet the Report row opens; a case presses one of its rows itself.
const actionSheetState = vi.hoisted(() => ({ showActionSheet: vi.fn() }));

// What the stored resume slots answer, and what the screens tell them.
const resumeState = vi.hoisted(() => ({
  forgetTemplateRun: vi.fn(async () => false),
  loadResumableTemplateRun: vi.fn(async () => null as unknown),
  loadResumableTemplateRuns: vi.fn(async () => ({}) as Record<string, unknown>),
  rememberTemplateRun: vi.fn(async () => false),
}));

const nativeState = vi.hoisted(() => ({
  Linking: { canOpenURL: vi.fn(), openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Share: { share: vi.fn(), sharedAction: 'sharedAction' },
}));

// Every address a preview downloaded. The real preview keys its image (the
// cache key) and its player on the address, so a new address is a new download.
const mediaDownloads = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('expo-router', () => ({
  router: routerState,
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

type FlatListProps = MockProps & {
  data: unknown[];
  renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
  keyExtractor: (item: unknown, index: number) => string;
  ListHeaderComponent?: React.ReactNode;
  ListEmptyComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactNode;
};

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  // Every item is drawn, each in a cell under the key the list gives it, so a
  // card that the real list would remount shows up here as a new instance.
  FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }: FlatListProps) => React.createElement(
    'flat-list',
    props,
    ListHeaderComponent ?? null,
    ...(data.length
      ? data.map((item, index) => React.createElement('list-cell', { key: keyExtractor(item, index), cellKey: keyExtractor(item, index) }, renderItem({ item, index })))
      : [ListEmptyComponent ?? null]),
    ListFooterComponent ?? null,
  ),
  Linking: nativeState.Linking,
  Platform: nativeState.Platform,
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  RefreshControl: (props: MockProps) => React.createElement('refresh-control', props),
  Share: nativeState.Share,
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/feed-pagination-footer', () => ({
  FeedLoadMoreErrorFooter: (props: MockProps) => React.createElement('load-more-error', props),
}));

vi.mock('@/components/media-preview', () => {
  function MediaFile({ url }: { url: string }) {
    React.useState(() => mediaDownloads.urls.push(url));
    return null;
  }
  return {
    MediaPreview: (props: MockProps) => React.createElement(
      'media-preview',
      props,
      React.createElement(MediaFile, { key: String(props.url), url: String(props.url) }),
    ),
  };
});

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

vi.mock('@/lib/ai-data-consent', () => ({ withAiDataConsent: async (action: () => void) => action() }));
vi.mock('@/lib/api-client', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public details?: unknown, public requestId?: string, public code?: string) {
      super(message);
    }
  },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/action-sheet', () => actionSheetState);
vi.mock('@/lib/dialog', () => dialogState);
vi.mock('@/lib/env', () => ({
  env: { apiBaseUrl: 'https://app.test', siteUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co' },
}));
vi.mock('@/lib/media', () => ({ pickMedia: vi.fn(), uploadTemplateRunInput: vi.fn() }));
vi.mock('@/lib/template-run-resume', () => resumeState);

import { MediaTemplateCatalogScreen, MediaTemplateDetailScreen, MediaTemplateRunScreen } from '../components/media-template-screens';
import { ApiError } from '../lib/api-client';
import {
  normalizeMediaTemplateDetailResponse,
  normalizeMediaTemplateListResponse,
  normalizeTemplateRunResponse,
} from '../lib/media-templates';
import type { TemplateRunResponse } from '../lib/types';

const TEMPLATE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MINUTE_MS = 60_000;
/** The run as the identity on the phone read it: a sign-out leaves another identity, a guest. */
const runKey = () => ['media-template-run', authState.identityUserId, 'run-1'] as const;

/** A Storage address signed the way Supabase signs one: `exp` in seconds, inside the token. */
function signedUrl(path: string, expiresInMs: number, nonce: string) {
  const claims = Buffer.from(JSON.stringify({ url: path, exp: Math.floor((Date.now() + expiresInMs) / 1000), nonce })).toString('base64url');
  return `https://project.supabase.co/storage/v1/object/sign/${path}?token=head.${claims}.signature`;
}

function runResponse(run: Record<string, unknown>) {
  return normalizeTemplateRunResponse({
    run: {
      id: 'run-1',
      templateId: TEMPLATE_ID,
      templateTitle: 'Car reveal',
      status: 'processing',
      inputSlots: [],
      inputs: {},
      steps: [],
      result: null,
      creditsUsed: 0,
      isTest: false,
      ...run,
    },
  });
}

const openingStep = (nonce: string, expiresInMs = 60 * MINUTE_MS) => ({
  id: 'opening',
  kind: 'generation',
  mediaKind: 'image',
  status: 'succeeded',
  label: 'Opening image',
  outputUrl: signedUrl('generated_images/user-1/opening.png', expiresInMs, nonce),
});
const reviewStep = (nonce: string, status = 'awaiting_approval') => ({
  id: 'review',
  kind: 'approval',
  mediaKind: 'image',
  status,
  label: 'Review opening',
  outputUrl: signedUrl('generated_images/user-1/opening.png', 60 * MINUTE_MS, nonce),
  canRetry: true,
  estimatedRetryCredits: 4,
});
const videoStep = (status: string) => ({ id: 'video', kind: 'generation', mediaKind: 'video', status, label: 'Final video', outputUrl: null });

/** Each read of the run answers with the next of these; the last answers every read after it. */
function answerReads(...answers: Array<TemplateRunResponse | Error>) {
  const queue = [...answers];
  authState.api.getTemplateRun.mockImplementation(async () => {
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

let client: QueryClient;
const mounted: renderer.ReactTestRenderer[] = [];

function screen(mode: 'visible' | 'hidden' = 'visible') {
  return (
    <QueryClientProvider client={client}>
      <React.Activity mode={mode}>
        <MediaTemplateRunScreen runId="run-1" />
      </React.Activity>
    </QueryClientProvider>
  );
}

/** Lets the mocked reads answer and the observers render what they said. */
async function flush() {
  for (let pass = 0; pass < 5; pass += 1) {
    await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(screen()); });
  mounted.push(tree);
  await flush();
  return tree;
}

/** What the run's poll does: the query's own read, as its interval would start it. */
async function poll() {
  await renderer.act(async () => { await client.refetchQueries({ queryKey: runKey() }); });
  await flush();
}

async function press(node: renderer.ReactTestInstance) {
  await renderer.act(async () => { (node.props.onPress as () => void)(); });
  await flush();
}

function hosts(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.findAll((node) => node.type === type);
}

function labels(tree: renderer.ReactTestRenderer) {
  return [...hosts(tree, 'primary-button'), ...hosts(tree, 'secondary-button')].map((node) => node.props.label as string);
}

function button(tree: renderer.ReactTestRenderer, label: string) {
  const found = [...hosts(tree, 'primary-button'), ...hosts(tree, 'secondary-button')].filter((node) => node.props.label === label);
  expect(found, label).toHaveLength(1);
  return found[0];
}

function texts(tree: renderer.ReactTestRenderer) {
  return hosts(tree, 'text').map((node) => React.Children.toArray(node.props.children as React.ReactNode)
    .filter((child) => typeof child === 'string' || typeof child === 'number')
    .join(''));
}

function statusBlocks(tree: renderer.ReactTestRenderer) {
  return hosts(tree, 'status-block').map((node) => node.props as { title: string; body?: string });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(authState.api)) fn.mockReset();
  authState.api.getMediaTemplate.mockResolvedValue(normalizeMediaTemplateDetailResponse({
    template: { id: TEMPLATE_ID, slug: 'car-reveal', name: 'Car reveal', outputKind: 'video', inputSlots: [] },
  }));
  authState.api.shareShowcasePost.mockResolvedValue({ success: true });
  authState.refreshProfile.mockClear();
  routerState.push.mockClear();
  routerState.replace.mockClear();
  dialogState.showConfirmDialog.mockReset().mockResolvedValue(true);
  dialogState.showErrorDialog.mockReset();
  dialogState.showMessageDialog.mockReset();
  actionSheetState.showActionSheet.mockReset();
  authState.user = { id: 'user-1' };
  authState.identityUserId = 'user-1';
  authState.isGuest = false;
  authState.ensureGuestMergeTicket.mockClear();
  resumeState.forgetTemplateRun.mockReset().mockResolvedValue(false);
  resumeState.loadResumableTemplateRun.mockReset().mockResolvedValue(null);
  resumeState.loadResumableTemplateRuns.mockReset().mockResolvedValue({});
  resumeState.rememberTemplateRun.mockReset().mockResolvedValue(false);
  nativeState.Linking.canOpenURL.mockReset().mockResolvedValue(true);
  nativeState.Linking.openURL.mockReset().mockResolvedValue(true);
  nativeState.Share.share.mockReset().mockResolvedValue({ action: 'sharedAction' });
  mediaDownloads.urls.length = 0;
});

// A run in progress polls every 2.5 s; nothing of one case may poll into the next.
afterEach(async () => {
  for (const tree of mounted.splice(0)) await renderer.act(async () => { tree.unmount(); });
  client.clear();
});

describe('a run read again (04-1)', () => {
  const polled = (nonce: string) => runResponse({ status: 'processing', steps: [openingStep(nonce), videoStep('processing')] });

  it('keeps a finished step on the address it shows while every poll signs it again', async () => {
    const reads = [polled('first'), polled('second'), polled('third')];
    answerReads(...reads);
    const tree = await mount();
    const shown = reads[0].run.steps[0].outputUrl;
    const [preview] = hosts(tree, 'media-preview');
    expect(preview.props.url).toBe(shown);

    await poll();
    await poll();

    // Both polls ran, and each brought the same file under a new address.
    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(3);
    expect(reads[1].run.steps[0].outputUrl).not.toBe(shown);
    expect(hosts(tree, 'media-preview')).toHaveLength(1);
    expect(hosts(tree, 'media-preview')[0]).toBe(preview);
    expect(preview.props.url).toBe(shown);
    expect(mediaDownloads.urls).toEqual([shown]);
  });

  it('keeps it when every effect runs again (hidden, then shown), which reads the run again', async () => {
    const reads = [polled('first'), polled('second')];
    answerReads(...reads);
    const tree = await mount();
    const [preview] = hosts(tree, 'media-preview');

    await renderer.act(async () => { tree.update(screen('hidden')); });
    await renderer.act(async () => { tree.update(screen('visible')); });
    await flush();

    // Shown again, the query read the run again.
    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(hosts(tree, 'media-preview')[0]).toBe(preview);
    expect(preview.props.url).toBe(reads[0].run.steps[0].outputUrl);
    expect(mediaDownloads.urls).toEqual([reads[0].run.steps[0].outputUrl]);
  });

  it('keeps it when an action answers with the run signed again', async () => {
    const waiting = runResponse({ status: 'awaiting_approval', steps: [reviewStep('first'), videoStep('queued')] });
    const approved = runResponse({ status: 'processing', steps: [reviewStep('second', 'approved'), videoStep('processing')] });
    answerReads(waiting);
    authState.api.approveTemplateRunStep.mockResolvedValue(approved);
    const tree = await mount();
    const [preview] = hosts(tree, 'media-preview');

    await press(button(tree, 'Approve & continue'));

    expect(authState.api.approveTemplateRunStep).toHaveBeenCalledWith('run-1', 'review');
    expect(hosts(tree, 'pill').map((node) => node.props.label)).toContain('Approved');
    expect(hosts(tree, 'media-preview')[0]).toBe(preview);
    expect(preview.props.url).toBe(waiting.run.steps[0].outputUrl);
    expect(mediaDownloads.urls).toEqual([waiting.run.steps[0].outputUrl]);
  });
});

describe('cancelling (04-2)', () => {
  const waiting = () => runResponse({ status: 'awaiting_approval', steps: [reviewStep('first'), videoStep('queued')] });

  it('says what is kept, and reads the balance once the run is cancelled', async () => {
    answerReads(waiting());
    authState.api.cancelTemplateRun.mockResolvedValue(runResponse({ status: 'cancelled', steps: [reviewStep('first', 'cancelled'), videoStep('cancelled')] }));
    const tree = await mount();

    await press(button(tree, 'Cancel creation'));

    expect(dialogState.showConfirmDialog).toHaveBeenCalledWith({
      title: 'Cancel this creation?',
      message: 'Finished steps stay in your library. A step that is already generating keeps its credits.',
      cancelLabel: 'Keep creating',
      confirmLabel: 'Cancel creation',
      destructive: true,
    });
    expect(authState.api.cancelTemplateRun).toHaveBeenCalledWith('run-1');
    expect(statusBlocks(tree).map((block) => block.title)).toContain('Creation cancelled');
    expect(authState.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it('cancels nothing when the person keeps creating', async () => {
    answerReads(waiting());
    dialogState.showConfirmDialog.mockResolvedValue(false);
    const tree = await mount();

    await press(button(tree, 'Cancel creation'));

    expect(authState.api.cancelTemplateRun).not.toHaveBeenCalled();
  });
});

describe('a result already posted (04-7)', () => {
  const finished = (linkedPost: unknown) => runResponse({
    status: 'succeeded',
    steps: [{ ...videoStep('succeeded'), outputUrl: signedUrl('generated_videos/user-1/final.mp4', 60 * MINUTE_MS, 'a') }],
    result: { generationId: 'generation-1', kind: 'video', url: signedUrl('generated_videos/user-1/final.mp4', 60 * MINUTE_MS, 'a'), linkedPost },
  });

  it.each(['public', 'unlisted'] as const)('offers its %s post and that post’s link to share, never Publish', async (visibility) => {
    answerReads(finished({ id: 'post-1', visibility }));
    const tree = await mount();

    expect(hosts(tree, 'primary-button').map((node) => node.props.label)).toEqual(['View post']);
    expect(labels(tree)).toContain('Share');
    expect(labels(tree)).not.toContain('Publish to Explore');
    expect(labels(tree)).not.toContain('Publish & share');

    await press(button(tree, 'View post'));
    expect(routerState.push).toHaveBeenCalledWith('/post/post-1');

    await press(button(tree, 'Share'));
    const link = 'https://magicbooklet.com/showcase/post-1?s=my-creations';
    expect(nativeState.Share.share).toHaveBeenCalledWith({ title: 'Car reveal', message: `Car reveal\n${link}`, url: link });
    expect(authState.api.shareShowcasePost).toHaveBeenCalledWith('post-1', { sourceSurface: 'my-creations' });
  });

  it('opens a private post, with no link to share and never Publish', async () => {
    answerReads(finished({ id: 'post-1', visibility: 'private' }));
    const tree = await mount();

    expect(hosts(tree, 'primary-button').map((node) => node.props.label)).toEqual(['Open post']);
    for (const label of ['View post', 'Share', 'Publish to Explore', 'Publish & share']) expect(labels(tree)).not.toContain(label);

    await press(button(tree, 'Open post'));
    expect(routerState.push).toHaveBeenCalledWith('/post/post-1');
  });

  it('offers Publish for a result with no post', async () => {
    answerReads(finished(null));
    const tree = await mount();

    expect(hosts(tree, 'primary-button').map((node) => node.props.label)).toEqual(['Publish to Explore']);
    expect(labels(tree)).toContain('Publish & share');
    for (const label of ['View post', 'Open post', 'Share']) expect(labels(tree)).not.toContain(label);
  });
});

describe('an action the server refuses (04-4)', () => {
  const waiting = () => runResponse({ status: 'awaiting_approval', steps: [reviewStep('first'), videoStep('queued')] });
  const movedOn = () => runResponse({ status: 'processing', steps: [reviewStep('second', 'approved'), videoStep('processing')] });

  it.each([
    ['APPROVAL_NOT_READY', 409, 'This checkpoint is not waiting for approval.', 'This step was already handled. The run has been refreshed.'],
    ['APPROVAL_ALREADY_HANDLED', 409, 'This checkpoint was already handled.', 'This step was already handled. The run has been refreshed.'],
    ['STALE_STEP_ATTEMPT', 409, 'This step has already been replaced by a newer attempt.', 'This step was already handled. The run has been refreshed.'],
    ['STEP_NOT_FOUND', 404, 'Template run step not found.', 'That step is no longer part of this run.'],
  ])('reads the run again after %s, and says where it stands', async (code, status, serverMessage, shown) => {
    answerReads(waiting(), movedOn());
    authState.api.approveTemplateRunStep.mockRejectedValue(new ApiError(serverMessage, status, undefined, undefined, code));
    const tree = await mount();

    await press(button(tree, 'Approve & continue'));

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(statusBlocks(tree).find((block) => block.title === 'Action needed')?.body).toBe(shown);
    // The refused button went with the state that offered it.
    expect(labels(tree)).not.toContain('Approve & continue');
  });

  it('says a run has ended when a retry finds it ended', async () => {
    const failed = runResponse({ status: 'needs_attention', steps: [openingStep('first'), { ...videoStep('failed'), canRetry: true, estimatedRetryCredits: 30 }] });
    const ended = runResponse({ status: 'cancelled', steps: [openingStep('first'), { ...videoStep('failed'), canRetry: true, estimatedRetryCredits: 30 }] });
    answerReads(failed, ended);
    authState.api.retryTemplateRunStep.mockRejectedValue(new ApiError('This run has ended. Start a new run to try the template again.', 409, undefined, undefined, 'RUN_TERMINAL'));
    const tree = await mount();

    await press(button(tree, 'Retry · 30 credits'));

    expect(authState.api.retryTemplateRunStep).toHaveBeenCalledWith('run-1', 'video');
    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(statusBlocks(tree).find((block) => block.title === 'Action needed')?.body).toBe('This run has ended. Start a new run to try the template again.');
    expect(labels(tree)).not.toContain('Retry · 30 credits');
  });

  it('keeps the server’s words for any other refusal, and still reads the run again', async () => {
    answerReads(waiting());
    authState.api.approveTemplateRunStep.mockRejectedValue(new ApiError('Not enough credits to continue.', 402, undefined, undefined, 'INSUFFICIENT_CREDITS'));
    const tree = await mount();

    await press(button(tree, 'Approve & continue'));

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(statusBlocks(tree).find((block) => block.title === 'Action needed')?.body).toBe('Not enough credits to continue.');
  });

  it('offers Refresh on a run that waits on the person, and not on one that reads itself', async () => {
    answerReads(waiting());
    const tree = await mount();
    const [refresh, ...noMore] = hosts(tree, 'icon-button');
    expect(refresh.props.label).toBe('Refresh');
    expect(noMore).toHaveLength(0);

    await press(refresh);
    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);

    answerReads(movedOn());
    await poll();
    expect(hosts(tree, 'icon-button')).toHaveLength(0);
  });
});

describe('a read that fails (04-6)', () => {
  const waiting = () => runResponse({ status: 'awaiting_approval', steps: [reviewStep('first'), videoStep('queued')] });
  const offline = () => new ApiError('Network request failed. Please check your connection and try again.', 0);

  it('keeps the run on screen when a refresh fails, and says it could not refresh', async () => {
    answerReads(waiting(), offline(), waiting());
    const tree = await mount();

    await press(hosts(tree, 'icon-button')[0]);

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(statusBlocks(tree).map((block) => block.title)).not.toContain('Could not restore this creation');
    expect(labels(tree)).toContain('Approve & continue');
    expect(texts(tree)).toContain('Couldn’t refresh. Showing the last update.');

    await press(button(tree, 'Try again'));

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(3);
    expect(texts(tree)).not.toContain('Couldn’t refresh. Showing the last update.');
  });

  it('offers Try again when the first read fails', async () => {
    answerReads(offline(), waiting());
    const tree = await mount();

    expect(statusBlocks(tree).map((block) => block.title)).toEqual(['Could not restore this creation']);
    await press(button(tree, 'Try again'));
    expect(labels(tree)).toContain('Approve & continue');
  });

  it('offers nothing to try again for a run that is not there', async () => {
    answerReads(new ApiError('Template run not found.', 404, undefined, undefined, 'RUN_NOT_FOUND'));
    const tree = await mount();

    expect(statusBlocks(tree)).toEqual([expect.objectContaining({ title: 'Could not restore this creation', body: 'Template run not found.' })]);
    expect(labels(tree)).not.toContain('Try again');
  });
});

describe('Open full-quality (04-8)', () => {
  const finishedWith = (url: string) => runResponse({
    status: 'succeeded',
    result: { generationId: 'generation-1', kind: 'video', url, linkedPost: null },
  });

  it('reads the run again for a fresh link when the one it holds is about to stop working', async () => {
    const expiring = finishedWith(signedUrl('generated_videos/user-1/final.mp4', 4 * MINUTE_MS, 'first'));
    const renewed = finishedWith(signedUrl('generated_videos/user-1/final.mp4', 60 * MINUTE_MS, 'second'));
    answerReads(expiring, renewed);
    const tree = await mount();

    await press(button(tree, 'Open full-quality video'));

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(nativeState.Linking.openURL).toHaveBeenCalledWith(renewed.run.result?.url);
  });

  it('opens a link with time left as it is', async () => {
    const fresh = finishedWith(signedUrl('generated_videos/user-1/final.mp4', 50 * MINUTE_MS, 'first'));
    answerReads(fresh);
    const tree = await mount();

    await press(button(tree, 'Open full-quality video'));

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(1);
    expect(nativeState.Linking.openURL).toHaveBeenCalledWith(fresh.run.result?.url);
  });

  it('opens nothing, and says so, when no fresh link can be read', async () => {
    answerReads(finishedWith(signedUrl('generated_videos/user-1/final.mp4', 4 * MINUTE_MS, 'first')), new ApiError('Network request failed.', 0));
    const tree = await mount();

    await press(button(tree, 'Open full-quality video'));

    expect(nativeState.Linking.openURL).not.toHaveBeenCalled();
    expect(statusBlocks(tree).find((block) => block.title === 'Could not continue')?.body)
      .toBe('The full-quality file link is unavailable. Refresh this creation and try again.');
  });
});

describe('a creator test run (04-9)', () => {
  const NOTE = 'Creator test — finish it on the web canvas';

  it('says it is finished on the web canvas, and starts no consumer run from its result', async () => {
    answerReads(runResponse({
      status: 'succeeded',
      isTest: true,
      result: { generationId: 'generation-1', kind: 'video', url: signedUrl('generated_videos/user-1/final.mp4', 60 * MINUTE_MS, 'a'), linkedPost: null },
    }));
    const tree = await mount();

    expect(statusBlocks(tree).map((block) => block.title)).toContain(NOTE);
    expect(labels(tree)).not.toContain('Create another version');
    expect(labels(tree)).not.toContain('Publish to Explore');
    expect(labels(tree)).toContain('Open full-quality video');
  });

  it.each([
    ['failed', 'Start a new run', true],
    ['failed', 'Start a new run', false],
    ['cancelled', 'Return to template', true],
    ['cancelled', 'Return to template', false],
  ] as const)('after a %s run, offers "%s" only when it is not a test (test: %s)', async (status, restartLabel, isTest) => {
    answerReads(runResponse({ status, isTest, steps: [openingStep('first'), videoStep('cancelled')] }));
    const tree = await mount();

    expect(labels(tree).includes(restartLabel)).toBe(!isTest);
    expect(statusBlocks(tree).map((block) => block.title).includes(NOTE)).toBe(isTest);
  });
});

describe('a retry that never started (04-3)', () => {
  it('needs attention, says why, and offers its costed Retry, which sets the run going', async () => {
    const stranded = { ...videoStep('queued'), id: 'video-attempt-2', canRetry: true, estimatedRetryCredits: 30 };
    answerReads(runResponse({ status: 'needs_attention', steps: [openingStep('first'), stranded] }));
    authState.api.retryTemplateRunStep.mockResolvedValue(runResponse({ status: 'queued', steps: [openingStep('first'), { ...stranded, canRetry: false }] }));
    const tree = await mount();

    expect(hosts(tree, 'pill').map((node) => node.props.label)).toEqual(['Needs attention', 'Complete']);
    expect(texts(tree)).toEqual(expect.arrayContaining(['This step did not start', 'Retry it to continue. Earlier completed steps are safe.']));

    await press(button(tree, 'Retry · 30 credits'));

    expect(dialogState.showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Retry final video?', confirmLabel: 'Retry' }));
    expect(authState.api.retryTemplateRunStep).toHaveBeenCalledWith('run-1', 'video-attempt-2');
    expect(texts(tree)).not.toContain('This step did not start');
  });
});

describe('starting (below the cut)', () => {
  it('holds the uploads while Start is on its way', async () => {
    answerReads(runResponse({
      status: 'collecting_inputs',
      inputSlots: [{ key: 'subject', kind: 'image', label: 'Your subject', required: true }],
      inputs: { subject: { previewUrl: 'https://cdn.example.com/subject.png' } },
    }));
    authState.api.startTemplateRun.mockReturnValue(new Promise(() => undefined));
    const tree = await mount();
    const slot = () => hosts(tree, 'pressable').find((node) => node.props.accessibilityLabel === 'Replace Your subject');
    expect(slot()?.props.disabled).toBe(false);

    await press(button(tree, 'Start workflow'));

    expect(authState.api.startTemplateRun).toHaveBeenCalledWith('run-1');
    expect(slot()?.props.disabled).toBe(true);
  });
});

describe('a guest’s run (D4)', () => {
  const collecting = () => runResponse({
    status: 'collecting_inputs',
    inputSlots: [{ key: 'subject', kind: 'image', label: 'Your subject', required: true }],
    inputs: { subject: { previewUrl: 'https://cdn.example.com/subject.png' } },
  });

  beforeEach(() => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    authState.isGuest = true;
  });

  it('opens the guest’s own run, read with its own session, and remembers it under the guest', async () => {
    answerReads(collecting());
    const tree = await mount();

    expect(authState.api.getTemplateRun).toHaveBeenCalledWith('run-1');
    expect(statusBlocks(tree).map((block) => block.title)).not.toContain('Sign in to continue');
    expect(labels(tree)).toContain('Start workflow');
    expect(resumeState.rememberTemplateRun).toHaveBeenCalledWith('guest-1', expect.objectContaining({ id: 'run-1', status: 'collecting_inputs' }));
  });

  it.each([
    ['a guest', true, 1],
    ['an account', false, 0],
  ] as const)('keeps a merge ticket for what the run makes once %s starts it (guest: %s)', async (_who, isGuest, tickets) => {
    if (!isGuest) {
      authState.user = { id: 'user-1' };
      authState.identityUserId = 'user-1';
    }
    authState.isGuest = isGuest;
    answerReads(collecting());
    authState.api.startTemplateRun.mockResolvedValue(runResponse({ status: 'queued' }));
    const tree = await mount();

    await press(button(tree, 'Start workflow'));

    expect(authState.api.startTemplateRun).toHaveBeenCalledWith('run-1');
    expect(authState.ensureGuestMergeTicket).toHaveBeenCalledTimes(tickets);
  });

  it('asks a reader with no identity at all to sign in, and back to this run, and reads nothing', async () => {
    authState.identityUserId = null;
    authState.isGuest = false;
    answerReads(collecting());
    const tree = await mount();

    expect(authState.api.getTemplateRun).not.toHaveBeenCalled();
    expect(statusBlocks(tree).map((block) => block.title)).toEqual(['Sign in to continue']);
    await press(button(tree, 'Sign in'));
    expect(routerState.replace).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/template-runs/run-1' } });
  });

  it('never shows the last identity’s run to the next one on the phone', async () => {
    // An account's run on screen; signing out leaves a guest, which may not read it.
    authState.user = { id: 'user-1' };
    authState.identityUserId = 'user-1';
    authState.isGuest = false;
    answerReads(
      runResponse({ status: 'awaiting_approval', steps: [reviewStep('first'), videoStep('queued')] }),
      new ApiError('Template run not found.', 404, undefined, undefined, 'RUN_NOT_FOUND'),
    );
    const tree = await mount();
    expect(hosts(tree, 'media-preview')).toHaveLength(1);

    authState.user = null;
    authState.identityUserId = 'guest-1';
    authState.isGuest = true;
    await renderer.act(async () => { tree.update(screen()); });
    await flush();

    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(hosts(tree, 'media-preview')).toHaveLength(0);
    expect(labels(tree)).not.toContain('Approve & continue');
    expect(statusBlocks(tree)).toEqual([expect.objectContaining({ title: 'Could not restore this creation', body: 'Template run not found.' })]);
  });
});

describe('the catalog (01-5)', () => {
  /** A poster as the list signs it: the stored file under its version, a new token on every read. */
  const poster = (id: string, nonce: string) => signedUrl(`template_assets/${id}/version-1/poster.webp`, 24 * 60 * MINUTE_MS, nonce);
  const storedPoster = (id: string) => `https://project.supabase.co/storage/v1/object/sign/template_assets/${id}/version-1/poster.webp`;
  const template = (id: string, nonce: string) => ({ id, slug: `slug-${id}`, name: `Template ${id}`, outputKind: 'video', inputSlots: [], thumbnailUrl: poster(id, nonce) });
  const page = (nonce: string, ids: string[], nextCursor: string | null = null) => normalizeMediaTemplateListResponse({
    templates: ids.map((id) => template(id, nonce)),
    nextCursor,
  });

  async function mountCatalog() {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(
        <QueryClientProvider client={client}>
          <MediaTemplateCatalogScreen />
        </QueryClientProvider>,
      );
    });
    mounted.push(tree);
    await flush();
    return tree;
  }

  const list = (tree: renderer.ReactTestRenderer) => hosts(tree, 'flat-list')[0];
  const cardKeys = (tree: renderer.ReactTestRenderer) => hosts(tree, 'list-cell').map((cell) => cell.props.cellKey as string);
  const posters = (tree: renderer.ReactTestRenderer) => hosts(tree, 'image');

  async function reachEnd(tree: renderer.ReactTestRenderer) {
    await renderer.act(async () => { (list(tree).props.onEndReached as () => void)(); });
    await flush();
  }

  it('keeps every card and its poster when a read signs the posters again', async () => {
    const first = page('first', ['a', 'b']);
    const second = page('second', ['a', 'b']);
    authState.api.listMediaTemplates.mockResolvedValueOnce(first).mockResolvedValue(second);
    const tree = await mountCatalog();
    const before = posters(tree);
    expect(cardKeys(tree)).toEqual(['a', 'b']);
    expect(before.map((image) => image.props.source)).toEqual([
      { uri: first.templates[0].thumbnailUrl, cacheKey: storedPoster('a') },
      { uri: first.templates[1].thumbnailUrl, cacheKey: storedPoster('b') },
    ]);

    // What the foreground refetch and a remount both do.
    await renderer.act(async () => { await client.refetchQueries({ queryKey: ['media-templates'] }); });
    await flush();

    expect(authState.api.listMediaTemplates).toHaveBeenCalledTimes(2);
    expect(second.templates[0].thumbnailUrl).not.toBe(first.templates[0].thumbnailUrl);
    const after = posters(tree);
    expect(cardKeys(tree)).toEqual(['a', 'b']);
    // The same images, given the new links under the keys they already had.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after.map((image) => image.props.source)).toEqual([
      { uri: second.templates[0].thumbnailUrl, cacheKey: storedPoster('a') },
      { uri: second.templates[1].thumbnailUrl, cacheKey: storedPoster('b') },
    ]);
  });

  it('loads the next page as the list nears its end, and asks no more after the last', async () => {
    authState.api.listMediaTemplates.mockResolvedValueOnce(page('first', ['a'], 'cursor-2')).mockResolvedValueOnce(page('first', ['b']));
    const tree = await mountCatalog();
    expect(authState.api.listMediaTemplates).toHaveBeenCalledWith(undefined, { fresh: false });

    await reachEnd(tree);

    expect(authState.api.listMediaTemplates).toHaveBeenLastCalledWith({ cursor: 'cursor-2' });
    expect(cardKeys(tree)).toEqual(['a', 'b']);

    await reachEnd(tree);
    expect(authState.api.listMediaTemplates).toHaveBeenCalledTimes(2);
  });

  it('waits for Retry after a page fails, rather than failing again at the end of the list', async () => {
    authState.api.listMediaTemplates
      .mockResolvedValueOnce(page('first', ['a'], 'cursor-2'))
      .mockRejectedValueOnce(new ApiError('Network request failed.', 0))
      .mockResolvedValueOnce(page('first', ['b']));
    const tree = await mountCatalog();

    await reachEnd(tree);
    expect(hosts(tree, 'load-more-error')).toHaveLength(1);
    await reachEnd(tree);
    expect(authState.api.listMediaTemplates).toHaveBeenCalledTimes(2);

    await renderer.act(async () => { (hosts(tree, 'load-more-error')[0].props.onRetry as () => void)(); });
    await flush();

    expect(authState.api.listMediaTemplates).toHaveBeenCalledTimes(3);
    expect(authState.api.listMediaTemplates).toHaveBeenLastCalledWith({ cursor: 'cursor-2' });
    expect(cardKeys(tree)).toEqual(['a', 'b']);
    expect(hosts(tree, 'load-more-error')).toHaveLength(0);
  });

  it('pulls the first page past the client’s copy, and lets the later pages go', async () => {
    authState.api.listMediaTemplates
      .mockResolvedValueOnce(page('first', ['a'], 'cursor-2'))
      .mockResolvedValueOnce(page('first', ['b']))
      .mockResolvedValueOnce(page('second', ['c', 'a'], 'cursor-3'));
    const tree = await mountCatalog();
    await reachEnd(tree);
    expect(cardKeys(tree)).toEqual(['a', 'b']);

    await renderer.act(async () => { (list(tree).props.refreshControl.props.onRefresh as () => void)(); });
    await flush();

    expect(authState.api.listMediaTemplates).toHaveBeenCalledTimes(3);
    expect(authState.api.listMediaTemplates).toHaveBeenLastCalledWith(undefined, { fresh: true });
    expect(cardKeys(tree)).toEqual(['c', 'a']);
    expect(list(tree).props.refreshControl.props.refreshing).toBe(false);
  });

  it('reads again only the templates whose posters failed, and remounts only those', async () => {
    const shown = page('first', ['a', 'b']);
    authState.api.listMediaTemplates.mockResolvedValue(shown);
    const renewed = normalizeMediaTemplateDetailResponse({ template: template('a', 'renewed') });
    authState.api.getMediaTemplate.mockResolvedValue(renewed);
    const tree = await mountCatalog();
    const [posterA, posterB] = posters(tree);

    await renderer.act(async () => { (posterA.props.onError as () => void)(); });
    await flush();

    expect(texts(tree)).toContain('Some previews could not load. You can still open a template.');
    expect(posters(tree)).toEqual([posterB]);

    await press(button(tree, 'Reload previews'));

    expect(authState.api.getMediaTemplate).toHaveBeenCalledTimes(1);
    expect(authState.api.getMediaTemplate).toHaveBeenCalledWith('a', { fresh: true });
    expect(authState.api.listMediaTemplates).toHaveBeenCalledTimes(1);
    const [renewedA, stillB] = posters(tree);
    expect(renewedA.props.source).toEqual({ uri: renewed.template.thumbnailUrl, cacheKey: storedPoster('a') });
    expect(stillB).toBe(posterB);
    expect(texts(tree)).not.toContain('Some previews could not load. You can still open a template.');
  });

  it('tries a failed poster again by itself when a read brings it a new link', async () => {
    const first = page('first', ['a']);
    const second = page('second', ['a']);
    authState.api.listMediaTemplates.mockResolvedValueOnce(first).mockResolvedValue(second);
    const tree = await mountCatalog();

    await renderer.act(async () => { (posters(tree)[0].props.onError as () => void)(); });
    await flush();
    expect(posters(tree)).toHaveLength(0);

    await renderer.act(async () => { await client.refetchQueries({ queryKey: ['media-templates'] }); });
    await flush();

    expect(posters(tree).map((image) => image.props.source.uri)).toEqual([second.templates[0].thumbnailUrl]);
    expect(texts(tree)).not.toContain('Some previews could not load. You can still open a template.');
  });

  it('offers Resume on the card of a template whose run is still going, and opens that run (01-7)', async () => {
    authState.api.listMediaTemplates.mockResolvedValue(page('first', ['a', 'b']));
    const going = runResponse({ id: 'run-a', templateId: 'a', status: 'awaiting_approval' }).run;
    resumeState.loadResumableTemplateRuns.mockResolvedValue({ a: going });
    const tree = await mountCatalog();

    const [cardA, cardB] = hosts(tree, 'list-cell');
    const resumeA = cardA.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Resume your run of Template a');
    expect(resumeA).toHaveLength(1);
    expect(cardB.findAll((node) => String(node.type) === 'pressable' && String(node.props.accessibilityLabel).startsWith('Resume'))).toHaveLength(0);
    expect(texts(tree)).toEqual(expect.arrayContaining(['Resume', 'Review the next step']));

    await press(resumeA[0]);
    expect(routerState.push).toHaveBeenCalledWith('/template-runs/run-a');
  });

  it('reads each remembered run as its owner, and takes a run that is not there as gone', async () => {
    authState.api.listMediaTemplates.mockResolvedValue(page('first', ['a']));
    await mountCatalog();
    const [{ userId, readRun }] = resumeState.loadResumableTemplateRuns.mock.calls[0] as unknown as [{ userId: string; readRun: (runId: string) => Promise<unknown> }];
    expect(userId).toBe('user-1');

    authState.api.getTemplateRun.mockRejectedValueOnce(new ApiError('Template run not found.', 404, undefined, undefined, 'RUN_NOT_FOUND'));
    await expect(readRun('gone')).resolves.toBeNull();
    // Unread is not gone: the slot is kept for the next look.
    authState.api.getTemplateRun.mockRejectedValueOnce(new ApiError('Network request failed.', 0));
    await expect(readRun('offline')).rejects.toThrow('Network request failed.');
  });

  it('offers a guest the runs it keeps on this phone, read as the guest (D4)', async () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    authState.isGuest = true;
    authState.api.listMediaTemplates.mockResolvedValue(page('first', ['a']));
    const going = runResponse({ id: 'run-a', templateId: 'a', status: 'processing' }).run;
    resumeState.loadResumableTemplateRuns.mockResolvedValue({ a: going });
    const tree = await mountCatalog();

    expect(resumeState.loadResumableTemplateRuns).toHaveBeenCalledWith(expect.objectContaining({ userId: 'guest-1' }));
    await press(hosts(tree, 'pressable').find((node) => node.props.accessibilityLabel === 'Resume your run of Template a')!);
    expect(routerState.push).toHaveBeenCalledWith('/template-runs/run-a');
  });

  it('asks no stored runs of a reader with no identity at all', async () => {
    authState.user = null;
    authState.identityUserId = null;
    authState.api.listMediaTemplates.mockResolvedValue(page('first', ['a']));
    await mountCatalog();
    expect(resumeState.loadResumableTemplateRuns).not.toHaveBeenCalled();
  });
});

describe('a run remembered for its template (01-7)', () => {
  it('remembers the run when its status changes, and not at each poll', async () => {
    answerReads(
      runResponse({ status: 'processing', steps: [openingStep('first'), videoStep('processing')] }),
      runResponse({ status: 'processing', steps: [openingStep('second'), videoStep('processing')] }),
      runResponse({ status: 'awaiting_approval', steps: [reviewStep('third'), videoStep('queued')] }),
    );
    resumeState.rememberTemplateRun.mockResolvedValue(true);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await mount();

    expect(resumeState.rememberTemplateRun).toHaveBeenCalledTimes(1);
    expect(resumeState.rememberTemplateRun).toHaveBeenCalledWith('user-1', { id: 'run-1', templateId: TEMPLATE_ID, status: 'processing', isTest: false });
    // The template's card and page read their Resume again.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['template-run-resume', 'user-1'] });

    await poll();
    expect(authState.api.getTemplateRun).toHaveBeenCalledTimes(2);
    expect(resumeState.rememberTemplateRun).toHaveBeenCalledTimes(1);

    await poll();
    expect(resumeState.rememberTemplateRun).toHaveBeenCalledTimes(2);
    expect(resumeState.rememberTemplateRun).toHaveBeenLastCalledWith('user-1', expect.objectContaining({ status: 'awaiting_approval' }));
  });

  it('forgets a run once it has ended', async () => {
    answerReads(runResponse({ status: 'cancelled', steps: [openingStep('first'), videoStep('cancelled')] }));
    await mount();

    expect(resumeState.forgetTemplateRun).toHaveBeenCalledWith('user-1', 'run-1');
    expect(resumeState.rememberTemplateRun).not.toHaveBeenCalled();
  });

  it('says where to come back to it', async () => {
    answerReads(runResponse({ status: 'processing', steps: [openingStep('first'), videoStep('processing')] }));
    const tree = await mount();

    expect(texts(tree)).toContain('This run keeps working if you leave. Resume it from this template’s page at any time.');
  });
});

describe('a template’s page (01-3, 01-7, 01-9, 01-10)', () => {
  const detail = (overrides: Record<string, unknown> = {}) => normalizeMediaTemplateDetailResponse({
    template: {
      id: TEMPLATE_ID,
      slug: 'car-reveal',
      name: 'Car reveal',
      outputKind: 'video',
      status: 'active',
      inputSlots: [],
      useCount: 1,
      creatorUserId: 'creator-1',
      creator: { id: 'creator-1', username: 'maya', displayName: 'Maya', avatarUrl: 'https://cdn.example.com/maya.webp' },
      ...overrides,
    },
  });
  const ownDetail = (status: 'active' | 'draft' | 'disabled') => detail({
    status,
    creatorUserId: 'user-1',
    creator: { id: 'user-1', username: 'me', displayName: 'Me', avatarUrl: null },
  });

  async function mountDetail() {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(
        <QueryClientProvider client={client}>
          <MediaTemplateDetailScreen slug="car-reveal" />
        </QueryClientProvider>,
      );
    });
    mounted.push(tree);
    await flush();
    return tree;
  }

  type Sheet = { title: string; actions: Array<{ label: string; onPress: () => void }> };
  const sheet = () => actionSheetState.showActionSheet.mock.calls[0][0] as Sheet;

  it('reads the template with the session when signed in, so its owner sees it, and without one otherwise', async () => {
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    await mountDetail();
    expect(authState.api.getMediaTemplate).toHaveBeenCalledWith('car-reveal', { withSession: true });

    authState.user = null;
    authState.api.getMediaTemplate.mockClear();
    await mountDetail();
    expect(authState.api.getMediaTemplate).toHaveBeenCalledWith('car-reveal', { withSession: false });
  });

  it('shows the creator’s picture, opens their page, and says “1 use”', async () => {
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    const tree = await mountDetail();

    expect(hosts(tree, 'creator-avatar').map((node) => node.props)).toEqual([
      expect.objectContaining({ uri: 'https://cdn.example.com/maya.webp', name: 'Maya' }),
    ]);
    expect(texts(tree)).toContain('· 1 use');

    await press(hosts(tree, 'pressable').find((node) => node.props.accessibilityLabel === 'Created by Maya')!);
    expect(routerState.push).toHaveBeenCalledWith('/creators/maya');
  });

  it.each([
    ['draft', 'Draft template'],
    ['disabled', 'Template disabled'],
  ] as const)('shows its creator a %s template with its status and no start', async (status, title) => {
    authState.api.getMediaTemplate.mockResolvedValue(ownDetail(status));
    const tree = await mountDetail();

    expect(statusBlocks(tree).map((block) => block.title)).toContain(title);
    expect(labels(tree)).not.toContain('Use this template');
    // Nor a report of their own template, which the server refuses.
    expect(labels(tree)).not.toContain('Report template');
  });

  it('tells its creator a taken-down template cannot be published again', async () => {
    const held = ownDetail('disabled');
    authState.api.getMediaTemplate.mockResolvedValue({
      ...held,
      template: { ...held.template, moderationDisabledAt: '2026-10-15T12:00:00.000Z' },
    });
    const tree = await mountDetail();

    const block = statusBlocks(tree).find((candidate) => candidate.title === 'Template taken down');
    expect(block?.body).toContain("can't be published again");
    expect(statusBlocks(tree).map((candidate) => candidate.title)).not.toContain('Template disabled');
    expect(labels(tree)).not.toContain('Use this template');
  });

  it('says why when its creator’s start is refused as not live, and reads the template again', async () => {
    authState.api.getMediaTemplate.mockResolvedValueOnce(ownDetail('active')).mockResolvedValueOnce(ownDetail('disabled'));
    authState.api.createMediaTemplateRun.mockRejectedValue(new ApiError('Template not found.', 404, undefined, undefined, 'TEMPLATE_NOT_ACTIVE'));
    const tree = await mountDetail();

    await press(button(tree, 'Use this template'));

    expect(statusBlocks(tree).find((block) => block.title === 'Could not start')?.body)
      .toBe('This template isn’t live, so a run can’t start. Publish it from the workflow canvas on the web first.');
    expect(authState.api.getMediaTemplate).toHaveBeenCalledTimes(2);
    expect(statusBlocks(tree).map((block) => block.title)).toContain('Template disabled');
    expect(labels(tree)).not.toContain('Use this template');
  });

  it('offers nothing to try again for a template that is not there, and Try again for a read that failed', async () => {
    authState.api.getMediaTemplate.mockRejectedValue(new ApiError('Template not found.', 404, undefined, undefined, 'TEMPLATE_NOT_FOUND'));
    const gone = await mountDetail();
    expect(statusBlocks(gone)).toEqual([expect.objectContaining({ title: 'Template unavailable', body: 'Template not found.' })]);
    expect(labels(gone)).not.toContain('Try again');

    client.clear();
    authState.api.getMediaTemplate.mockReset().mockRejectedValue(new ApiError('Network request failed.', 0));
    const offline = await mountDetail();
    expect(labels(offline)).toContain('Try again');
  });

  it('offers Resume for the template’s run that is still going', async () => {
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    const going = runResponse({ id: 'run-7', status: 'processing' }).run;
    resumeState.loadResumableTemplateRun.mockResolvedValue(going);
    const tree = await mountDetail();

    expect(resumeState.loadResumableTemplateRun).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', templateId: TEMPLATE_ID }));
    await press(hosts(tree, 'pressable').find((node) => node.props.accessibilityLabel === 'Resume your run of Car reveal')!);
    expect(routerState.push).toHaveBeenCalledWith('/template-runs/run-7');
    expect(labels(tree)).toContain('Use this template');
  });

  it('remembers a run it starts for its template, then opens it', async () => {
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    authState.api.createMediaTemplateRun.mockResolvedValue(runResponse({ id: 'run-new', status: 'collecting_inputs' }));
    const tree = await mountDetail();

    await press(button(tree, 'Use this template'));

    expect(resumeState.rememberTemplateRun).toHaveBeenCalledWith('user-1', expect.objectContaining({ id: 'run-new', templateId: TEMPLATE_ID, status: 'collecting_inputs' }));
    expect(routerState.push).toHaveBeenCalledWith('/template-runs/run-new');
  });

  it('reports the template for the reason chosen, and says the report was received', async () => {
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    authState.api.reportTemplate.mockResolvedValue({ success: true });
    const tree = await mountDetail();

    await press(button(tree, 'Report template'));

    expect(sheet().title).toBe('Why are you reporting this?');
    expect(sheet().actions.map((action) => action.label)).toEqual(['Spam', 'Stolen content', 'Unsafe content', 'Something else']);
    await renderer.act(async () => { sheet().actions[2].onPress(); });
    await flush();

    expect(authState.api.reportTemplate).toHaveBeenCalledWith(TEMPLATE_ID, { reason: 'unsafe_content', details: 'Reported from the mobile template page.' });
    expect(dialogState.showMessageDialog).toHaveBeenCalledWith({
      title: 'Report received',
      message: 'Thank you. Our moderation team will review this template.',
    });
  });

  it('says a second report is already with the team, not that it failed', async () => {
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    authState.api.reportTemplate.mockRejectedValue(new ApiError('You already reported this template. Our moderation team will review it.', 409, undefined, undefined, 'ALREADY_REPORTED'));
    const tree = await mountDetail();

    await press(button(tree, 'Report template'));
    await renderer.act(async () => { sheet().actions[0].onPress(); });
    await flush();

    expect(dialogState.showMessageDialog).toHaveBeenCalledWith({
      title: 'Already reported',
      message: 'You already reported this template. Our moderation team will review it.',
    });
    expect(dialogState.showErrorDialog).not.toHaveBeenCalled();
  });

  it('sends a guest to sign in, and back to the template, before a report (D3: reports stay with accounts)', async () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    authState.isGuest = true;
    authState.api.getMediaTemplate.mockResolvedValue(detail());
    const tree = await mountDetail();

    await press(button(tree, 'Report template'));

    expect(actionSheetState.showActionSheet).not.toHaveBeenCalled();
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/templates/car-reveal' } });
  });

  describe('for a guest (D4)', () => {
    const SIGN_IN_HERE = { pathname: '/auth', params: { returnTo: '/templates/car-reveal' } };

    beforeEach(() => {
      authState.user = null;
      authState.identityUserId = 'guest-1';
      authState.isGuest = true;
    });

    it('starts a run on the guest’s own identity, remembers it there, and opens its page', async () => {
      authState.api.getMediaTemplate.mockResolvedValue(detail());
      authState.api.createMediaTemplateRun.mockResolvedValue(runResponse({ id: 'run-new', status: 'collecting_inputs' }));
      const tree = await mountDetail();
      // The public read: a guest's token on `/api/templates/[id]` is answered 403.
      expect(authState.api.getMediaTemplate).toHaveBeenCalledWith('car-reveal', { withSession: false });

      await press(button(tree, 'Use this template'));

      expect(authState.api.createMediaTemplateRun).toHaveBeenCalledWith(TEMPLATE_ID, expect.any(String));
      expect(resumeState.rememberTemplateRun).toHaveBeenCalledWith('guest-1', expect.objectContaining({ id: 'run-new', templateId: TEMPLATE_ID, status: 'collecting_inputs' }));
      expect(routerState.push).toHaveBeenCalledTimes(1);
      expect(routerState.push).toHaveBeenCalledWith('/template-runs/run-new');
    });

    it('offers the guest its own run of the template to resume', async () => {
      authState.api.getMediaTemplate.mockResolvedValue(detail());
      resumeState.loadResumableTemplateRun.mockResolvedValue(runResponse({ id: 'run-7', status: 'processing' }).run);
      const tree = await mountDetail();

      expect(resumeState.loadResumableTemplateRun).toHaveBeenCalledWith(expect.objectContaining({ userId: 'guest-1', templateId: TEMPLATE_ID }));
      await press(hosts(tree, 'pressable').find((node) => node.props.accessibilityLabel === 'Resume your run of Car reveal')!);
      expect(routerState.push).toHaveBeenCalledWith('/template-runs/run-7');
    });

    it('still asks the guest to sign in, and back to the template, for a run the server keeps for accounts', async () => {
      authState.api.getMediaTemplate.mockResolvedValue(detail());
      authState.api.createMediaTemplateRun.mockRejectedValue(new ApiError('Create an account to use this feature.', 403, undefined, undefined, 'REGISTRATION_REQUIRED'));
      const tree = await mountDetail();

      await press(button(tree, 'Use this template'));

      expect(authState.api.createMediaTemplateRun).toHaveBeenCalledTimes(1);
      expect(routerState.push).toHaveBeenCalledWith(SIGN_IN_HERE);
      // A way on, not a failure to start.
      expect(statusBlocks(tree).map((block) => block.title)).not.toContain('Could not start');
      expect(resumeState.rememberTemplateRun).not.toHaveBeenCalled();
    });

    it('sends a reader with no identity at all to sign in before a start, and asks the server nothing', async () => {
      authState.identityUserId = null;
      authState.isGuest = false;
      authState.api.getMediaTemplate.mockResolvedValue(detail());
      const tree = await mountDetail();

      await press(button(tree, 'Use this template'));

      expect(authState.api.createMediaTemplateRun).not.toHaveBeenCalled();
      expect(routerState.push).toHaveBeenCalledWith(SIGN_IN_HERE);
    });
  });
});
