import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateMotionClient from '@/app/create-motion/CreateMotionClient';
import { GenerationStatusRequestError } from '@/lib/generation-status-client';
import { loadPendingWebStart, savePendingWebStart, type PendingWebStart } from '@/lib/generation-model-client';

const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
}));
const quoteState = vi.hoisted(() => ({
  errorCode: null as string | null,
  requests: [] as Array<Record<string, unknown> | null>,
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
  default: () => null,
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

vi.mock('@/lib/use-deployment-refresh', () => ({
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
    // As the real hook: no request, no quote.
    useWebGenerationModelQuote: (input: Record<string, unknown> | null) => {
      quoteState.requests.push(input);
      if (!input) return { status: 'idle', quote: null, error: null };
      return quoteState.errorCode
        ? {
          status: 'error',
          quote: null,
          error: new actual.WebCatalogRequestError('The model catalog changed.', 409, quoteState.errorCode),
        }
        : {
          status: 'ready',
          quote: {
            modelId: 'kling-3.0',
            catalogRevision: 'test-catalog-rev',
            normalizedSettings: {},
            costCredits: 20,
          },
          error: null,
        };
    },
  };
});

const motionModelSummaries = [
  { id: 'kling-3.0', kind: 'motion', displayName: 'Kling 3.0 Motion', description: 'Test motion model' },
  { id: 'kling-2.6', kind: 'motion', displayName: 'Kling 2.6', description: 'Test stable motion model' },
];

type StartAnswer = Response | Error | (() => Response | Promise<Response>);
let startAnswers: StartAnswer[] = [];
let generationLookupBody: unknown = { generations: [] };

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
  return screen.getByRole('button', { name: /^(Generate motion|Check again|Generating\.\.\.)$/ });
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
  quoteState.errorCode = null;
  quoteState.requests = [];
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
  startAnswers = [];
  generationLookupBody = { generations: [] };
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
    quoteState.errorCode = 'CATALOG_CHANGED';
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);
    expect(await screen.findByText(/Review the refreshed options/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss model notice' }));

    await waitFor(() => {
      expect(screen.queryByText(/Review the refreshed options/)).not.toBeInTheDocument();
    });
  });

  it('clears a catalog-changed notice when the creator picks another model', async () => {
    quoteState.errorCode = 'CATALOG_CHANGED';
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
    expect(quoteState.requests.every((request) => request === null)).toBe(true);

    pickFile(view.container, 'motion-character-image-input', characterImage());
    await waitFor(() => expect(persistedMediaMocks.setPersistedFile).toHaveBeenCalledTimes(1));
    expect(quoteState.requests.every((request) => request === null)).toBe(true);

    pickFile(view.container, 'motion-reference-video-input', motionClip());
    expect(await screen.findByText('Reference length: 7.3s')).toBeInTheDocument();

    const lastRequest = quoteState.requests.at(-1);
    expect(lastRequest).toMatchObject({
      kind: 'motion',
      settings: { duration: 8 },
      inputCounts: { images: 1, videos: 1, audios: 0 },
    });
    expect(screen.queryByText('Add a character image and a motion clip to see the cost.')).not.toBeInTheDocument();
    expect(screen.getByText('20 credits')).toBeInTheDocument();
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
    expect(generateButton()).toHaveTextContent('Generate motion');

    await pressGenerate();

    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startKeys()[1]).not.toBe(startKeys()[0]);
  });

  it('checks an unanswered start again on the next visit before looking for the newest run', async () => {
    savePendingWebStart(pendingStart());

    render(<CreateMotionClient prefill={{}} />);

    await waitFor(() => expect(startPosts()).toHaveLength(1));
    expect(startKeys()[0]).toBe('motion:saved-key');
    expect(startBodies()[0]).toMatchObject({ prompt: 'Saved prompt', schemaVersion: 3 });
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
    expect(quoteState.requests.at(-1)).toMatchObject({ settings: { duration: 9 } });
    expect(loadPendingWebStart('motion', 'user-1')).toBeNull();

    await pressGenerate();
    await waitFor(() => expect(startPosts()).toHaveLength(2));
    expect(startBodies()[1]).toMatchObject({ settings: { duration: 9 } });
  });

  it('says the credits of a failed run were returned and refreshes the balance', async () => {
    const creditsUpdated = vi.fn();
    window.addEventListener('credits_updated', creditsUpdated);
    statusMocks.fetchGenerationStatusWithRetry.mockResolvedValue({ status: 'failed', error: 'The provider could not render this clip' });
    const view = render(<CreateMotionClient prefill={{}} />);
    await attachBothInputs(view.container);

    await pressGenerate();

    expect(await screen.findByText('The provider could not render this clip. Your 20 credits were returned.')).toBeInTheDocument();
    expect(creditsUpdated).toHaveBeenCalled();
    window.removeEventListener('credits_updated', creditsUpdated);
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

describe('CreateMotionClient drafts and media', () => {
  it('restores the prompt and settings after a remount, ahead of the catalog default', async () => {
    const first = render(<CreateMotionClient prefill={{}} />);
    await waitFor(() => expect(draftMocks.loadCreatorDraft).toHaveBeenCalledWith('motion', 'user-1'));
    fireEvent.change(screen.getByPlaceholderText(/Describe the kind of movement/), { target: { value: 'Moonwalk to the left' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pro 1080p' }));
    await waitFor(() => expect(savedDrafts.get('motion:user-1')).toMatchObject({
      prompt: 'Moonwalk to the left',
      mode: '1080p',
    }), { timeout: 2_000 });
    first.unmount();

    savedDrafts.set('motion:user-1', { ...(savedDrafts.get('motion:user-1') as object), modelId: 'kling-2.6' });
    render(<CreateMotionClient prefill={{}} />);

    expect(await screen.findByDisplayValue('Moonwalk to the left')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Kling 2.6').length).toBeGreaterThan(0));
    expect(screen.getAllByText('1080p').length).toBeGreaterThan(0);
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
    await waitFor(() => expect(quoteState.requests.at(-1)).toMatchObject({ settings: { duration: 9 } }));
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

  it('marks the Studio links with a gallery icon, not a download', async () => {
    render(<CreateMotionClient prefill={{}} />);

    const studioLink = await screen.findByRole('link', { name: /View Studio/ });
    expect(studioLink.querySelector('svg.lucide-images')).not.toBeNull();
    expect(studioLink.querySelector('svg.lucide-download')).toBeNull();
  });
});
