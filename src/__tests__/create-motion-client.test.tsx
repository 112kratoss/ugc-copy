import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import CreateMotionClient from '@/app/create-motion/CreateMotionClient';
import { GenerationStatusRequestError } from '@/lib/generation-status-client';
import { loadPendingWebStart, savePendingWebStart, type PendingWebStart } from '@/lib/generation-model-client';
import { buildUnifiedGenerationQuoteInput, parseUnifiedGenerationRequest } from '@/lib/unified-generation-start-service';
import type { CatalogInputMode } from '@/lib/generation-model-catalog';
import { MOTION_PROMPT_MAX_LENGTH } from '../../ugc-mobile/lib/model-catalog/protocol';
import { PRODUCTION_KLING_3_MOTION_MODES } from './fixtures/production-motion-descriptors';
import { quoteStandIn } from './fixtures/web-quote-stand-in';
import { priceListStandIn, pricedBy } from './fixtures/quote-prices-stand-in';
import { chooseSetting, costShown } from './fixtures/creator-column-bar';

const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
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
  },
  updateCredits: vi.fn(),
}));
const sessionState = vi.hoisted(() => ({ signedIn: true }));
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
const publishModalState = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
// What the result's player was last given.
const resultVideoState = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

const maybeSingleMock = vi.fn(async () => ({ data: null, error: null }));
const queryBuilder = {
  select: vi.fn(() => queryBuilder),
  eq: vi.fn(() => queryBuilder),
  in: vi.fn(() => queryBuilder),
  order: vi.fn(() => queryBuilder),
  limit: vi.fn(() => queryBuilder),
  maybeSingle: maybeSingleMock,
};

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

vi.mock('@/components/EnhancePromptButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/components/GenerationResultVideo', () => ({
  default: (props: Record<string, unknown>) => {
    resultVideoState.props = props;
    return null;
  },
}));

vi.mock('@/components/PublishToShowcaseModal', () => ({
  default: (props: Record<string, unknown>) => {
    publishModalState.props = props;
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
          session: sessionState.signedIn
            ? { access_token: 'test-token', user: { id: 'user-1' } }
            : null,
        },
      })),
    },
    from: vi.fn(() => queryBuilder),
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
  throw new Error(`Unexpected fetch ${url}`);
});

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
  modelCatalogState.summaries = [];
  quoteStandIn.reset(20);
  priceListStandIn.reset();
  for (const model of motionCatalog.models) delete (model as { inputModes?: unknown }).inputModes;
  generationCatalogRefetchMock.mockClear();
  maybeSingleMock.mockClear();
  queryBuilder.select.mockClear();
  routerMock.push.mockClear();
  authState.credits = 10_000;
  authState.updateCredits.mockClear();
  sessionState.signedIn = true;
  persistedFiles.clear();
  Object.values(persistedMediaMocks).forEach((mock) => mock.mockClear());
  savedDrafts.clear();
  Object.values(draftMocks).forEach((mock) => mock.mockClear());
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
  publishModalState.props = null;
  resultVideoState.props = null;
  startAnswers = [];
  generationLookupBody = { generations: [] };
  remixSourceBody = null;
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
 * `characterImage` and `referenceVideo` to every model, and production's Kling 3.0 refused every
 * web run ("Kling 3.0 does not support the characterImage input."), as the app's went through.
 * `creator-run-inputs.test.ts` holds the server's own verdict on these slots.
 */
describe('CreateMotionClient slots the model declares', () => {
  it('sends Kling 3.0’s inputs in the slots production publishes', async () => {
    publishMotionModes('kling-3.0', PRODUCTION_KLING_3_MOTION_MODES);
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    await waitFor(() => expect(costShown()).toBe('20 credits'));
    const shown = shownQuote();

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(1));

    const inputs = startBodies()[0].inputs as Array<Record<string, unknown>>;
    expect(startBodies()[0].modelId).toBe('kling-3.0');
    expect(inputs.map((input) => [input.slot, input.kind, input.storagePath])).toEqual([
      ['imageReferences', 'image', 'uploads/user-1/hero.png'],
      ['videoReferences', 'video', 'uploads/user-1/dance.mp4'],
    ]);
    expect(shown).toBe(startQuote(0));
  });

  it('plans the slots again when the creator switches model', async () => {
    publishMotionModes('kling-3.0', PRODUCTION_KLING_3_MOTION_MODES);
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
    expect(queryBuilder.select).not.toHaveBeenCalled();
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();
  });

  it('does not replay another account’s unanswered start', async () => {
    savePendingWebStart(pendingStart({ userId: 'someone-else' }));

    render(<CreateMotionClient prefill={{}} />);

    await waitFor(() => expect(queryBuilder.select).toHaveBeenCalled());
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
    maybeSingleMock.mockResolvedValueOnce({
      data: { id: 'gen-motion-1', prediction_id: 'pred-motion-1', status: 'processing', created_at: new Date().toISOString(), duration: 10, prompt: 'Saved prompt', cost: 30, model: 'kling-3.0' },
      error: null,
    } as never);
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

  it('hands the quick-publish modal the creation’s own title and recipe', async () => {
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

    await waitFor(() => expect(publishModalState.props).toMatchObject({
      generationId: 'generation-1',
      defaultTitle: 'Rooftop dance',
      paywallPrefill,
    }));
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
    maybeSingleMock.mockResolvedValueOnce({
      data: { id: 'gen-motion-1', prediction_id: 'pred-motion-1', status: 'processing', created_at: new Date().toISOString(), duration: 10, prompt: 'Saved prompt' },
      error: null,
    } as never);
    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByRole('link', { name: /Download video/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generation settings: / })).toHaveAccessibleName('Generation settings: 720P · Add motion');
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
