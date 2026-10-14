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
    getTemplateRun: vi.fn(),
    getMediaTemplate: vi.fn(),
    startTemplateRun: vi.fn(),
    retryTemplateRunStep: vi.fn(),
    approveTemplateRunStep: vi.fn(),
    cancelTemplateRun: vi.fn(),
    createMediaTemplateRun: vi.fn(),
    shareShowcasePost: vi.fn(),
  },
  user: { id: 'user-1' },
  identityUserId: 'user-1',
  credits: 500,
  isLoading: false,
  refreshProfile: vi.fn(async () => undefined),
}));

const dialogState = vi.hoisted(() => ({ showConfirmDialog: vi.fn() }));

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

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Linking: nativeState.Linking,
  Platform: nativeState.Platform,
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Share: nativeState.Share,
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
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
vi.mock('@/lib/dialog', () => dialogState);
vi.mock('@/lib/env', () => ({
  env: { apiBaseUrl: 'https://app.test', siteUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co' },
}));
vi.mock('@/lib/media', () => ({ pickMedia: vi.fn(), uploadTemplateRunInput: vi.fn() }));
vi.mock('@/lib/template-run-resume', () => ({
  clearActiveTemplateRun: vi.fn(async () => undefined),
  loadActiveTemplateRunId: vi.fn(async () => null),
  rememberActiveTemplateRun: vi.fn(async () => undefined),
}));

import { MediaTemplateRunScreen } from '../components/media-template-screens';
import { ApiError } from '../lib/api-client';
import { normalizeMediaTemplateDetailResponse, normalizeTemplateRunResponse } from '../lib/media-templates';
import type { TemplateRunResponse } from '../lib/types';

const TEMPLATE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MINUTE_MS = 60_000;
const RUN_KEY = ['media-template-run', 'run-1'] as const;

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
  await renderer.act(async () => { await client.refetchQueries({ queryKey: RUN_KEY }); });
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
