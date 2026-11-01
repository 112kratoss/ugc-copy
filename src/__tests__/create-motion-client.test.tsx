import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import CreateMotionClient from '@/app/create-motion/CreateMotionClient';
import type { CreatorOpening } from '@/lib/creator-opening';
import { clearGenerationsOnPage, GenerationStatusRequestError, subscribeToGenerationOnPage } from '@/lib/generation-status-client';
import { loadPendingWebStart, savePendingWebStart, type PendingWebStart } from '@/lib/generation-model-client';
import { buildUnifiedGenerationQuoteInput, parseUnifiedGenerationRequest } from '@/lib/unified-generation-start-service';
import { buildGenerationModelCatalog, type CatalogInputMode } from '@/lib/generation-model-catalog';
import { referenceMediaLengthViolation } from '@/lib/provider-input-limits';
import { MOTION_PROMPT_MAX_LENGTH } from '../../ugc-mobile/lib/model-catalog/protocol';
import { PRODUCTION_KLING_3_MOTION_MODES, ROLLBACK_KLING_3_MOTION_MODES } from './fixtures/production-motion-descriptors';
import { quoteStandIn } from './fixtures/web-quote-stand-in';
import { priceListStandIn, pricedBy } from './fixtures/quote-prices-stand-in';
import { chooseSetting, costShown } from './fixtures/creator-column-bar';
import { outsideAct } from './fixtures/outside-act';

const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
  /** The network has not yet confirmed the revision: the catalog is the browser's stored copy. */
  checkingRevision: false,
}));
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
// One stable catalog: a fresh object per render re-runs every effect keyed on it.
const motionCatalog = vi.hoisted(() => ({
  revision: 'test-catalog-rev',
  schemaVersion: 1,
  defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-3.0' },
  models: [
    {
      id: 'kling-3.0',
      kind: 'motion',
      displayName: 'Kling 3.0 Motion',
      description: 'Test motion model',
      controls: [],
      capabilities: {},
      inputs: {},
    },
    {
      id: 'kling-2.6',
      kind: 'motion',
      displayName: 'Kling 2.6',
      description: 'Test stable motion model',
      controls: [],
      capabilities: {},
      inputs: {},
    },
  ],
}));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const authState = vi.hoisted(() => ({
  credits: 10_000 as number | null,
  isLoading: false,
  session: {
    access_token: 'test-token',
    user: { id: 'user-1' },
  } as { access_token: string; user: { id: string } } | null,
  // Whether a sign-out made in this browser ended the session (AuthProvider's `signedOut`).
  signedOut: false,
  updateCredits: vi.fn(),
}));
// The browser's auth client: signed in or out, and as whom. It has another account's session before
// the page does when that account signs in from another tab.
const sessionState = vi.hoisted(() => ({ signedIn: true, session: { access_token: 'test-token', user: { id: 'user-1' } } }));
const persistedFiles = vi.hoisted(() => new Map<string, File>());
const persistedMediaMocks = vi.hoisted(() => ({
  getPersistedFile: vi.fn(async (key: string) => persistedFiles.get(key) ?? null),
  setPersistedFile: vi.fn(async (key: string, file: File) => {
    persistedFiles.set(key, file);
  }),
  removePersistedMedia: vi.fn(async (key: string) => {
    persistedFiles.delete(key);
  }),
  purgeLegacyPersistedMedia: vi.fn(async () => undefined),
}));
const savedDrafts = vi.hoisted(() => new Map<string, unknown>());
// Whose draft the page keeps, where a test moves it as `useCreatorDraftOwner` would: a sign-up's
// hand-over finishing, another account. Null leaves the hook's own answer.
const draftOwnerOverride = vi.hoisted(() => ({ current: null as { owner: string | null; carriedDraft: boolean; keepsVisitorForm: boolean } | null }));
const draftMocks = vi.hoisted(() => ({
  loadCreatorDraft: vi.fn(async (tool: string, userId: string) => savedDrafts.get(`${tool}:${userId}`) ?? null),
  saveCreatorDraft: vi.fn(async (tool: string, userId: string, draft: unknown) => {
    savedDrafts.set(`${tool}:${userId}`, draft);
  }),
}));
const uploadMocks = vi.hoisted(() => ({
  uploadMediaToTemporaryStorage: vi.fn(async (file: File) => ({
    signedUrl: `https://storage.example/uploads/${file.name}?token=first`,
    storagePath: `uploads/user-1/${file.name}`,
  })),
  refreshTemporaryMediaUrl: vi.fn(async (storagePath: string) => `https://storage.example/${storagePath}?token=renewed`),
}));
const probeState = vi.hoisted(() => ({ seconds: 7.3 as number | null }));
const statusMocks = vi.hoisted(() => ({
  fetchGenerationStatusWithRetry: vi.fn(),
  waitForNextGenerationStatusPoll: vi.fn(async () => undefined),
}));
const deployState = vi.hoisted(() => ({ newBuildAvailable: false, enabled: [] as boolean[] }));
// What the result's player was last given.
const resultVideoState = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

// The creators' price lists answer from the stand-in: nothing is priced unless a test says so.
// The module's pure helpers stay its own.
vi.mock('@/lib/use-quote-prices', async (importOriginal) => {
  const { quotePricesHookStandIn } = await import('./fixtures/quote-prices-stand-in');
  return { ...await importOriginal<typeof import('@/lib/use-quote-prices')>(), useQuotePrices: quotePricesHookStandIn };
});

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => authState,
}));

// What the Enhance button was last given, which a button answering through what it had when pressed
// calls, and the newest callbacks of the mounted button, which one keeping them in a ref calls.
type EnhanceAnswerProps = { onEnhanced: (text: string) => void; onCreditsUpdate: (credits: number) => void };
const enhanceButton = vi.hoisted(() => ({
  props: null as EnhanceAnswerProps | null,
  mounted: null as { current: EnhanceAnswerProps } | null,
}));

vi.mock('@/components/EnhancePromptButton', async () => {
  const { useLayoutEffect, useRef } = await import('react');
  return {
    default: function EnhanceButtonStandIn(props: EnhanceAnswerProps) {
      const newest = useRef(props);
      useLayoutEffect(() => {
        newest.current = props;
        enhanceButton.mounted = newest;
      });
      enhanceButton.props = props;
      return null;
    },
  };
});

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/components/GenerationResultVideo', () => ({
  default: (props: Record<string, unknown>) => {
    resultVideoState.props = props;
    return null;
  },
}));

vi.mock('@/lib/persisted-media', () => ({
  PERSISTED_MEDIA_KEYS: {
    createMotionCharacterImage: 'create-motion:character-image',
    createMotionReferenceVideo: 'create-motion:reference-video',
  },
  scopedPersistedMediaKey: (key: string, userId: string) => `${key}:${userId}`,
  ...persistedMediaMocks,
}));

vi.mock('@/lib/persisted-creator-draft', () => draftMocks);

vi.mock('@/lib/use-creator-draft-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/use-creator-draft-owner')>();
  return {
    ...actual,
    useCreatorDraftOwner: (...args: Parameters<typeof actual.useCreatorDraftOwner>) => {
      const answer = actual.useCreatorDraftOwner(...args);
      return draftOwnerOverride.current ?? answer;
    },
  };
});

vi.mock('@/lib/temporary-media-upload', async () => {
  const actual = await vi.importActual<typeof import('@/lib/temporary-media-upload')>('@/lib/temporary-media-upload');
  return { ...actual, ...uploadMocks };
});

vi.mock('@/lib/video-metadata-probe', () => ({
  readVideoDurationSeconds: vi.fn(async () => probeState.seconds),
}));

vi.mock('@/lib/generation-status-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-status-client')>('@/lib/generation-status-client');
  return { ...actual, ...statusMocks };
});

vi.mock('@/lib/use-deployment-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-deployment-refresh')>()),
  useDeploymentRefresh: (enabled: boolean) => {
    deployState.enabled.push(enabled);
    return { newBuildAvailable: deployState.newBuildAvailable };
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: sessionState.signedIn ? sessionState.session : null,
        },
      })),
    },
    // Production refuses the browser a run's prompt, cost and model (42501): the page asks the API.
    from: vi.fn((table: string) => {
      throw new Error(`The page read ${table} from the browser.`);
    }),
  },
}));

vi.mock('@/lib/generation-model-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-model-client')>('@/lib/generation-model-client');
  const { quoteHookStandIn } = await import('./fixtures/web-quote-stand-in');
  return {
    ...actual,
    useWebGenerationModelCatalog: () => ({
      summaries: modelCatalogState.summaries, missingIds: modelCatalogState.missingIds, detailsReady: true, isLoadingModels: false,
      catalog: motionCatalog,
      error: modelCatalogState.error,
      isLoading: false,
      isCheckingRevision: modelCatalogState.checkingRevision,
      revision: 'test-catalog-rev',
      refetch: generationCatalogRefetchMock,
    }),
    // Unless a test says otherwise, 20 credits, ready, and the price of the very request the page asked.
    useWebGenerationModelQuote: quoteHookStandIn(actual.WebCatalogRequestError),
  };
});

const motionModelSummaries = [
  { id: 'kling-3.0', kind: 'motion', displayName: 'Kling 3.0 Motion', description: 'Test motion model' },
  { id: 'kling-2.6', kind: 'motion', displayName: 'Kling 2.6', description: 'Test stable motion model' },
];

type StartAnswer = Response | Error | (() => Response | Promise<Response>);
let startAnswers: StartAnswer[] = [];
let generationLookupBody: unknown = { generations: [] };
let remixSourceBody: unknown = null;
/** The motion run already at work as the page opens, as the API describes it. */
let activeRun: Record<string, unknown> | null = null;
/** Answers the look in place of `activeRun`, when the test resolves it. */
let activeRunAnswer: Promise<Response> | null = null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function startedBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    predictionId: 'task-1',
    generationId: 'generation-1',
    status: 'processing',
    remainingCredits: 9_980,
    cost: 20,
    catalogRevision: 'test-catalog-rev',
    modelId: 'kling-3.0',
    ...overrides,
  };
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === '/api/generations' && init?.method === 'POST') {
    const answer = startAnswers.shift() ?? jsonResponse(startedBody());
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  }
  if (url.startsWith('/api/remix-source?') && remixSourceBody) {
    return jsonResponse(remixSourceBody);
  }
  if (url.startsWith('/api/generations?')) {
    return jsonResponse(generationLookupBody);
  }
  if (url === '/api/generations/active?tool=motion') {
    return activeRunAnswer ?? jsonResponse({ run: activeRun });
  }
  throw new Error(`Unexpected fetch ${url}`);
});

function activeRunReads() {
  return fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/generations/active'));
}

function startPosts() {
  return fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/generations' && init?.method === 'POST');
}

function startKeys() {
  return startPosts().map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
}

function startBodies() {
  return startPosts().map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

/** The page's last quote request, as JSON. */
function shownQuote() {
  return JSON.stringify(quoteStandIn.requests.filter(Boolean).at(-1));
}

/**
 * The start's own quote of the run the page posted, as JSON: byte for byte what the price
 * shown must have been asked with, as the page's price rule compares them.
 */
function startQuote(index: number) {
  return JSON.stringify(buildUnifiedGenerationQuoteInput(parseUnifiedGenerationRequest(startBodies()[index])));
}

function chooseModel(container: HTMLElement, displayName: string) {
  const picker = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  expect(picker).not.toBeNull();
  fireEvent.click(picker!);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(displayName) }));
}

function pickFile(container: HTMLElement, inputId: string, file: File) {
  const input = container.querySelector<HTMLInputElement>(`#${inputId}`);
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { files: [file] } });
}

const characterImage = () => new File(['image-bytes'], 'hero.png', { type: 'image/png' });
const motionClip = () => new File(['video-bytes'], 'dance.mp4', { type: 'video/mp4' });

async function attachBothInputs(container: HTMLElement) {
  pickFile(container, 'motion-character-image-input', characterImage());
  pickFile(container, 'motion-reference-video-input', motionClip());
  expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
}

function generateButton() {
  return screen.getByRole('button', { name: /^(Generate · .+|Check again|Generating\.\.\.)$/ });
}

async function pressGenerate() {
  await waitFor(() => expect(generateButton()).toBeEnabled());
  fireEvent.click(generateButton());
}

function pendingStart(overrides: Partial<PendingWebStart> = {}): PendingWebStart {
  return {
    version: 1,
    tool: 'motion',
    idempotencyKey: 'motion:saved-key',
    body: {
      kind: 'motion',
      modelId: 'kling-3.0',
      settings: { duration: 8, characterOrientation: 'video', resolution: '720p' },
      prompt: 'Saved prompt',
      inputs: [],
      catalogRevision: 'test-catalog-rev',
    },
    catalogRevision: 'test-catalog-rev',
    createdAt: new Date().toISOString(),
    userId: 'user-1',
    ...overrides,
  };
}

let objectUrlCount = 0;
const originalLocation = window.location;

beforeEach(() => {
  modelCatalogState.missingIds = [];
  modelCatalogState.error = null;
  modelCatalogState.checkingRevision = false;
  modelCatalogState.summaries = [];
  quoteStandIn.reset(20);
  priceListStandIn.reset();
  for (const model of motionCatalog.models) delete (model as { inputModes?: unknown }).inputModes;
  generationCatalogRefetchMock.mockClear();
  routerMock.push.mockClear();
  authState.credits = 10_000;
  authState.session = { access_token: 'test-token', user: { id: 'user-1' } };
  authState.signedOut = false;
  authState.updateCredits.mockClear();
  sessionState.signedIn = true;
  sessionState.session = { access_token: 'test-token', user: { id: 'user-1' } };
  persistedFiles.clear();
  Object.values(persistedMediaMocks).forEach((mock) => mock.mockClear());
  savedDrafts.clear();
  Object.values(draftMocks).forEach((mock) => mock.mockClear());
  draftOwnerOverride.current = null;
  Object.values(uploadMocks).forEach((mock) => mock.mockClear());
  probeState.seconds = 7.3;
  statusMocks.fetchGenerationStatusWithRetry.mockReset();
  statusMocks.fetchGenerationStatusWithRetry.mockResolvedValue({
    status: 'succeeded',
    output: 'https://cdn.example/motion-result.mp4',
  });
  statusMocks.waitForNextGenerationStatusPoll.mockClear();
  deployState.newBuildAvailable = false;
  deployState.enabled = [];
  resultVideoState.props = null;
  startAnswers = [];
  generationLookupBody = { generations: [] };
  remixSourceBody = null;
  activeRun = null;
  activeRunAnswer = null;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
  window.scrollTo = vi.fn();
  URL.createObjectURL = vi.fn(() => `blob:motion-${(objectUrlCount += 1)}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('CreateMotionClient model notices', () => {
  it('titles a model notice as model settings, not as a remix', async () => {
    modelCatalogState.missingIds = ['kling-3.0'];

    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByText(/This model is no longer available/)).toBeInTheDocument();
    expect(screen.queryByText('Remixing Community Creation')).not.toBeInTheDocument();
    expect(screen.getByText('Model settings')).toBeInTheDocument();
  });

  it('clears the missing-model notice once another model is chosen', async () => {
    modelCatalogState.missingIds = ['kling-3.0'];
    modelCatalogState.summaries = motionModelSummaries;
    const view = render(<CreateMotionClient prefill={{}} />);
    expect(await screen.findByText(/This model is no longer available/)).toBeInTheDocument();

    chooseModel(view.container, 'Kling 2.6');

    await waitFor(() => {
      expect(screen.queryByText(/This model is no longer available/)).not.toBeInTheDocument();
    });
  });

  it('clears the load-error notice once the model list loads again', async () => {
    modelCatalogState.error = new Error('Could not load models.');
    const view = render(<CreateMotionClient prefill={{}} />);
    expect(await screen.findByText('Could not load models.')).toBeInTheDocument();

    modelCatalogState.error = null;
    view.rerender(<CreateMotionClient prefill={{}} />);

    await waitFor(() => {
      expect(screen.queryByText('Could not load models.')).not.toBeInTheDocument();
    });
  });

  it('lets the creator dismiss a catalog-changed notice', async () => {
    quoteStandIn.errorCode = 'CATALOG_CHANGED';
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(await screen.findByText(/Review the refreshed options/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss model notice' }));

    await waitFor(() => {
      expect(screen.queryByText(/Review the refreshed options/)).not.toBeInTheDocument();
    });
  });

  it('clears a catalog-changed notice when the creator picks another model', async () => {
    quoteStandIn.errorCode = 'CATALOG_CHANGED';
    modelCatalogState.summaries = motionModelSummaries;
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(await screen.findByText(/Review the refreshed options/)).toBeInTheDocument();

    chooseModel(view.container, 'Kling 2.6');

    await waitFor(() => {
      expect(screen.queryByText(/Review the refreshed options/)).not.toBeInTheDocument();
    });
  });

  it('says the draft is saved only where it is', async () => {
    modelCatalogState.missingIds = ['kling-3.0'];

    render(<CreateMotionClient prefill={{ remixId: 'generation-source' }} />);

    expect(await screen.findByText(/Your prompt and references stay on this page/)).toBeInTheDocument();
    expect(screen.queryByText(/Your draft is saved/)).not.toBeInTheDocument();
  });
});

describe('CreateMotionClient quote', () => {
  it('asks for no quote until both inputs and their length exist, and says what is missing', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByText('Add a character image and a motion clip to see the cost.')).toBeInTheDocument();
    expect(screen.getByText('Add both inputs')).toBeInTheDocument();
    expect(screen.queryByText('Retry quote')).not.toBeInTheDocument();
    expect(quoteStandIn.requests.every((request) => request === null)).toBe(true);

    pickFile(view.container, 'motion-character-image-input', characterImage());
    await waitFor(() => expect(persistedMediaMocks.setPersistedFile).toHaveBeenCalledTimes(1));
    expect(quoteStandIn.requests.every((request) => request === null)).toBe(true);

    pickFile(view.container, 'motion-reference-video-input', motionClip());
    expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();

    const lastRequest = quoteStandIn.requests.at(-1);
    expect(lastRequest).toMatchObject({
      kind: 'motion',
      settings: { duration: 8 },
      inputCounts: { images: 1, videos: 1, audios: 0 },
    });
    expect(screen.queryByText('Add a character image and a motion clip to see the cost.')).not.toBeInTheDocument();
    expect(costShown()).toBe('20 credits');
  });
});

// PR 2 of the creator redesign (owner, 2026-10-28): each option of the settings priced once
// the run can be, and the balance read under the bar.
describe('CreateMotionClient prices', () => {
  it('prices each quality once both inputs are in, and reads the balance under the bar', async () => {
    authState.credits = 30;
    priceListStandIn.price = pricedBy((request) => (request.settings?.resolution === '1080p' ? 34 : 20));
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await waitFor(() => expect(costShown()).toBe('20 credits'));
    expect(view.container.querySelector('[data-creator-bar-note]')).toHaveTextContent('Balance 30');
    expect(view.container.querySelector('[data-creator-bar-note]')).toHaveTextContent('Leaves 10');

    fireEvent.click(screen.getByRole('button', { name: /^Generation settings/ }));

    const settings = screen.getByRole('dialog', { name: 'Generation settings' });
    expect(within(settings).getByRole('radio', { name: 'Pro 1080p, 34 credits, 4 more than your balance' })).toHaveTextContent('34 · +4');
    expect(settings).toHaveTextContent('This run 20 credits · leaves 10');
  });
});

/**
 * The price is the server's own quote of the run the page posts, and goes with the run as the
 * most its start may charge (`expectedCostCredits`). The start quotes a run again from the inputs
 * it is sent, each in its slot, and refuses one it prices above the price sent (`cost_changed`).
 * The page built its quote by hand, from kind totals, so the price shown was not always the
 * start's: on production's catalog of 2026-10-19 every Kling 3.0 run showed a price the start
 * then refused.
 */
describe('CreateMotionClient price of the run it sends', () => {
  const COST_CHANGED = 'The price of this run changed. Check the updated cost and generate again.';
  const ROOFTOP_REMIX = {
    generation: { id: 'generation-source', title: 'Rooftop dance', prompt: 'Dance on the roof at dusk', category: 'video', model: 'kling-2.6' },
    result: { mediaType: 'video', url: 'https://cdn.example/source-result.mp4' },
    inputs: {
      motion: {
        characterImage: { kind: 'image', url: 'https://cdn.example/hero.png', label: 'Hero still', storagePath: 'uploads/user-1/hero.png', sourceGenerationId: null },
        referenceVideo: { kind: 'video', url: 'https://cdn.example/dance.mp4', label: 'Original result video', storagePath: null, sourceGenerationId: 'generation-older' },
      },
    },
    workflowSettings: { model: 'kling-2.6', mode: '1080p', characterOrientation: 'image' },
    restoreIssues: [],
  };

  it.each([
    ['a fresh draft', async () => undefined, { modelId: 'kling-3.0', settings: { resolution: '720p', characterOrientation: 'video' } }],
    // Chosen once the saved draft is read: before that, the catalog's default takes the page back.
    ['Kling 2.6 at 1080p, favoring the image', async (container: HTMLElement) => {
      chooseModel(container, 'Kling 2.6');
      chooseSetting('Pro 1080p');
      chooseSetting('Favor image');
    }, { modelId: 'kling-2.6', settings: { resolution: '1080p', characterOrientation: 'image' } }],
  ])('asks for its price with the start’s own quote of the run it posts: %s', async (_case, setUp, run) => {
    modelCatalogState.summaries = motionModelSummaries;
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await setUp(view.container);
    await waitFor(() => expect(costShown()).toBe('20 credits'));
    const shown = shownQuote();

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));

    expect(startBodies()[0]).toMatchObject(run);
    expect(shown).toBe(startQuote(0));
    expect(JSON.parse(shown)).toMatchObject({ schemaVersion: 2, inputMetadata: { slots: { characterImage: { count: 1 }, referenceVideo: { count: 1 } } } });
  });

  it('sends the price it shows with the run, as the most the start may charge, and the run as it was', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(costShown()).toBe('20 credits');

    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startBodies()[0]).toEqual({
      schemaVersion: 3,
      kind: 'motion',
      modelId: 'kling-3.0',
      settings: { duration: 8, characterOrientation: 'video', resolution: '720p' },
      prompt: "No distortion, the character's movements are consistent with the video.",
      inputs: [
        {
          slot: 'characterImage',
          kind: 'image',
          url: 'https://storage.example/uploads/hero.png?token=first',
          label: 'Character image',
          storagePath: 'uploads/user-1/hero.png',
          sourceGenerationId: null,
        },
        {
          slot: 'referenceVideo',
          kind: 'video',
          url: 'https://storage.example/uploads/dance.mp4?token=first',
          label: 'Reference video',
          storagePath: 'uploads/user-1/dance.mp4',
          sourceGenerationId: null,
        },
      ],
      catalogRevision: 'test-catalog-rev',
      expectedCostCredits: 20,
    });
    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
  });

  it.each([
    ['answers another request than the run’s', () => { quoteStandIn.forAnotherRequest = true; }],
    ['is not a whole number of credits', () => { quoteStandIn.answers = [20.5]; }],
  ])('sends the run without a price when the quote %s', async (_case, setUp) => {
    setUp();
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    // The run goes, and the start charges its own price, as it did before a price was sent.
    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startBodies()[0]).not.toHaveProperty('expectedCostCredits');
  });

  it('waits for a price, and sends the run with it once it is ready', async () => {
    quoteStandIn.answers = ['pending'];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(costShown()).toBe('Calculating...');
    expect(generateButton()).toBeDisabled();

    // The answer comes in: the stand-in hook gives it at the page's next render.
    quoteStandIn.answers = [20];
    view.rerender(<CreateMotionClient prefill={{}} />);
    expect(costShown()).toBe('20 credits');
    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startBodies()[0].expectedCostCredits).toBe(20);
  });

  // A look for a run at work that answers late is dropped: the page has gone, or the
  // creator pressed Generate and the page is theirs.
  const motionRunAtWork = () => ({ id: 'gen-motion-1', predictionId: 'pred-motion-1', status: 'processing', createdAt: new Date().toISOString(), duration: 10, prompt: 'Saved prompt', cost: 30, model: 'kling-3.0' });

  it('drops a look that answers after the page has gone', async () => {
    let answerLook: (response: Response) => void = () => undefined;
    activeRunAnswer = new Promise<Response>((resolve) => { answerLook = resolve; });
    const view = render(<CreateMotionClient prefill={{}} />);
    await waitFor(() => expect(activeRunReads()).toHaveLength(1));

    view.unmount();
    await act(async () => {
      answerLook(jsonResponse({ run: motionRunAtWork() }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(statusMocks.fetchGenerationStatusWithRetry).not.toHaveBeenCalled();
  });

  it('keeps the creator\'s own press, refusal and all, when the look answers after it', async () => {
    let answerLook: (response: Response) => void = () => undefined;
    activeRunAnswer = new Promise<Response>((resolve) => { answerLook = resolve; });
    quoteStandIn.answers = [20, 24];
    startAnswers = [jsonResponse({ code: 'cost_changed', error: COST_CHANGED }, 409)];
    const view = render(<CreateMotionClient prefill={{}} />);
    await waitFor(() => expect(activeRunReads()).toHaveLength(1));
    await attachBothInputs(view.container);
    await pressGenerate();
    expect(await screen.findByText(COST_CHANGED)).toBeInTheDocument();

    await act(async () => {
      answerLook(jsonResponse({ run: motionRunAtWork() }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText(COST_CHANGED)).toBeInTheDocument();
    expect(statusMocks.fetchGenerationStatusWithRetry).not.toHaveBeenCalled();
  });

  it('asks for the price again when the server says it changed, and sends the next run at the new price under a new key', async () => {
    quoteStandIn.answers = [20, 24];
    startAnswers = [jsonResponse({ code: 'cost_changed', error: COST_CHANGED }, 409)];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(quoteStandIn.attempts.at(-1)).toBe(0);
    expect(costShown()).toBe('20 credits');

    await pressGenerate();

    expect(await screen.findByText(COST_CHANGED)).toBeInTheDocument();
    expect(quoteStandIn.attempts.at(-1)).toBe(1);
    expect(costShown()).toBe('24 credits');
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();

    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startBodies().map((body) => body.expectedCostCredits)).toEqual([20, 24]);
    expect(startKeys()[1]).not.toBe(startKeys()[0]);
    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
  });

  it('keeps Retry quote under the refusal when the price cannot be read again after it changed', async () => {
    quoteStandIn.answers = [20, 'error', 24];
    startAnswers = [jsonResponse({ code: 'cost_changed', error: COST_CHANGED }, 409)];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    // The refusal stays said, and asking again is the only way to a price: Generate waits for one.
    expect(await screen.findByText(COST_CHANGED)).toBeInTheDocument();
    expect(costShown()).toBe('Unavailable');
    expect(generateButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry quote' }));

    expect(costShown()).toBe('24 credits');
    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startBodies()[1].expectedCostCredits).toBe(24);
  });

  it('says the page is out of date and holds Generate for a reload when asking again leaves a remix at the refused price', async () => {
    // A remix sends from the page it is on, past a deploy too. When that deploy changed how
    // its run is priced, the page's quote of the run and the start's disagree: asked again,
    // the price did not move, and each press was refused the same way until a reload.
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
    remixSourceBody = ROOFTOP_REMIX;
    const costChanged = () => jsonResponse({ code: 'cost_changed', error: COST_CHANGED }, 409);
    startAnswers = [costChanged, costChanged, costChanged];
    document.documentElement.dataset.buildId = 'build-7';
    onTestFinished(() => {
      delete document.documentElement.dataset.buildId;
    });
    render(<CreateMotionClient prefill={{ remixId: 'generation-source' }} />);
    expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
    await waitFor(() => expect(costShown()).toBe('20 credits'));

    await pressGenerate();

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('This page is out of date, so it cannot show what this run costs.');
    expect(notice).toHaveTextContent('The remix starts again from the original.');
    // Asked again once, and the start's refusal stood: the same run at the same price.
    expect(quoteStandIn.attempts.at(-1)).toBe(1);
    expect(costShown()).toBe('20 credits');
    expect(generateButton()).toBeDisabled();
    fireEvent.click(generateButton());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startPosts()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // The build it left, so the page that loads next can tell if the same one came back.
    expect(window.sessionStorage.getItem('magicbooklet:deployment-refresh:reloaded-from-build-id')).toBe('build-7');
  });

  it("shows the remix's original in its notice, opening it in the page's own preview", async () => {
    remixSourceBody = ROOFTOP_REMIX;
    render(<CreateMotionClient prefill={{ remixId: 'generation-source' }} />);

    const original = await screen.findByRole('button', { name: 'View original' });
    expect(original.querySelector('video')).toHaveAttribute('src', 'https://cdn.example/source-result.mp4#t=0.1');
    fireEvent.click(original);
    // In the page, as the image and video creators show theirs, not in a new tab.
    expect(await screen.findByRole('heading', { name: 'Original Creation' })).toBeInTheDocument();
  });

  // A run that goes is forgotten as a refusal: a later quote back at the refused price (a
  // rollback) held Generate and said the page was out of date, though the start would take it.
  it('forgets a refusal once that run goes, after the page was found out of date and the price then moved', async () => {
    startAnswers = [jsonResponse({ code: 'cost_changed', error: COST_CHANGED }, 409)];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await pressGenerate();
    expect(await screen.findByRole('alert')).toHaveTextContent('This page is out of date');

    // The price moves (a deploy that fixed this run's quote, say), and the run goes at it.
    quoteStandIn.answers = [20, 24];
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Spin twice, then bow.' } });
    expect(costShown()).toBe('24 credits');
    expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
    await pressGenerate();
    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
    expect(startBodies().map((body) => body.expectedCostCredits)).toEqual([20, 24]);

    // The old price back (a rollback): the run went, so the page holds nothing.
    quoteStandIn.answers = [20, 20];
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Spin once, then bow.' } });
    expect(costShown()).toBe('20 credits');
    expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  it('checks an unanswered start again with the run and price it sent, though the price has moved since', async () => {
    startAnswers = [new TypeError('Failed to fetch')];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await pressGenerate();
    expect(await screen.findByText('We couldn’t confirm your generation started. Check again — that can’t start a second run.')).toBeInTheDocument();

    // The price moves and the prompt is edited: Check again still sends what it sent,
    // while a new run is offered at the price now.
    quoteStandIn.answers = [24];
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Spin twice, then bow.' } });
    expect(await screen.findByRole('button', { name: 'Start a new run · 24 credits' })).toBeInTheDocument();
    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startKeys()[1]).toBe(startKeys()[0]);
    expect(startBodies()[1]).toEqual(startBodies()[0]);
    expect(startBodies()[1].expectedCostCredits).toBe(20);
  });

  it('posts a remix from the inputs it restored, with its source, under its own price', async () => {
    remixSourceBody = ROOFTOP_REMIX;
    render(<CreateMotionClient prefill={{ remixId: 'generation-source' }} />);
    expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
    await waitFor(() => expect(costShown()).toBe('20 credits'));
    const shown = shownQuote();

    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startBodies()[0]).toEqual({
      schemaVersion: 3,
      kind: 'motion',
      modelId: 'kling-2.6',
      settings: { duration: 8, characterOrientation: 'image', resolution: '1080p' },
      prompt: 'Dance on the roof at dusk',
      inputs: [
        { slot: 'characterImage', kind: 'image', url: 'https://cdn.example/hero.png', label: 'Hero still', storagePath: 'uploads/user-1/hero.png', sourceGenerationId: null },
        { slot: 'referenceVideo', kind: 'video', url: 'https://cdn.example/dance.mp4', label: 'Original result video', storagePath: null, sourceGenerationId: 'generation-older' },
      ],
      sourceGenerationId: 'generation-source',
      catalogRevision: 'test-catalog-rev',
      expectedCostCredits: 20,
    });
    expect(shown).toBe(startQuote(0));
    expect(uploadMocks.uploadMediaToTemporaryStorage).not.toHaveBeenCalled();
  });

  // A remix keeps no draft: its top-up tells Pricing the remix, which offers it back once the credits are in.
  it('sends a remix short of its price to Pricing with the way back to it', async () => {
    authState.credits = 10;
    remixSourceBody = ROOFTOP_REMIX;
    render(<CreateMotionClient prefill={{ remixId: 'generation-source', remixPostId: 'post-1' }} />);
    expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();

    expect(await screen.findByRole('link', { name: /Top Up Credits/ }))
      .toHaveAttribute('href', `/pricing?returnTo=${encodeURIComponent('/create-motion?remix=generation-source&remixPost=post-1')}`);
    expect(screen.queryByRole('button', { name: /^Generate · / })).toBeNull();
  });

  it('replays a start saved on another visit with the price it was sent with', async () => {
    const saved = pendingStart();
    saved.body = { ...saved.body, expectedCostCredits: 9 };
    savePendingWebStart(saved);

    render(<CreateMotionClient prefill={{}} />);

    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startKeys()[0]).toBe('motion:saved-key');
    expect(startBodies()[0]).toEqual({ schemaVersion: 3, ...saved.body });
  });
});

function publishMotionModes(modelId: 'kling-3.0' | 'kling-2.6', inputModes: CatalogInputMode[]) {
  const model = motionCatalog.models.find((candidate) => candidate.id === modelId);
  Object.assign(model!, { inputModes });
}

/**
 * A motion run sends its picture and its clip in the slots its model declares: the start quotes
 * the run with each input in its slot and refuses a slot the model does not have. The page sent
 * `characterImage` and `referenceVideo` to every model, and production's Kling 3.0, then in the
 * compatibility release's plain reference slots, refused every web run ("Kling 3.0 does not support
 * the characterImage input."), as the app's went through. Production publishes the motion-inputs
 * slots for it since release kling-3-motion-inputs-20261101, and the plain ones again on a rollback.
 * `creator-run-inputs.test.ts` holds the server's own verdict on these slots.
 */
describe('CreateMotionClient slots the model declares', () => {
  it.each([
    ['production publishes', PRODUCTION_KLING_3_MOTION_MODES, ['characterImage', 'referenceVideo']],
    ['production serves on a rollback', ROLLBACK_KLING_3_MOTION_MODES, ['imageReferences', 'videoReferences']],
  ] as const)('sends Kling 3.0’s inputs in the slots %s', async (_shape, modes, [imageSlot, videoSlot]) => {
    publishMotionModes('kling-3.0', modes);
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await waitFor(() => expect(costShown()).toBe('20 credits'));
    const shown = shownQuote();

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));

    const inputs = startBodies()[0].inputs as Array<Record<string, unknown>>;
    expect(startBodies()[0].modelId).toBe('kling-3.0');
    expect(inputs.map((input) => [input.slot, input.kind, input.storagePath])).toEqual([
      [imageSlot, 'image', 'uploads/user-1/hero.png'],
      [videoSlot, 'video', 'uploads/user-1/dance.mp4'],
    ]);
    expect(shown).toBe(startQuote(0));
  });

  it('plans the slots again when the creator switches model', async () => {
    // Two models with different slots: Kling 3.0 as a rollback serves it, and Kling 2.6.
    publishMotionModes('kling-3.0', ROLLBACK_KLING_3_MOTION_MODES);
    modelCatalogState.summaries = motionModelSummaries;
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await waitFor(() => expect(JSON.parse(shownQuote()).inputMetadata.slots).toEqual({ imageReferences: { count: 1 }, videoReferences: { count: 1 } }));

    chooseModel(view.container, 'Kling 2.6');
    await waitFor(() => expect(JSON.parse(shownQuote()).modelId).toBe('kling-2.6'));
    const shown = shownQuote();

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));

    expect(startBodies()[0].modelId).toBe('kling-2.6');
    expect((startBodies()[0].inputs as Array<Record<string, unknown>>).map((input) => input.slot)).toEqual(['characterImage', 'referenceVideo']);
    expect(shown).toBe(startQuote(0));
  });
});

/**
 * Kie's motion control refuses a clip under 3 seconds. The start refused such a run before any
 * hold, but only once Generate was pressed. The catalog publishes the shortest clip on the slot a
 * motion run sends its clip in (`minDurationSeconds`), and the page holds the run in the start's
 * own words, on a line of its own above Generate.
 */
describe('CreateMotionClient a clip shorter than its slot takes', () => {
  /** Kling 2.6's motion slots as the code catalog publishes them, with the shortest clip they take. */
  const KLING_26_MODES = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 })
    .models.find((model) => model.id === 'kling-2.6')!.inputModes!;

  async function attachClipOf(container: HTMLElement, seconds: number) {
    probeState.seconds = seconds;
    pickFile(container, 'motion-character-image-input', characterImage());
    pickFile(container, 'motion-reference-video-input', motionClip());
    await waitFor(() => expect(screen.queryByText('Reference length will appear after upload.')).toBeNull());
  }

  // Kling 2.6 and Kling 3.0 as production publishes them: the same motion-inputs slots, each model
  // named as the start names it.
  it.each([
    ['kling-2.6', 'Kling 2.6', KLING_26_MODES],
    ['kling-3.0', 'Kling 3.0', PRODUCTION_KLING_3_MOTION_MODES],
  ] as const)('says so above Generate on %s and sends nothing, in the start’s own words', async (modelId, name, modes) => {
    const shortClip = `${name} reference video must be at least 3 seconds long. The reference video runs 2.1 seconds.`;
    publishMotionModes(modelId, modes);
    const view = render(<CreateMotionClient prefill={{ model: modelId }} />);
    await attachClipOf(view.container, 2.16);

    expect(await screen.findByText(shortClip)).toBeInTheDocument();
    // The clip's length reads as the line gives it, rounded down, with the shortest the model takes.
    expect(screen.getByText('Reference length: 2.1s, under the 3s minimum')).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();
    fireEvent.click(generateButton());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startPosts()).toHaveLength(0);
    expect(uploadMocks.uploadMediaToTemporaryStorage).not.toHaveBeenCalled();

    // What the start answers for the same clip (it names none: "The reference video").
    expect(referenceMediaLengthViolation(modelId, [{ role: 'motion', durationSeconds: 2.16 }])).toBe(shortClip);
  });

  // 2.96 s: the start reads ffmpeg's length to the hundredth, and the browser's reading of a trimmed
  // clip can fall a frame short of it, so a clip just under 3 seconds goes and the start judges it. Its
  // length reads 2.9, as the start's refusal would give it, not 3.0.
  it.each([[3.4, 'Reference length: 3.4s'], [2.96, 'Reference length: 2.9s']] as const)('runs a clip of %s seconds', async (seconds, shown) => {
    publishMotionModes('kling-2.6', KLING_26_MODES);
    const view = render(<CreateMotionClient prefill={{ model: 'kling-2.6' }} />);
    await attachClipOf(view.container, seconds);

    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.queryByText(/must be at least 3 seconds long/)).toBeNull();
    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));
  });

  it('leaves a short clip to the start where the model publishes no minimum', async () => {
    // Kling 3.0 motion as production serves it on a rollback: the compatibility release's plain
    // reference slots, which publish no minimum.
    publishMotionModes('kling-3.0', ROLLBACK_KLING_3_MOTION_MODES);
    const view = render(<CreateMotionClient prefill={{ model: 'kling-3.0' }} />);
    await attachClipOf(view.container, 2.16);

    expect(screen.getByText('Reference length: 2.2s')).toBeInTheDocument();
    expect(screen.queryByText(/must be at least 3 seconds long/)).toBeNull();
    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));
  });
});

describe('CreateMotionClient start', () => {
  it('keeps the key of a start whose answer was lost, and the next press checks it under that key', async () => {
    let pendingWhileSending: PendingWebStart | null = null;
    startAnswers = [
      () => {
        pendingWhileSending = loadPendingWebStart('motion', 'user-1');
        throw new TypeError('Failed to fetch');
      },
    ];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    expect(await screen.findByText('We couldn’t confirm your generation started. Check again — that can’t start a second run.')).toBeInTheDocument();
    expect(pendingWhileSending).not.toBeNull();
    expect(loadPendingWebStart('motion', 'user-1')?.idempotencyKey).toBe(startKeys()[0]);
    expect(generateButton()).toHaveTextContent('Check again');

    await pressGenerate();

    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
    expect(startPosts()).toHaveLength(2);
    expect(startKeys()[1]).toBe(startKeys()[0]);
    expect(startBodies()[1]).toEqual(startBodies()[0]);
    // The second press sent what was saved: nothing was uploaded again.
    expect(uploadMocks.uploadMediaToTemporaryStorage).toHaveBeenCalledTimes(2);
    expect(uploadMocks.refreshTemporaryMediaUrl).not.toHaveBeenCalled();
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();
    expect(statusMocks.fetchGenerationStatusWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      url: '/api/generate?id=task-1',
    }));
  });

  it('drops the key of a definitive refusal, so the next press is a new start', async () => {
    startAnswers = [
      jsonResponse({ code: 'INVALID_GENERATION_REQUEST', error: 'The prompt is too long.', fieldErrors: { prompt: 'The prompt is too long.' } }, 422),
    ];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    expect(await screen.findByText('The prompt is too long.')).toBeInTheDocument();
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Describe the kind of movement/));
    expect(generateButton()).toHaveTextContent(/^Generate · /);

    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startKeys()[1]).not.toBe(startKeys()[0]);
  });

  it('checks an unanswered start again on the next visit before looking for the newest run', async () => {
    savePendingWebStart(pendingStart());

    render(<CreateMotionClient prefill={{}} />);

    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startKeys()[0]).toBe('motion:saved-key');
    // Exactly as saved: a start saved before the price went with runs goes without one.
    expect(startBodies()[0]).toEqual({ schemaVersion: 3, ...pendingStart().body });
    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
    expect(activeRunReads()).toHaveLength(0);
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();
  });

  it('does not replay another account’s unanswered start', async () => {
    savePendingWebStart(pendingStart({ userId: 'someone-else' }));

    render(<CreateMotionClient prefill={{}} />);

    await waitFor(() => expect(activeRunReads()).toEqual([
      ['/api/generations/active?tool=motion', { headers: { Authorization: 'Bearer test-token' }, signal: expect.any(AbortSignal) }],
    ]));
    expect(startPosts()).toHaveLength(0);
  });

  it('uploads each input once and sends its staged path again on the next press', async () => {
    startAnswers = [
      jsonResponse({ code: 'prompt_blocked', error: 'This prompt cannot be used.' }, 422),
    ];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();
    expect(await screen.findByText('This prompt cannot be used.')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Describe the kind of movement/));

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(2));

    expect(uploadMocks.uploadMediaToTemporaryStorage).toHaveBeenCalledTimes(2);
    expect(uploadMocks.refreshTemporaryMediaUrl.mock.calls.map(([path]) => path)).toEqual([
      'uploads/user-1/hero.png',
      'uploads/user-1/dance.mp4',
    ]);
    const secondInputs = startBodies()[1].inputs as Array<Record<string, unknown>>;
    expect(secondInputs.map((input) => input.storagePath)).toEqual(['uploads/user-1/hero.png', 'uploads/user-1/dance.mp4']);
    expect(secondInputs.map((input) => input.url)).toEqual([
      'https://storage.example/uploads/user-1/hero.png?token=renewed',
      'https://storage.example/uploads/user-1/dance.mp4?token=renewed',
    ]);
  });

  it('uploads a staged input again once it is too old to reuse, or its link cannot be renewed', async () => {
    startAnswers = [
      jsonResponse({ code: 'prompt_blocked', error: 'This prompt cannot be used.' }, 422),
      jsonResponse({ code: 'prompt_blocked', error: 'This prompt cannot be used.' }, 422),
    ];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(uploadMocks.uploadMediaToTemporaryStorage).toHaveBeenCalledTimes(2);

    // The image's staged copy can no longer be signed; the clip's still can.
    uploadMocks.refreshTemporaryMediaUrl.mockImplementation(async (storagePath: string) => {
      if (storagePath.endsWith('hero.png')) throw new Error('That upload is no longer available.');
      return `https://storage.example/${storagePath}?token=renewed`;
    });
    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(uploadMocks.uploadMediaToTemporaryStorage.mock.calls.map(([file]) => (file as File).name))
      .toEqual(['hero.png', 'dance.mp4', 'hero.png']);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 41 * 60 * 60 * 1000);
    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(3));
    expect(uploadMocks.uploadMediaToTemporaryStorage.mock.calls.map(([file]) => (file as File).name))
      .toEqual(['hero.png', 'dance.mp4', 'hero.png', 'hero.png', 'dance.mp4']);
  });

  it('refreshes the balance and offers a top-up when the server says credits are short', async () => {
    const creditsUpdated = vi.fn();
    window.addEventListener('credits_updated', creditsUpdated);
    startAnswers = [
      jsonResponse({ code: 'insufficient_credits', error: 'Insufficient credits. This action costs 20 credits.' }, 402),
    ];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    expect(await screen.findByText('Insufficient credits. This action costs 20 credits.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Top Up Credits/ })).toHaveAttribute('href', '/pricing');
    expect(creditsUpdated).toHaveBeenCalled();
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();
    window.removeEventListener('credits_updated', creditsUpdated);
  });

  it('quotes again with the length the server measured when the clip runs longer', async () => {
    startAnswers = [
      jsonResponse({
        code: 'REFERENCE_DURATION_CHANGED',
        error: 'Your reference media runs longer than the length this price was based on. Check the updated cost, then generate again.',
        costCredits: 180,
        quotedCostCredits: 160,
        inputs: [{ index: 1, slot: 'referenceVideo', durationSeconds: 8.2 }],
      }, 409),
    ];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    expect(await screen.findByText(/Check the updated cost, then generate again\./)).toBeInTheDocument();
    expect(screen.getByText('Reference length: 9.0s')).toBeInTheDocument();
    expect(quoteStandIn.requests.at(-1)).toMatchObject({ settings: { duration: 9 } });
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();
    const shown = shownQuote();

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startBodies()[1]).toMatchObject({ settings: { duration: 9 }, expectedCostCredits: 20 });
    // The price of the measured length is the start's own quote of the run it is sent.
    expect(shown).toBe(startQuote(1));
  });

  // The artboard Failed (owner, 2026-10-28): the canvas names the cause and says the credits are back.
  it('says on the canvas why the run failed and that its credits came back, and refreshes the balance', async () => {
    const creditsUpdated = vi.fn();
    window.addEventListener('credits_updated', creditsUpdated);
    statusMocks.fetchGenerationStatusWithRetry.mockResolvedValue({ status: 'failed', error: 'The provider could not render this clip' });
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The provider could not render this clip');
    expect(alert).toHaveTextContent('Your 20 credits are back.');
    const canvas = screen.getByRole('region', { name: 'Result' });
    expect(within(canvas).getByRole('heading', { name: 'It didn’t finish' })).toBeInTheDocument();
    expect(within(canvas).getByRole('button', { name: /^Try again/ })).toBeInTheDocument();
    expect(creditsUpdated).toHaveBeenCalled();
    window.removeEventListener('credits_updated', creditsUpdated);
  });

  it('says what a run picked up on load gave back when it fails', async () => {
    activeRun = { id: 'gen-motion-1', predictionId: 'pred-motion-1', status: 'processing', createdAt: new Date().toISOString(), duration: 10, prompt: 'Saved prompt', cost: 30, model: 'kling-3.0' };
    statusMocks.fetchGenerationStatusWithRetry.mockResolvedValue({ status: 'failed', error: 'The provider could not render this clip' });
    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your 30 credits are back.');
  });

  it('hands a run whose status cannot be read to the background, with a fresh token per read', async () => {
    statusMocks.fetchGenerationStatusWithRetry.mockRejectedValue(new GenerationStatusRequestError('Failed to fetch generation status', 500));
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    expect((await screen.findAllByText('Motion render still processing')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Failed to fetch generation status')).not.toBeInTheDocument();
    const [{ getAccessToken }] = statusMocks.fetchGenerationStatusWithRetry.mock.calls[0] as [{ getAccessToken: () => Promise<string | null> }];
    await expect(getAccessToken()).resolves.toBe('test-token');
  });

  it('sends a lapsed session to sign-in with the page’s own params, after saving the draft', async () => {
    const view = render(<CreateMotionClient prefill={{ prompt: 'Dance like nobody watches' }} returnTo="/create-motion?prompt=Dance+like+nobody+watches" />);
    await attachBothInputs(view.container);
    sessionState.signedIn = false;

    await pressGenerate();

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(
      `/login?returnUrl=${encodeURIComponent('/create-motion?prompt=Dance+like+nobody+watches')}`,
    ));
    expect(startPosts()).toHaveLength(0);
    expect(uploadMocks.uploadMediaToTemporaryStorage).not.toHaveBeenCalled();
    expect(savedDrafts.get('motion:user-1')).toMatchObject({ prompt: 'Dance like nobody watches' });
  });

  // Publishing on the canvas (PR 3b, the artboard Result): the form starts from the creation's
  // own title and its recipe, read once the run is done.
  it('starts the canvas’s publish form from the creation’s own title and recipe', async () => {
    const paywallPrefill = {
      resourceKinds: ['prompt'],
      promptText: 'Saved prompt',
      notesMarkdown: null,
      allowRemix: true,
      referenceCount: 2,
    };
    generationLookupBody = {
      generations: [{ id: 'generation-1', title: 'Rooftop dance', paywallPrefill }],
    };
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    const form = await screen.findByRole('form', { name: 'Post it to the feed' });
    await waitFor(() => expect(within(form).getByRole('textbox', { name: 'Title' })).toHaveValue('Rooftop dance'));
    expect(within(form).getByRole('switch', { name: 'Share the recipe' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish & share/ })).toBeNull();
    const lookup = fetchMock.mock.calls.find(([input]) => String(input).startsWith('/api/generations?'));
    expect(String(lookup?.[0])).toContain('id=generation-1');
  });
});

describe('CreateMotionClient deploys', () => {
  it('watches for a deploy only while idle, and reloads at the press instead of sending from an old build', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(deployState.enabled.at(-1)).toBe(true);

    deployState.newBuildAvailable = true;
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Spin twice' } });
    await pressGenerate();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(startPosts()).toHaveLength(0);
    expect(savedDrafts.get('motion:user-1')).toMatchObject({ prompt: 'Spin twice' });
  });

  it('turns the deploy check off while a run is in flight', async () => {
    let answerStart: (response: Response) => void = () => undefined;
    startAnswers = [() => new Promise<Response>((resolve) => { answerStart = resolve; })];
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(deployState.enabled.at(-1)).toBe(false);

    await act(async () => {
      answerStart(jsonResponse(startedBody()));
    });
    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
    expect(deployState.enabled.at(-1)).toBe(true);
  });

  it('never watches on a remix page, which keeps no draft to come back to', async () => {
    render(<CreateMotionClient prefill={{ remixId: 'generation-source' }} />);

    await waitFor(() => expect(deployState.enabled.length).toBeGreaterThan(0));
    expect(deployState.enabled.every((enabled) => enabled === false)).toBe(true);
  });
});

describe('CreateMotionClient prompt', () => {
  // Product decision 20: Kie's motion cap, read from the constant the app and the motion start share.
  it('takes a prompt up to the motion limit of 2,500 characters and counts against it', () => {
    render(<CreateMotionClient prefill={{}} />);
    const prompt = screen.getByPlaceholderText(/Describe the kind of movement/);
    expect(MOTION_PROMPT_MAX_LENGTH).toBe(2500);
    expect(prompt).toHaveAttribute('maxlength', String(MOTION_PROMPT_MAX_LENGTH));

    fireEvent.change(prompt, { target: { value: 'x'.repeat(1200) } });
    expect(screen.getByText(`1200/${MOTION_PROMPT_MAX_LENGTH}`)).toBeInTheDocument();
  });
});

describe('CreateMotionClient drafts and media', () => {
  it('restores the prompt and settings after a remount, ahead of the catalog default', async () => {
    const first = render(<CreateMotionClient prefill={{}} />);
    await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Moonwalk to the left' } });
    chooseSetting('Pro 1080p');
    await waitFor(() => expect(savedDrafts.get('motion:user-1')).toMatchObject({
      prompt: 'Moonwalk to the left',
      mode: '1080p',
    }), { timeout: 2_000 });
    first.unmount();

    savedDrafts.set('motion:user-1', { ...(savedDrafts.get('motion:user-1') as object), modelId: 'kling-2.6' });
    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByDisplayValue('Moonwalk to the left')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Kling 2.6').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /^Generation settings: 1080P · / })).toBeInTheDocument();
  });

  it('lets a new prompt link win over a draft saved under another link', async () => {
    savedDrafts.set('motion:user-1', {
      prompt: 'An older idea',
      modelId: 'kling-3.0',
      duration: 0,
      characterOrientation: 'video',
      mode: '720p',
      linkPrefill: { prompt: null, model: null },
    });

    render(<CreateMotionClient prefill={{ prompt: 'From the post' }} />);

    await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalled());
    expect(await screen.findByDisplayValue('From the post')).toBeInTheDocument();
  });

  it('brings the edits back when the same link is reloaded', async () => {
    savedDrafts.set('motion:user-1', {
      prompt: 'From the post, edited',
      modelId: 'kling-3.0',
      duration: 0,
      characterOrientation: 'video',
      mode: '720p',
      linkPrefill: { prompt: 'From the post', model: null },
    });

    render(<CreateMotionClient prefill={{ prompt: 'From the post' }} />);

    expect(await screen.findByDisplayValue('From the post, edited')).toBeInTheDocument();
  });

  // The prompt box's rule when a draft is read back after the page opened (owner, 2026-11-01).
  describe('read back after the page opened', () => {
    const OPENING = "No distortion, the character's movements are consistent with the video.";
    const box = () => screen.getByPlaceholderText(/Describe the kind of movement/);
    // keepsVisitorForm: the sign-up sheet's hand-over led here and its move gave up or failed.
    function ownDraftAs(owner: string | null, carriedDraft = false, keepsVisitorForm = false) {
      draftOwnerOverride.current = { owner, carriedDraft, keepsVisitorForm };
    }
    const promptsSavedFor = (owner: string) => draftMocks.saveCreatorDraft.mock.calls
      .filter(([, savedFor]) => savedFor === owner)
      .map(([, , draft]) => (draft as { prompt: string }).prompt);
    const savedDraft = (prompt: string) => ({
      prompt,
      modelId: 'kling-3.0',
      duration: 0,
      characterOrientation: 'video',
      mode: '720p',
      linkPrefill: { prompt: null, model: null },
    });

    it('brings the prompt carried from sign-up back over words typed while it was on its way, once', async () => {
      const carried = 'Moonwalk to the left, arms loose';
      const page = () => <CreateMotionClient prefill={{}} handoverNonce="nonce-1" />;
      // The visitor's draft, moved to the account by the hand-over.
      savedDrafts.set('motion:user-1', savedDraft(carried));
      ownDraftAs(null);
      const view = render(page());
      fireEvent.change(box(), { target: { value: 'Moonwalk to the' } });
      expect(draftMocks.loadCreatorDraft).not.toHaveBeenCalled();

      ownDraftAs('user-1', true);
      view.rerender(page());
      await waitFor(() => expect(box()).toHaveValue(carried));

      // A session that lapses and comes back reads the account's draft again: that is the
      // creator's own save now, and the newer words stay.
      fireEvent.change(box(), { target: { value: 'A slow spin on the spot' } });
      ownDraftAs(null);
      view.rerender(page());
      ownDraftAs('user-1', true);
      view.rerender(page());
      await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledTimes(2));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(box()).toHaveValue('A slow spin on the spot');
    });

    it('never keeps one account’s words for another, nor saves them under it', async () => {
      ownDraftAs('user-1');
      const view = render(<CreateMotionClient prefill={{}} />);
      await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
      fireEvent.change(box(), { target: { value: 'Asha’s cartwheel across the stage' } });
      await waitFor(() => expect(promptsSavedFor('user-1')).toContain('Asha’s cartwheel across the stage'), { timeout: 2_000 });

      // Asha signs out in another tab and Ben, who has no draft, signs in.
      ownDraftAs(null);
      view.rerender(<CreateMotionClient prefill={{}} />);
      ownDraftAs('user-2');
      view.rerender(<CreateMotionClient prefill={{}} />);
      expect(box()).toHaveValue(OPENING);
      await waitFor(() => expect(promptsSavedFor('user-2')).toContain(OPENING), { timeout: 2_000 });
      expect(promptsSavedFor('user-2')).not.toContain('Asha’s cartwheel across the stage');

      ownDraftAs('user-1');
      view.rerender(<CreateMotionClient prefill={{}} />);
      await waitFor(() => expect(box()).toHaveValue('Asha’s cartwheel across the stage'));
    });

    it('fills a box emptied of its opening prompt before the saved draft came back', async () => {
      let answer: (draft: object) => void = () => undefined;
      draftMocks.loadCreatorDraft.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
      render(<CreateMotionClient prefill={{}} />);
      await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
      fireEvent.change(box(), { target: { value: '' } });

      await act(async () => answer(savedDraft('The saved prompt')));
      expect(box()).toHaveValue('The saved prompt');
    });

    it('keeps words typed on the way back over a carried draft that holds only the opening sentence', async () => {
      const page = () => <CreateMotionClient prefill={{}} handoverNonce="nonce-1" />;
      savedDrafts.set('motion:user-1', savedDraft(OPENING));
      ownDraftAs(null);
      const view = render(page());
      fireEvent.change(box(), { target: { value: 'Moonwalk to the left, arms loose' } });

      ownDraftAs('user-1', true);
      view.rerender(page());
      await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(box()).toHaveValue('Moonwalk to the left, arms loose');
    });

    it('goes back to the link’s prompt, not to the stock sentence, when another account signs in', async () => {
      const link = { prompt: 'Moonwalk to the left, arms loose' };
      ownDraftAs('user-1');
      const view = render(<CreateMotionClient prefill={link} />);
      await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
      fireEvent.change(box(), { target: { value: `${link.prompt}, then a spin` } });

      ownDraftAs('user-2');
      view.rerender(<CreateMotionClient prefill={link} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(box()).toHaveValue(link.prompt);
    });

    it('takes the next account’s saved prompt though its read answers before the reset is drawn', async () => {
      savedDrafts.set('motion:user-2', savedDraft('Ben’s backflip off the pier'));
      ownDraftAs('user-1');
      await outsideAct(async (draw) => {
        draw(<CreateMotionClient prefill={{}} />);
        await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
        fireEvent.change(box(), { target: { value: 'Asha’s cartwheel across the stage' } });

        ownDraftAs('user-2');
        draw(<CreateMotionClient prefill={{}} />);
        await waitFor(() => expect(box()).toHaveValue('Ben’s backflip off the pier'));
      });
    });

    it('drops an Enhance answer that comes back after another account signed in', async () => {
      ownDraftAs('user-1');
      const view = render(<CreateMotionClient prefill={{}} />);
      await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
      fireEvent.change(box(), { target: { value: 'Asha’s cartwheel across the stage' } });
      const pressedForAsha = enhanceButton.props!;
      const buttonAshaPressed = enhanceButton.mounted!;

      ownDraftAs('user-2');
      view.rerender(<CreateMotionClient prefill={{}} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(() => {
        pressedForAsha.onEnhanced('Asha’s cartwheel across the stage, arms wide');
        pressedForAsha.onCreditsUpdate(41);
        // A button answering through its newest callbacks is drawn anew for Ben: the one Asha pressed has only hers.
        buttonAshaPressed.current.onEnhanced('Asha’s cartwheel across the stage, arms wide');
        buttonAshaPressed.current.onCreditsUpdate(43);
      });
      expect(box()).toHaveValue(OPENING);
      expect(authState.updateCredits).not.toHaveBeenCalledWith(41);
      expect(authState.updateCredits).not.toHaveBeenCalledWith(43);
      await waitFor(() => expect(promptsSavedFor('user-2')).toContain(OPENING), { timeout: 2_000 });
      expect(promptsSavedFor('user-2')).not.toContain('Asha’s cartwheel across the stage, arms wide');

      // One pressed for the account on the page lands.
      act(() => {
        enhanceButton.props!.onEnhanced('Ben’s backflip off the pier');
        enhanceButton.props!.onCreditsUpdate(12);
      });
      expect(box()).toHaveValue('Ben’s backflip off the pier');
      expect(authState.updateCredits).toHaveBeenCalledWith(12);
    });

    // The picture and clip follow the same rule: one owner's are never shown to another, nor sent
    // or saved under them. Only the sheet's hand-over moves a visitor's into an account.
    const keepFiles = (owner: string, files: { image?: File; clip?: File }) => {
      if (files.image) persistedFiles.set(`create-motion:character-image:${owner}`, files.image);
      if (files.clip) persistedFiles.set(`create-motion:reference-video:${owner}`, files.clip);
    };
    async function readFilesOf(owner: string) {
      await waitFor(() => expect(persistedMediaMocks.getPersistedFile).toHaveBeenCalledWith(`create-motion:reference-video:${owner}`));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const imageShown = () => screen.queryByText('Add the character image') === null;
    const clipShown = () => screen.queryByText('Add the motion clip') === null;
    const lengthsSavedFor = (owner: string) => draftMocks.saveCreatorDraft.mock.calls
      .filter(([, savedFor]) => savedFor === owner)
      .map(([, , draft]) => (draft as { duration: number }).duration);

    it('never keeps one account’s picture and clip for another, nor sends them or saves their length under it', async () => {
      keepFiles('user-1', { image: characterImage(), clip: motionClip() });
      ownDraftAs('user-1');
      const view = render(<CreateMotionClient prefill={{}} />);
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      expect(imageShown()).toBe(true);

      // Asha signs out in another tab and Ben, who has nothing saved, signs in.
      ownDraftAs(null);
      view.rerender(<CreateMotionClient prefill={{}} />);
      ownDraftAs('user-2');
      view.rerender(<CreateMotionClient prefill={{}} />);
      await readFilesOf('user-2');
      expect(imageShown()).toBe(false);
      expect(clipShown()).toBe(false);
      await waitFor(() => expect(lengthsSavedFor('user-2').length).toBeGreaterThan(0), { timeout: 2_000 });
      expect(lengthsSavedFor('user-2').every((seconds) => seconds === 0)).toBe(true);

      // A clip of Ben's own is not enough to start: the run would not take Asha's picture.
      pickFile(view.container, 'motion-reference-video-input', new File(['spin'], 'spin.mp4', { type: 'video/mp4' }));
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      expect(generateButton()).toBeDisabled();
      expect(persistedMediaMocks.setPersistedFile.mock.calls.map(([key, file]) => `${key} ${file.name}`))
        .toEqual(['create-motion:reference-video:user-2 spin.mp4']);

      // Back to Asha: her picture and clip, not Ben's.
      ownDraftAs('user-1');
      view.rerender(<CreateMotionClient prefill={{}} />);
      await waitFor(() => expect(imageShown() && clipShown()).toBe(true));
      expect(vi.mocked(URL.createObjectURL).mock.calls.slice(-2).map(([file]) => (file as File).name))
        .toEqual(['hero.png', 'dance.mp4']);
    });

    it('leaves a visitor’s picture behind when an account signs in without the sign-up sheet', async () => {
      keepFiles('visitor', { image: characterImage() });
      ownDraftAs('visitor');
      const view = render(<CreateMotionClient prefill={{}} />);
      await waitFor(() => expect(imageShown()).toBe(true));

      // Signed in from another tab: the account, which has nothing saved, opens on nothing.
      ownDraftAs('user-1');
      view.rerender(<CreateMotionClient prefill={{}} />);
      await readFilesOf('user-1');
      expect(imageShown()).toBe(false);
    });

    it('keeps the picture and clip the sign-up sheet’s hand-over carried', async () => {
      const page = () => <CreateMotionClient prefill={{}} handoverNonce="nonce-1" />;
      // The page opened before its session came, on the visitor's files.
      keepFiles('visitor', { image: characterImage(), clip: motionClip() });
      ownDraftAs('visitor');
      const view = render(page());
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();

      // The hand-over moves them to the account the visitor signed up with.
      ownDraftAs(null);
      view.rerender(page());
      persistedFiles.clear();
      keepFiles('user-1', { image: characterImage(), clip: motionClip() });
      ownDraftAs('user-1', true);
      view.rerender(page());
      await readFilesOf('user-1');
      expect(imageShown()).toBe(true);
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
    });

    it('keeps the visitor’s picture, clip and words when the sign-up sheet’s hand-over gives up', async () => {
      const page = () => <CreateMotionClient prefill={{}} handoverNonce="nonce-1" />;
      // The page opened before its session came, on the visitor's files and words. The account the
      // visitor signs up with has an older picture of its own saved.
      keepFiles('visitor', { image: characterImage(), clip: motionClip() });
      keepFiles('user-1', { image: new File(['old'], 'old-hero.png', { type: 'image/png' }) });
      ownDraftAs('visitor');
      const view = render(page());
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      fireEvent.change(box(), { target: { value: 'A slow spin with both arms wide' } });

      // The move to that account does not answer in time, so the page goes on with the account.
      ownDraftAs(null);
      view.rerender(page());
      ownDraftAs('user-1', false, true);
      view.rerender(page());
      await readFilesOf('user-1');
      // The form stays as the visitor left it, with no older picture of the account's over it.
      expect(imageShown()).toBe(true);
      expect(vi.mocked(URL.createObjectURL).mock.calls.map(([file]) => (file as File).name)).not.toContain('old-hero.png');
      expect(screen.getByText('Reference length: 7.3s')).toBeInTheDocument();
      expect(box()).toHaveValue('A slow spin with both arms wide');
    });

    // Owner, 2026-11-01, "Yes, clear it": a sign-out made in this browser clears the page, and the
    // page is the visitor's after it; a session that lapses keeps it.
    it('clears the page when its account signs out in this browser, and leaves it the visitor’s', async () => {
      keepFiles('user-1', { image: characterImage(), clip: motionClip() });
      const view = render(<CreateMotionClient prefill={{}} />);
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      fireEvent.change(box(), { target: { value: 'A slow spin with both arms wide' } });

      authState.session = null;
      authState.signedOut = true;
      view.rerender(<CreateMotionClient prefill={{}} />);
      await readFilesOf('visitor');

      expect(imageShown()).toBe(false);
      expect(screen.queryByText('Reference length: 7.3s')).toBeNull();
      expect(box()).not.toHaveValue('A slow spin with both arms wide');
      expect(screen.getByRole('button', { name: 'Sign up to generate' })).toBeInTheDocument();
    });

    it('keeps the page through a session that lapses', async () => {
      keepFiles('user-1', { image: characterImage(), clip: motionClip() });
      const view = render(<CreateMotionClient prefill={{}} />);
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      fireEvent.change(box(), { target: { value: 'A slow spin with both arms wide' } });

      authState.session = null;
      view.rerender(<CreateMotionClient prefill={{}} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(imageShown()).toBe(true);
      expect(screen.getByText('Reference length: 7.3s')).toBeInTheDocument();
      expect(box()).toHaveValue('A slow spin with both arms wide');
      expect(screen.queryByRole('button', { name: 'Sign up to generate' })).toBeNull();
    });
  });

  // The run follows the form: when another account takes the page (from another tab, or after a
  // sign-out), the earlier account's unanswered start, a press of theirs still under way, their
  // result and their remix's inputs go with their form, and nothing is sent under the next.
  describe('when another account takes the page', () => {
    const page = () => <CreateMotionClient prefill={{}} />;
    const PENDING_START_KEY = 'magicbooklet:pending-generation-start:v1:motion';
    const box = () => screen.getByPlaceholderText(/Describe the kind of movement/);
    const sessionOf = (userId: string) => ({ access_token: `token-${userId}`, user: { id: userId } });
    /** Another account signs in from another tab: the browser's auth client has its session, then the page. */
    function signInAs(userId: string, redraw?: () => void) {
      authClientSignsInAs(userId);
      authState.session = sessionOf(userId);
      draftOwnerOverride.current = { owner: userId, carriedDraft: false, keepsVisitorForm: false };
      redraw?.();
    }
    /** The browser's auth client holds another account's session while the page still checks it. */
    function authClientSignsInAs(userId: string) {
      sessionState.signedIn = true;
      sessionState.session = sessionOf(userId);
    }
    /** The session ends with no mark of a sign-out (a lapse): a page that opened signed in keeps its form, owned by no one. */
    function signOutHere(redraw: () => void) {
      sessionState.signedIn = false;
      authState.session = null;
      draftOwnerOverride.current = { owner: null, carriedDraft: false, keepsVisitorForm: false };
      redraw();
    }
    const authorizationOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('Authorization');
    async function settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const imageShown = () => screen.queryByText('Add the character image') === null;
    const clipShown = () => screen.queryByText('Add the motion clip') === null;
    async function pressForAsha() {
      signInAs('user-1');
      const view = render(page());
      await attachBothInputs(view.container);
      fireEvent.change(box(), { target: { value: 'Asha moonwalks across the roof' } });
      await pressGenerate();
      return view;
    }

    // Each creator is drawn for one owner and stops what it started as it goes: development's
    // Strict Mode mounts it twice, and the second mount's presses go on.
    it('still sends a press on a page that development’s Strict Mode mounts twice', async () => {
      const view = render(<StrictMode><CreateMotionClient prefill={{}} /></StrictMode>);
      await attachBothInputs(view.container);
      await pressGenerate();
      expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
      expect(startPosts()).toHaveLength(1);
      expect(authState.updateCredits).toHaveBeenCalledWith(9_980);
    });

    it('drops the earlier account’s unanswered start, and the next account’s press sends its own run', async () => {
      startAnswers = [new TypeError('Failed to fetch')];
      const view = await pressForAsha();
      expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(page()));
      await settle();
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();

      await attachBothInputs(view.container);
      fireEvent.change(box(), { target: { value: 'Ben spins on the spot' } });
      await pressGenerate();
      expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
      expect(startBodies()[1]).toMatchObject({ prompt: 'Ben spins on the spot' });
      expect(startKeys()[1]).not.toBe(startKeys()[0]);
      expect(authorizationOf(startPosts()[1][1])).toBe('Bearer token-user-2');
    });

    it('checks no start again under a session another account has taken, while the page still checks it', async () => {
      startAnswers = [new TypeError('Failed to fetch')];
      await pressForAsha();
      expect(await screen.findByRole('button', { name: 'Check again' })).toBeInTheDocument();

      authClientSignsInAs('user-2');
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await settle();

      expect(startPosts()).toHaveLength(1);
      // Still Asha's, to check under her session.
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    });

    it.each([
      ['once the page knows', true],
      ['while the page still checks the session', false],
    ])('sends nothing for a press still uploading when another account signs in, %s', async (_when, pageKnows) => {
      let finishUpload: () => void = () => undefined;
      uploadMocks.uploadMediaToTemporaryStorage.mockImplementationOnce((file: File) => new Promise((resolve) => {
        finishUpload = () => resolve({ signedUrl: `https://storage.example/uploads/${file.name}?token=first`, storagePath: `uploads/user-1/${file.name}` });
      }));
      const view = await pressForAsha();
      await waitFor(() => expect(uploadMocks.uploadMediaToTemporaryStorage).toHaveBeenCalled());

      if (pageKnows) signInAs('user-2', () => view.rerender(page()));
      else authClientSignsInAs('user-2');
      await settle();
      await act(async () => finishUpload());
      await settle();

      expect(startPosts()).toEqual([]);
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
      expect(authState.updateCredits).not.toHaveBeenCalled();
      // Uploaded for Asha alone: under another account's session the upload refuses to go.
      expect(uploadMocks.uploadMediaToTemporaryStorage).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'hero.png' }),
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('uploads and sends nothing for a press made after another account took the session, before the page heard', async () => {
      signInAs('user-1');
      const view = render(page());
      await attachBothInputs(view.container);

      authClientSignsInAs('user-2');
      await pressGenerate();
      await settle();

      expect(uploadMocks.uploadMediaToTemporaryStorage).not.toHaveBeenCalled();
      expect(startPosts()).toEqual([]);
    });

    it('uploads and sends nothing for a press on a page signed out in another tab, once another account took the session', async () => {
      signInAs('user-1');
      const view = render(page());
      await attachBothInputs(view.container);

      // Asha's session ends with no mark of a sign-out (a lapse): the page keeps her form, owned by no one. Ben then signs in
      // there, and the browser has his session before the page does.
      signOutHere(() => view.rerender(page()));
      authClientSignsInAs('user-2');
      await pressGenerate();
      await settle();

      expect(uploadMocks.uploadMediaToTemporaryStorage).not.toHaveBeenCalled();
      expect(startPosts()).toEqual([]);
    });

    it('forgets a start refused after the page was left, so the next visit does not send it again', async () => {
      let answer: (response: Response) => void = () => undefined;
      startAnswers = [() => new Promise<Response>((resolve) => { answer = resolve; })];
      const view = await pressForAsha();
      await waitFor(() => expect(startPosts()).toHaveLength(1));

      view.unmount();
      await act(async () => answer(jsonResponse({ code: 'insufficient_credits', error: 'Insufficient credits. This action costs 20 credits.' }, 402)));

      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
    });

    it('still sends a press whose page was left while its picture went up, under its own account', async () => {
      let finishUpload: () => void = () => undefined;
      uploadMocks.uploadMediaToTemporaryStorage.mockImplementationOnce((file: File) => new Promise((resolve) => {
        finishUpload = () => resolve({ signedUrl: `https://storage.example/uploads/${file.name}?token=first`, storagePath: `uploads/user-1/${file.name}` });
      }));
      const view = await pressForAsha();
      await waitFor(() => expect(uploadMocks.uploadMediaToTemporaryStorage).toHaveBeenCalled());

      view.unmount();
      await act(async () => finishUpload());

      await waitFor(() => expect(startPosts()).toHaveLength(1));
      expect(authorizationOf(startPosts()[0][1])).toBe('Bearer token-user-1');
    });

    it('takes the earlier account’s result, its caption and its Post form off the canvas', async () => {
      generationLookupBody = { generations: [{ id: 'generation-1', title: 'Rooftop dance', paywallPrefill: null }] };
      const view = await pressForAsha();
      expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
      expect(screen.getByText('Asha moonwalks across the roof', { selector: 'p' })).toBeInTheDocument();
      expect(await screen.findByRole('form', { name: 'Post it to the feed' })).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(page()));
      await settle();

      expect(screen.queryByRole('link', { name: /Download video/ })).toBeNull();
      expect(screen.queryByText('Asha moonwalks across the roof', { selector: 'p' })).toBeNull();
      expect(screen.queryByRole('form', { name: 'Post it to the feed' })).toBeNull();
    });

    it('takes the earlier account’s failed run off the canvas', async () => {
      statusMocks.fetchGenerationStatusWithRetry.mockResolvedValue({ status: 'failed', error: 'The provider could not render Asha’s clip' });
      const view = await pressForAsha();
      expect(await screen.findByRole('alert')).toHaveTextContent('The provider could not render Asha’s clip');

      signInAs('user-2', () => view.rerender(page()));
      await settle();

      expect(screen.queryByText(/could not render Asha’s clip/)).toBeNull();
      expect(screen.queryByRole('heading', { name: 'It didn’t finish' })).toBeNull();
    });

    it('takes the server’s refusal of the earlier account’s start off the page', async () => {
      startAnswers = [jsonResponse({ code: 'insufficient_credits', error: 'Insufficient credits. This action costs 20 credits.' }, 402)];
      // Ben's own saved picture and clip, priced as Asha's run was.
      persistedFiles.set('create-motion:character-image:user-2', new File(['ben'], 'ben.png', { type: 'image/png' }));
      persistedFiles.set('create-motion:reference-video:user-2', new File(['spin'], 'spin.mp4', { type: 'video/mp4' }));
      const view = await pressForAsha();
      expect(await screen.findByText('Insufficient credits. This action costs 20 credits.')).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(page()));
      await waitFor(() => expect(persistedMediaMocks.getPersistedFile).toHaveBeenCalledWith('create-motion:reference-video:user-2'));
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      await settle();

      expect(screen.queryByText('Insufficient credits. This action costs 20 credits.')).toBeNull();
      expect(screen.queryByRole('link', { name: /Top Up Credits/ })).toBeNull();
    });

    it('drops the earlier account’s remix inputs and its own, and reads the remix again for the next', async () => {
      const remixPage = () => <CreateMotionClient prefill={{ remixId: 'generation-source' }} />;
      // Asha's own run: its picture and clip are given back to her alone, and its source is refused to another account.
      remixSourceBody = {
        generation: { id: 'generation-source', title: 'Rooftop dance', prompt: 'Dance on the roof at dusk', category: 'video', model: 'kling-3.0' },
        result: { mediaType: 'video', url: 'https://cdn.example/source-result.mp4' },
        inputs: {
          motion: {
            characterImage: { kind: 'image', url: 'https://cdn.example/hero.png', label: 'Hero still', storagePath: 'generation_inputs/user-1/generation-source/00.png', sourceGenerationId: 'generation-source' },
            referenceVideo: { kind: 'video', url: 'https://cdn.example/dance.mp4', label: 'Reference video', storagePath: 'generation_inputs/user-1/generation-source/01.mp4', sourceGenerationId: 'generation-source' },
          },
        },
        workflowSettings: { model: 'kling-3.0' },
        restoreIssues: [],
      };
      const ashasRead = fetchMock.getMockImplementation()!;
      onTestFinished(() => {
        fetchMock.mockImplementation(ashasRead);
      });
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
        String(input).startsWith('/api/remix-source?') && authorizationOf(init) !== 'Bearer token-user-1'
          ? jsonResponse({ error: 'Remix source not found' }, 404)
          : ashasRead(input, init)
      ));
      signInAs('user-1');
      const view = render(remixPage());
      expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();
      // She swaps the run's picture for one of her own.
      pickFile(view.container, 'motion-character-image-input', new File(['selfie'], 'selfie.png', { type: 'image/png' }));
      await waitFor(() => expect(vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]).toMatchObject({ name: 'selfie.png' }));

      signInAs('user-2', () => view.rerender(remixPage()));
      await waitFor(() => expect(fetchMock.mock.calls
        .filter(([input]) => String(input).startsWith('/api/remix-source?'))
        .map(([, init]) => authorizationOf(init))).toEqual(['Bearer token-user-1', 'Bearer token-user-2']));
      await settle();

      expect(imageShown()).toBe(false);
      expect(clipShown()).toBe(false);
    });
  });

  it('keeps media per account and clears legacy media once', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    expect(persistedMediaMocks.purgeLegacyPersistedMedia).toHaveBeenCalledTimes(1);
    expect(persistedMediaMocks.getPersistedFile.mock.calls.map(([key]) => key)).toEqual([
      'create-motion:character-image:user-1',
      'create-motion:reference-video:user-1',
    ]);
    expect(persistedMediaMocks.setPersistedFile.mock.calls.map(([key]) => key)).toEqual([
      'create-motion:character-image:user-1',
      'create-motion:reference-video:user-1',
    ]);
  });

  it('restores the saved files with the length last measured for the clip', async () => {
    persistedFiles.set('create-motion:character-image:user-1', characterImage());
    persistedFiles.set('create-motion:reference-video:user-1', motionClip());
    savedDrafts.set('motion:user-1', {
      prompt: 'Saved',
      duration: 9,
      characterOrientation: 'video',
      mode: '720p',
      linkPrefill: { prompt: null, model: null },
    });

    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByText('Reference length: 9.0s')).toBeInTheDocument();
    await waitFor(() => expect(quoteStandIn.requests.at(-1)).toMatchObject({ settings: { duration: 9 } }));
  });

  it('neither restores nor saves the ordinary draft on a remix page', async () => {
    const view = render(<CreateMotionClient prefill={{ remixId: 'generation-source' }} />);

    pickFile(view.container, 'motion-character-image-input', characterImage());
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Remix prompt' } });
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(draftMocks.loadCreatorDraft).not.toHaveBeenCalled();
    expect(draftMocks.saveCreatorDraft).not.toHaveBeenCalled();
    expect(persistedMediaMocks.getPersistedFile).not.toHaveBeenCalled();
    expect(persistedMediaMocks.setPersistedFile).not.toHaveBeenCalled();
  });

  it('refuses a file the upload would refuse, naming it, and keeps the attached clip', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    pickFile(view.container, 'motion-character-image-input', new File(['bmp'], 'scan.bmp', { type: 'image/bmp' }));
    expect(await screen.findByText('"scan.bmp" isn\'t a supported image. Use a JPG, PNG or WEBP file.')).toBeInTheDocument();

    const hugeClip = motionClip();
    Object.defineProperty(hugeClip, 'size', { value: 101 * 1024 * 1024 });
    Object.defineProperty(hugeClip, 'name', { value: 'long-take.mp4' });
    pickFile(view.container, 'motion-reference-video-input', hugeClip);
    expect(await screen.findByText('"long-take.mp4" is over 100 MB. Please upload a smaller video.')).toBeInTheDocument();

    expect(persistedMediaMocks.setPersistedFile).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Reference length: 7.3s')).toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  it('marks the Studio link with a gallery icon, not a download', async () => {
    render(<CreateMotionClient prefill={{}} />);

    const studioLink = await screen.findByRole('link', { name: /^Studio/ });
    expect(studioLink.querySelector('svg.lucide-images')).not.toBeNull();
    expect(studioLink.querySelector('svg.lucide-download')).toBeNull();
  });
});

// The motion creator on the app's column (2026-10-26): the run's settings fold into one chip
// on the bar, read back as the app reads them, and the result canvas comes into view only once
// a start the creator pressed is confirmed.
describe('CreateMotionClient on the column', () => {
  it('reads the quality back on the bar\'s chip, and the clip\'s length once there is one', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    expect(await screen.findByRole('button', { name: 'Generation settings: 720P · Add motion' })).toBeInTheDocument();

    await attachBothInputs(view.container);

    // 7.3 seconds, counted as the app counts them.
    expect(screen.getByRole('button', { name: 'Generation settings: 720P · 8s' })).toBeInTheDocument();
  });

  it('reads "Add motion" while the page holds no clip, though a run picked up on load gave a length', async () => {
    // The newest run, still under way, comes back with its length and without its clip.
    activeRun = { id: 'gen-motion-1', predictionId: 'pred-motion-1', status: 'processing', createdAt: new Date().toISOString(), duration: 10, prompt: 'Saved prompt', cost: null, model: null };
    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generation settings: / })).toHaveAccessibleName('Generation settings: 720P · Add motion');
  });

  it('keeps the length measured from the clip it holds when a run picked up on load gave another', async () => {
    let answerLook: (response: Response) => void = () => undefined;
    activeRunAnswer = new Promise<Response>((resolve) => { answerLook = resolve; });
    const view = render(<CreateMotionClient prefill={{}} />);
    await waitFor(() => expect(activeRunReads()).toHaveLength(1));
    await attachBothInputs(view.container);

    await act(async () => {
      answerLook(jsonResponse({ run: { id: 'gen-motion-1', predictionId: 'pred-motion-1', status: 'processing', createdAt: new Date().toISOString(), duration: 10, prompt: 'Saved prompt', cost: 30, model: 'kling-3.0' } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(statusMocks.fetchGenerationStatusWithRetry).toHaveBeenCalled();
    expect(screen.getByText('Reference length: 7.3s')).toBeInTheDocument();
  });

  it('keeps the prompt the run was sent with under its clip while the next one is written', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Keep the arms loose and the steps light.' } });
    await pressGenerate();
    await screen.findByRole('link', { name: /Download video/ });

    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'A slow spin on the spot.' } });

    const canvas = screen.getByRole('region', { name: 'Result' });
    expect(within(canvas).getByText('Keep the arms loose and the steps light.')).toBeInTheDocument();
    expect(within(canvas).queryByText('A slow spin on the spot.')).toBeNull();
  });

  // The artboard Result and the build notes: Done, with the run's line, takes the focus.
  it('says Done with the run\'s line and gives the result the focus when the run ends', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await pressGenerate();

    const canvas = screen.getByRole('region', { name: 'Result' });
    const heading = await within(canvas).findByRole('heading', { name: 'Done' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(canvas).getByTestId('creator-canvas-chip')).toHaveTextContent(/ · 20 credits$/);
  });

  // The shell's run toast would only say again what the canvas says, over Publish (2026-10-30):
  // the page follows the run it shows, and says how it ended once the canvas shows that.
  it('tells the shell\'s run toasts it follows its run, then how it ended once the canvas shows it', async () => {
    clearGenerationsOnPage();
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationOnPage(heard);
    try {
      let finish: (value: unknown) => void = () => {};
      statusMocks.fetchGenerationStatusWithRetry.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const view = render(<CreateMotionClient prefill={{}} />);
      await attachBothInputs(view.container);
      await pressGenerate();

      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(await within(canvas).findByRole('heading', { name: 'Animating your character' })).toBeInTheDocument();
      await waitFor(() => expect(heard).toHaveBeenCalledWith({ id: 'generation-1', state: 'following' }));
      expect(heard).toHaveBeenCalledTimes(1);

      await act(async () => {
        finish({ status: 'succeeded', output: 'https://cdn.example/motion-result.mp4' });
      });
      expect(await within(canvas).findByRole('heading', { name: 'Done' })).toBeInTheDocument();
      await waitFor(() => expect(heard).toHaveBeenCalledWith({ id: 'generation-1', state: 'succeeded' }));
      expect(heard).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      clearGenerationsOnPage();
    }
  });

  it('plays the finished clip once: beside the column it never leaves the window to be paused', async () => {
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await pressGenerate();
    await screen.findByRole('link', { name: /Download video/ });

    expect(resultVideoState.props).toMatchObject({ loop: false, outputUrl: 'https://cdn.example/motion-result.mp4' });
  });

  describe('the result canvas', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    let scrollIntoView: ReturnType<typeof vi.fn>;
    let rects: { mockRestore: () => void } | null = null;

    /** Draws the canvas `top` pixels down the window: 1500 under the column, 88 beside it. */
    function placeCanvas(top: number) {
      rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const y = this.getAttribute('aria-label') === 'Result' ? top : 0;
        return { top: y, bottom: y, left: 0, right: 0, width: 0, height: 0, x: 0, y, toJSON: () => ({}) } as DOMRect;
      });
    }

    beforeEach(() => {
      scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
    });

    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView;
      rects?.mockRestore();
      rects = null;
    });

    it('is brought into view under the column once the run it started is under way', async () => {
      placeCanvas(1500);
      const view = render(<CreateMotionClient prefill={{}} />);
      await attachBothInputs(view.container);

      await pressGenerate();

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toHaveAttribute('aria-label', 'Result');
    });

    it('stays put when the start is refused, so the reason in the bar stays in view', async () => {
      placeCanvas(1500);
      startAnswers = [
        jsonResponse({ code: 'INVALID_GENERATION_REQUEST', error: 'The prompt is too long.', fieldErrors: { prompt: 'The prompt is too long.' } }, 422),
      ];
      const view = render(<CreateMotionClient prefill={{}} />);
      await attachBothInputs(view.container);

      await pressGenerate();

      expect(await screen.findByText('The prompt is too long.')).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('stays put when an unanswered start is checked again on load, so the page opens at its top', async () => {
      placeCanvas(1500);
      savePendingWebStart(pendingStart());
      render(<CreateMotionClient prefill={{}} />);

      expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });
});

/**
 * The server's opening (`loadCreatorOpening`), drawn from the first paint (2026-10-29): the model the page
 * opens on and its published settings, in place of Kling 3.0's, until the first pick.
 */
describe('CreateMotionClient opening', () => {
  const opening: CreatorOpening = {
    revision: 'test-catalog-rev',
    modelId: 'kling-2.6',
    settings: { resolution: '1080p', characterOrientation: 'image', duration: 10 },
    costCredits: null,
  };

  it('draws the opening\'s model and settings, and waits for the revision the network confirms before its first pick', async () => {
    // The browser's stored catalog names Kling 3.0 its default (this file's catalog): until the
    // network confirms it, the page keeps the run it was drawn on.
    modelCatalogState.checkingRevision = true;
    const view = render(<CreateMotionClient prefill={{}} opening={opening} />);
    const modelChip = () => view.container.querySelector('button[aria-haspopup="listbox"]');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modelChip()).toHaveTextContent('Kling 2.6');
    expect(screen.getByRole('button', { name: /^Generation settings: / })).toHaveAccessibleName('Generation settings: 1080P · Add motion');

    modelCatalogState.checkingRevision = false;
    view.rerender(<CreateMotionClient prefill={{}} opening={opening} />);
    await waitFor(() => expect(modelChip()).toHaveTextContent('Kling 3.0'));
  });

  it('keeps a model the creator picks while the page waits for the revision', async () => {
    modelCatalogState.checkingRevision = true;
    modelCatalogState.summaries = motionModelSummaries;
    const view = render(<CreateMotionClient prefill={{}} opening={{ ...opening, modelId: 'kling-3.0' }} />);
    const modelChip = () => view.container.querySelector('button[aria-haspopup="listbox"]');
    chooseModel(view.container, 'Kling 2.6');
    expect(modelChip()).toHaveTextContent('Kling 2.6');

    // This file's catalog names Kling 3.0 its default.
    modelCatalogState.checkingRevision = false;
    view.rerender(<CreateMotionClient prefill={{}} opening={{ ...opening, modelId: 'kling-3.0' }} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modelChip()).toHaveTextContent('Kling 2.6');
  });
});
