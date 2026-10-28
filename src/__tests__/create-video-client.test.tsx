import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateVideoClient from '@/app/create-video/CreateVideoClient';
import { VIDEO_MODELS } from '@/lib/client-generation-models';
import { buildGenerationModelCatalog, type GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import type { PersistedImageElementRecord, PersistedMediaRecord, PersistedSubjectRecord } from '@/lib/persisted-media';
// For "references saved on another model": the registry the page reads, the server's
// catalog and its quote function, and what hands the one to the other in the browser.
import * as clientModels from '@/lib/client-generation-models';
import * as serverCatalog from '@/lib/generation-model-catalog';
import * as catalogClient from '@/lib/generation-model-client';
import type { EnhancerContext } from '@/lib/prompt-enhancer';
import type { RemixResolvedSubject, RemixSourceBundle } from '@/lib/remix-source';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { inspectPromptQuality } from '@/lib/prompt-quality';
import { supabase } from '@/lib/supabase';
import { TemporaryMediaReadUrlError } from '@/lib/temporary-media-upload';
// What the server quotes when it starts a run: for "the price of the run the page sends".
import { buildUnifiedGenerationQuoteInput, parseUnifiedGenerationRequest } from '@/lib/unified-generation-start-service';
import { quoteStandIn } from './fixtures/web-quote-stand-in';
import { priceListStandIn, pricedBy } from './fixtures/quote-prices-stand-in';
import { chooseSetting as chooseAspectRatio, costShown, generateButton, queryGenerateButton } from './fixtures/creator-column-bar';

// One router for every render: a new object per render restarts effects that read it.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const mockPush = routerMock.push;
const mockUpdateCredits = vi.fn();
const loadCreatorDraftMock = vi.hoisted(() => vi.fn(async (_tool: string, _userId: string): Promise<unknown> => {
  void _tool;
  void _userId;
  return null;
}));
const saveCreatorDraftMock = vi.hoisted(() => vi.fn(async (_tool: string, _userId: string, _draft: unknown): Promise<void> => {
  void _tool;
  void _userId;
  void _draft;
}));
const purgeLegacyPersistedMediaMock = vi.hoisted(() => vi.fn(async () => undefined));
const setPersistedFileMock = vi.hoisted(() => vi.fn(async (_key: string, _file: File): Promise<void> => {
  void _key;
  void _file;
}));
const getPersistedValueMock = vi.hoisted(() => vi.fn(async (_key: string): Promise<unknown> => {
  void _key;
  return null;
}));
const refreshTemporaryMediaUrlMock = vi.hoisted(() => vi.fn(async (storagePath: string) => `https://signed.example.com/refreshed/${storagePath}`));
// The page's duration reader, as the browser would answer it: a clip is 4.2 seconds long and a track 6.5.
const readDurationMock = vi.hoisted(() => vi.fn(async (source: File | string) => (
  typeof source !== 'string' && source.type.startsWith('audio/') ? 6.5 : 4.2
)));
// Whether a deploy newer than the page is known, and what the page asked the watcher.
const deployState = vi.hoisted(() => ({ newBuildAvailable: false, enabled: [] as boolean[] }));
const publishModalPropsMock = vi.hoisted(() => vi.fn((_props: {
  isOpen: boolean;
  defaultTitle?: string;
  paywallPrefill?: unknown;
}) => {
  void _props;
}));
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
  // Catalog entries a test adds to the hook's five, as the server publishes them.
  extraModels: [] as Array<Record<string, unknown>>,
  // The catalog's default video model, which a page with no draft opens on.
  videoDefault: 'kling-3.0-video',
  revision: 'test-catalog-rev',
  // The hook's own models whose details have not arrived.
  withoutModels: [] as string[],
  // Details ready only once every selected model's have arrived, as the real hook says.
  honestDetails: false,
  // The network has not yet confirmed the revision: the catalog is the browser's stored copy.
  checkingRevision: false,
}));
// What the result's player was last given; it still plays as it does on the page.
const resultVideoPropsMock = vi.hoisted(() => vi.fn());
const temporaryUploadMock = vi.hoisted(() => vi.fn());
// What each Enhance button on the page was last given: its prompt, and what the enhancer is told about the run.
const enhanceButtonPropsMock = vi.hoisted(() => vi.fn((_props: { prompt: string; context?: EnhancerContext }) => {
  void _props;
}));
const getPersistedImageElementRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string): Promise<PersistedImageElementRecord[]> => {
    void _key;
    return [];
  }
));
const setPersistedImageElementRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string, _elements: PersistedImageElementRecord[]): Promise<void> => {
    void _key;
    void _elements;
  }
));
const getPersistedMediaRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string): Promise<PersistedMediaRecord[]> => {
    void _key;
    return [];
  }
));
const setPersistedMediaRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string, _records: PersistedMediaRecord[]): Promise<void> => {
    void _key;
    void _records;
  }
));
const getPersistedFileMock = vi.hoisted(() => vi.fn(async (_key: string): Promise<File | null> => {
  void _key;
  return null;
}));
const getPersistedSubjectRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string): Promise<PersistedSubjectRecord[]> => {
    void _key;
    return [];
  }
));
const setPersistedSubjectRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string, _subjects: PersistedSubjectRecord[]): Promise<void> => {
    void _key;
    void _subjects;
  }
));
const uploadMock = vi.fn(async () => ({ error: null }));
const createSignedUrlMock = vi.fn(async () => ({
  data: { signedUrl: 'https://signed.example.com/uploads/user-1/kling-ref.mp4' },
  error: null,
}));
const maybeSingleMock = vi.fn(async () => ({ data: null, error: null }));

const queryBuilder = {
  select: vi.fn(() => queryBuilder),
  eq: vi.fn(() => queryBuilder),
  is: vi.fn(() => queryBuilder),
  in: vi.fn(() => queryBuilder),
  order: vi.fn(() => queryBuilder),
  limit: vi.fn(() => queryBuilder),
  maybeSingle: maybeSingleMock,
};

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

// The creators' price lists answer from the stand-in: nothing is priced unless a test says so.
vi.mock('@/lib/use-quote-prices', async () => {
  const { quotePricesHookStandIn } = await import('./fixtures/quote-prices-stand-in');
  return { useQuotePrices: quotePricesHookStandIn };
});

vi.mock('@/lib/persisted-creator-draft', () => ({
  loadCreatorDraft: loadCreatorDraftMock,
  saveCreatorDraft: saveCreatorDraftMock,
}));

vi.mock('@/lib/video-metadata-probe', () => ({
  readVideoDurationSeconds: readDurationMock,
}));

vi.mock('@/lib/use-deployment-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-deployment-refresh')>()),
  useDeploymentRefresh: (enabled: boolean) => {
    deployState.enabled.push(enabled);
    return { newBuildAvailable: deployState.newBuildAvailable };
  },
}));

// Signed in as user-1 with 10,000 credits, unless a test signs out to use the page as a
// visitor or sets a balance of its own.
const authState = vi.hoisted(() => ({ signedIn: true, credits: 10_000 }));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    credits: authState.signedIn ? authState.credits : null,
    isLoading: false,
    session: authState.signedIn
      ? {
        access_token: 'test-token',
        user: { id: 'user-1' },
      }
      : null,
    updateCredits: mockUpdateCredits,
  }),
}));

vi.mock('@/components/EnhancePromptButton', () => ({
  default: (props: { prompt: string; context?: EnhancerContext }) => {
    enhanceButtonPropsMock(props);
    return null;
  },
}));

vi.mock('@/components/GenerationResultVideo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/GenerationResultVideo')>();
  const { createElement } = await import('react');
  return {
    default: (props: Parameters<typeof actual.default>[0]) => {
      resultVideoPropsMock(props);
      return createElement(actual.default, props);
    },
  };
});

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublishToShowcaseModal', () => ({
  default: (props: { isOpen: boolean; defaultTitle?: string; paywallPrefill?: unknown }) => {
    publishModalPropsMock(props);
    return null;
  },
}));

vi.mock('@/lib/persisted-media', () => ({
  PERSISTED_MEDIA_KEYS: {
    createVideoStartImage: 'create-video:start-image',
    createVideoEndImage: 'create-video:end-image',
    createVideoElements: 'create-video:elements',
    createVideoReferenceVideos: 'create-video:reference-videos',
    createVideoReferenceAudios: 'create-video:reference-audios',
    createVideoKlingVideoElements: 'create-video:kling-video-elements',
    createVideoKlingSubjects: 'create-video:kling-subjects',
    createVideoSeedanceAssets: 'create-video:seedance-assets',
  },
  getPersistedFile: getPersistedFileMock,
  getPersistedImageElementRecords: getPersistedImageElementRecordsMock,
  getPersistedMediaRecords: getPersistedMediaRecordsMock,
  // Hydration loads every persisted slot in one Promise.all, so a missing mock
  // here rejects the whole load and silently disables ALL draft restoration.
  getPersistedSubjectRecords: getPersistedSubjectRecordsMock,
  getPersistedValue: getPersistedValueMock,
  // The keys of persisted-media.ts: every key is saved under its account.
  scopedPersistedMediaKey: (key: string, userId: string) => `${key}:${userId}`,
  purgeLegacyPersistedMedia: purgeLegacyPersistedMediaMock,
  removePersistedMedia: vi.fn(async () => undefined),
  setPersistedFile: setPersistedFileMock,
  setPersistedImageElementRecords: setPersistedImageElementRecordsMock,
  setPersistedMediaRecords: setPersistedMediaRecordsMock,
  setPersistedSubjectRecords: setPersistedSubjectRecordsMock,
  setPersistedValue: vi.fn(async () => undefined),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: 'test-token',
            user: { id: 'user-1' },
          },
        },
      })),
      getUser: vi.fn(async () => ({
        data: {
          user: { id: 'user-1' },
        },
      })),
    },
    from: vi.fn(() => queryBuilder),
    storage: {
      from: vi.fn(() => ({
        upload: uploadMock,
        createSignedUrl: createSignedUrlMock,
      })),
    },
  },
}));

vi.mock('@/lib/temporary-media-upload', async () => {
  const actual = await vi.importActual<typeof import('@/lib/temporary-media-upload')>('@/lib/temporary-media-upload');
  return {
    ...actual,
    uploadMediaToTemporaryStorage: temporaryUploadMock,
    refreshTemporaryMediaUrl: refreshTemporaryMediaUrlMock,
  };
});

vi.mock('@/lib/generation-model-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-model-client')>('@/lib/generation-model-client');
  const { quoteHookStandIn } = await import('./fixtures/web-quote-stand-in');
  return {
    ...actual,
    useWebGenerationModelCatalog: (options: { selectedIds?: string[] } = {}) => {
      const catalog = {
        revision: modelCatalogState.revision,
        schemaVersion: 1,
        defaults: { image: 'nano-banana-2', video: modelCatalogState.videoDefault, motion: 'kling-3.0' },
        models: [
          {
            id: 'kling-3.0-video',
            kind: 'video',
            displayName: 'Kling 3.0 Cinematic',
            description: 'Test video model',
            controls: [],
            capabilities: {},
            inputs: {},
          },
          {
            id: 'kling-o3',
            kind: 'video',
            displayName: 'Kling O3',
            description: 'Test omni video model',
            controls: [],
            capabilities: {},
            inputs: {},
          },
          {
            id: 'seedance-1.5-pro',
            kind: 'video',
            displayName: 'Seedance 1.5 Pro',
            description: 'Test element-capable video model',
            controls: [],
            capabilities: {},
            inputs: {},
          },
          {
            id: 'seedance-2-5',
            kind: 'video',
            displayName: 'Seedance 2.5',
            description: 'Test multimodal video model',
            controls: [],
            capabilities: {},
            inputs: {},
          },
          {
            id: 'wan-2.7',
            kind: 'video',
            displayName: 'Wan 2.7',
            description: 'Test frame-and-reference combining model',
            controls: [],
            capabilities: {},
            inputs: {},
          },
          ...modelCatalogState.extraModels,
        ].filter((model) => !modelCatalogState.withoutModels.includes(String(model.id))),
      };
      return {
        summaries: modelCatalogState.summaries, missingIds: modelCatalogState.missingIds, isLoadingModels: false,
        detailsReady: !modelCatalogState.honestDetails
          || (options.selectedIds ?? []).every((id) => catalog.models.some((model) => model.id === id)),
        catalog,
        error: modelCatalogState.error,
        isLoading: false,
        isCheckingRevision: modelCatalogState.checkingRevision,
        revision: modelCatalogState.revision,
        refetch: generationCatalogRefetchMock,
      };
    },
    // Unless a test says otherwise, 12 credits, ready, and the price of the very request the page asked.
    useWebGenerationModelQuote: quoteHookStandIn(actual.WebCatalogRequestError),
  };
});

const videoModelSummaries = [
  { id: 'kling-3.0-video', kind: 'video', displayName: 'Kling 3.0 Cinematic', description: 'Test video model' },
  { id: 'seedance-1.5-pro', kind: 'video', displayName: 'Seedance 1.5 Pro', description: 'Test element-capable video model' },
];

function chooseModel(container: HTMLElement, displayName: string) {
  const picker = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  expect(picker).not.toBeNull();
  fireEvent.click(picker!);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(displayName) }));
}

/** The "@" panel under a shot prompt, or null while it is shut. */
function shotMentionPanel(shot = 1) {
  // The panel stands right under the prompt box. While it is shut the duration
  // row is there instead, and that row has no line of text.
  const below = screen.getByPlaceholderText(`Describe shot ${shot}...`).nextElementSibling;
  return below?.querySelector('p') ? below : null;
}

/** What that panel says and offers: its title, its line of help, and each @handle to pick. */
function shotMentionPanelState(shot = 1) {
  const panel = shotMentionPanel(shot);
  if (!panel) {
    return null;
  }

  const [title, help] = Array.from(panel.querySelectorAll('p')).map((line) => line.textContent?.trim() ?? '');
  return {
    title,
    help,
    offers: Array.from(panel.querySelectorAll('button')).map((button) => (
      Array.from(button.querySelectorAll('span')).map((span) => span.textContent ?? '').find((text) => text.startsWith('@')) ?? ''
    )),
  };
}

/**
 * The run panel's line when Generate refuses a prompt for a mention, as one
 * sentence. A handle in it stands in a box of its own, so the sentence is the
 * text of the whole line and not of one node.
 */
async function unknownMentionLine() {
  return (await screen.findByText(/^Unknown element mention/)).textContent;
}

/** What the server answers a start it accepted. */
function startedRunBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    predictionId: 'pred-1',
    generationId: 'gen-run-1',
    status: 'processing',
    remainingCredits: 900,
    cost: 12,
    catalogRevision: 'test-catalog-rev',
    modelId: 'kling-3.0-video',
    ...overrides,
  };
}

/**
 * The page's own answers when a test says nothing else: a start is accepted and its
 * run has finished by the first status check.
 */
async function defaultResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (String(input).includes('/api/generations') && init?.method === 'POST') {
    return { ok: true, status: 200, json: async () => startedRunBody() } as Response;
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'succeeded',
      output: 'https://example.com/result.mp4',
      timing: null,
    }),
  } as Response;
}


/** Generate, found by the price its name keeps while its face says why it waits (the column's bar). */
/** The shot mode is a radio group, as the app's segmented control is. */
function chooseMultiShot() {
  fireEvent.click(screen.getByRole('radio', { name: 'Multi-shot' }));
}

describe('CreateVideoClient Kling video elements', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authState.signedIn = true;
    authState.credits = 10_000;
    priceListStandIn.reset();
    // A start kept from another test would be replayed when the page opens.
    window.sessionStorage.clear();
    deployState.newBuildAvailable = false;
    deployState.enabled = [];
    loadCreatorDraftMock.mockReset();
    loadCreatorDraftMock.mockResolvedValue(null);
    saveCreatorDraftMock.mockClear();
    purgeLegacyPersistedMediaMock.mockClear();
    setPersistedFileMock.mockClear();
    getPersistedValueMock.mockReset();
    getPersistedValueMock.mockResolvedValue(null);
    refreshTemporaryMediaUrlMock.mockReset();
    refreshTemporaryMediaUrlMock.mockImplementation(async (storagePath: string) => `https://signed.example.com/refreshed/${storagePath}`);
    readDurationMock.mockClear();
    publishModalPropsMock.mockClear();
    mockPush.mockClear();
    mockUpdateCredits.mockClear();
    generationCatalogRefetchMock.mockClear();
    quoteStandIn.reset(12);
    enhanceButtonPropsMock.mockClear();
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
    modelCatalogState.extraModels = [];
    modelCatalogState.videoDefault = 'kling-3.0-video';
    modelCatalogState.revision = 'test-catalog-rev';
    modelCatalogState.withoutModels = [];
    modelCatalogState.honestDetails = false;
    modelCatalogState.checkingRevision = false;
    resultVideoPropsMock.mockClear();
    temporaryUploadMock.mockReset();
    temporaryUploadMock.mockImplementation(async (file: File) => ({
      signedUrl: `https://signed.example.com/uploads/user-1/${file.name}`,
      storagePath: `uploads/user-1/${file.name}`,
    }));
    uploadMock.mockClear();
    createSignedUrlMock.mockClear();
    maybeSingleMock.mockClear();
    queryBuilder.is.mockClear();
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([]);
    getPersistedFileMock.mockReset();
    getPersistedFileMock.mockResolvedValue(null);
    setPersistedImageElementRecordsMock.mockClear();
    getPersistedMediaRecordsMock.mockReset();
    getPersistedMediaRecordsMock.mockResolvedValue([]);
    setPersistedMediaRecordsMock.mockClear();
    getPersistedSubjectRecordsMock.mockReset();
    getPersistedSubjectRecordsMock.mockResolvedValue([]);
    setPersistedSubjectRecordsMock.mockClear();

    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn((value: Blob) => {
      objectUrlSequence += 1;
      const label = value instanceof File ? value.name : 'media';
      return `blob:${label}:${objectUrlSequence}`;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

    fetchMock = vi.fn(defaultResponse);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** The run the page posted to start a generation, or undefined when it posted none. */
  function postedRun() {
    const call = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes('/api/generations') && init?.method === 'POST'
    ));
    return call ? JSON.parse(String(call[1]?.body)) : undefined;
  }

  /** Answers the page's remix request with this bundle, and every other request as the page's own answers do. */
  function stubRemix(bundle: RemixSourceBundle) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
      String(input).includes('/api/remix-source')
        ? { ok: true, status: 200, json: async () => bundle } as Response
        : defaultResponse(input, init)
    ));
  }

  /** What the Enhance button of one shot was last given. */
  function shotEnhanceButton(shotIndex: number) {
    return enhanceButtonPropsMock.mock.calls
      .map(([props]) => props)
      .filter((props) => props.context?.shotIndex === shotIndex)
      .at(-1);
  }

  it('excludes motion generations when resuming a pending video run', async () => {
    render(<CreateVideoClient prefill={{}} />);

    await waitFor(() => {
      expect(queryBuilder.is).toHaveBeenCalledWith('creation_mode', null);
    });
  });

  it('sends remixPost to the remix-source request so unlocked bundle media can restore', async () => {
    render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/api/remix-source'))
      ).toBe(true);
    });

    const remixCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/remix-source')
    );
    const url = new URL(String(remixCall![0]), 'https://magicbooklet.test');
    expect(url.searchParams.get('id')).toBe('gen-1');
    // Without postId the server cannot reach loadGenerationRecipeRemixInputMediaByPostId,
    // so a viewer who unlocked the bundle silently gets no restored media.
    expect(url.searchParams.get('postId')).toBe('post-1');
  });

  it('restores a remix reference clip and track with their lengths, so the quote can price them', async () => {
    // Seedance 2 prices a run by the length of its reference clip, and the quote refuses a
    // clip that arrives without one ("Reference videos requires duration metadata for every
    // asset"). The source generation keeps each length; the restore used to drop it.
    const bundle: RemixSourceBundle = {
      generation: { id: 'gen-1', title: 'Trending', prompt: 'Swap the dancer for the reference', category: 'video', model: 'seedance-2-5' },
      result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [],
          referenceVideos: [{
            kind: 'video',
            label: 'Video reference 1',
            storagePath: 'generation_inputs/owner-1/gen-1/00-reference_video.mp4',
            sourceGenerationId: 'gen-1',
            url: 'https://signed.example.com/generation_inputs/owner-1/gen-1/00-reference_video.mp4',
            durationSeconds: 12.16,
          }],
          referenceAudios: [{
            kind: 'audio',
            label: 'Audio reference 1',
            storagePath: 'generation_inputs/owner-1/gen-1/01-reference_audio.mp3',
            sourceGenerationId: 'gen-1',
            url: 'https://signed.example.com/generation_inputs/owner-1/gen-1/01-reference_audio.mp3',
            durationSeconds: 7.5,
          }],
        },
      },
      workflowSettings: { model: 'seedance-2-5' },
      restoreIssues: [],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => (String(input).includes('/api/remix-source')
        ? bundle
        : { status: 'succeeded', output: 'https://example.com/result.mp4', timing: null }),
    } as Response));

    render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);

    await waitFor(() => {
      const request = quoteStandIn.lastRequest();
      expect(request?.modelId).toBe('seedance-2-5');
      expect(request?.inputMetadata?.slots?.videoReferences).toEqual({ count: 1, durationsSeconds: [12.16] });
      expect(request?.inputMetadata?.slots?.audioReferences).toEqual({ count: 1, durationsSeconds: [7.5] });
      expect(request?.inputMetadata?.referenceVideoDurationsSeconds).toEqual([12.16]);
    });
  });

  it('keeps active video element URLs alive when a frame changes', async () => {
    const view = render(<CreateVideoClient prefill={{}} />);
    const videoFile = new File(['video-bytes'], 'active-reference.mp4', { type: 'video/mp4' });
    const videoInput = view.container.querySelector(
      'input[accept="video/mp4,video/quicktime,.mp4,.mov"]'
    ) as HTMLInputElement | null;

    expect(videoInput).not.toBeNull();
    fireEvent.change(videoInput!, { target: { files: [videoFile] } });
    await waitFor(() => {
      expect(screen.getAllByText('@video_element_1').length).toBeGreaterThan(0);
    });
    const activeReferenceUrl = vi.mocked(URL.createObjectURL).mock.results[0]?.value;
    expect(activeReferenceUrl).toBe('blob:active-reference.mp4:1');

    const frameInputs = view.container.querySelectorAll<HTMLInputElement>('input[accept="image/*"]');
    expect(frameInputs.length).toBeGreaterThan(0);
    const startFrame = new File(['image-bytes'], 'start-frame.png', { type: 'image/png' });
    fireEvent.change(frameInputs[0], { target: { files: [startFrame] } });

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledWith(startFrame);
    });
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(activeReferenceUrl);

    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(activeReferenceUrl);
  });

  it('persists image elements on upload and removal without prompt-rerender rewrites', async () => {
    const view = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);

    const file = new File(['image-bytes'], 'video-element.png', { type: 'image/png' });
    const input = await waitFor(() => {
      const found = view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"][multiple]');
      expect(found).not.toBeNull();
      return found;
    });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(1);
    });
    expect(setPersistedImageElementRecordsMock.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ displayName: 'Element 1', file }),
    ]);

    fireEvent.change(screen.getByPlaceholderText(/describe the seedance 1\.5 pro scene/i), {
      target: { value: 'A product rotates in a bright studio' },
    });
    expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(1);

    await screen.findByAltText('Element 1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Element 1' }));

    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(2);
    });
    expect(setPersistedImageElementRecordsMock.mock.calls[1]?.[1]).toEqual([]);
  });

  it('preserves saved video references and explains a decreased model capacity', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(
      Array.from({ length: 3 }, (_, index) => ({
        id: `saved-element-${index + 1}`,
        displayName: `Saved element ${index + 1}`,
        file: new File([`image-${index + 1}`], `saved-element-${index + 1}.png`, { type: 'image/png' }),
      }))
    );

    render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);

    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();
    expect(screen.getByAltText('Saved element 3')).toBeInTheDocument();
    expect(setPersistedImageElementRecordsMock).not.toHaveBeenCalled();
  });

  it('clears the capacity explanation once the extra reference is removed', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(
      Array.from({ length: 3 }, (_, index) => ({
        id: `saved-element-${index + 1}`,
        displayName: `Saved element ${index + 1}`,
        file: new File([`image-${index + 1}`], `saved-element-${index + 1}.png`, { type: 'image/png' }),
      }))
    );

    render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();

    expect(screen.getByAltText('Saved element 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Saved element 3' }));

    await waitFor(() => {
      expect(screen.queryByAltText('Saved element 3')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText(/Your references are preserved/)).not.toBeInTheDocument();
    });
  });

  it('titles a model notice as model settings, not as a remix', async () => {
    modelCatalogState.missingIds = ['kling-3.0-video'];

    render(<CreateVideoClient prefill={{}} />);

    expect(await screen.findByText(/This model is no longer available/)).toBeInTheDocument();
    expect(screen.queryByText('Remixing Community Creation')).not.toBeInTheDocument();
    expect(screen.getByText('Model settings')).toBeInTheDocument();
  });

  it('clears the missing-model notice once another model is chosen', async () => {
    modelCatalogState.missingIds = ['kling-3.0-video'];
    modelCatalogState.summaries = videoModelSummaries;
    const view = render(<CreateVideoClient prefill={{}} />);
    expect(await screen.findByText(/This model is no longer available/)).toBeInTheDocument();

    chooseModel(view.container, 'Seedance 1.5 Pro');

    await waitFor(() => {
      expect(screen.queryByText(/This model is no longer available/)).not.toBeInTheDocument();
    });
  });

  it('clears the load-error notice once the model list loads again', async () => {
    modelCatalogState.error = new Error('Could not load models.');
    const view = render(<CreateVideoClient prefill={{}} />);
    expect(await screen.findByText('Could not load models.')).toBeInTheDocument();

    modelCatalogState.error = null;
    view.rerender(<CreateVideoClient prefill={{}} />);

    await waitFor(() => {
      expect(screen.queryByText('Could not load models.')).not.toBeInTheDocument();
    });
  });

  it('lets the creator dismiss a settings-reset notice', async () => {
    // Veo 3.1 has no "std" mode, so opening it resets Kling's default.
    render(<CreateVideoClient prefill={{ model: 'veo-3.1' }} />);
    expect(await screen.findByText(/Unsupported choices were reset/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss model notice' }));

    await waitFor(() => {
      expect(screen.queryByText(/Unsupported choices were reset/)).not.toBeInTheDocument();
    });
  });

  it('clears a settings-reset notice when the creator picks another model', async () => {
    modelCatalogState.summaries = videoModelSummaries;
    const view = render(<CreateVideoClient prefill={{ model: 'veo-3.1' }} />);
    expect(await screen.findByText(/Unsupported choices were reset/)).toBeInTheDocument();

    chooseModel(view.container, 'Seedance 1.5 Pro');

    await waitFor(() => {
      expect(screen.queryByText(/Unsupported choices were reset/)).not.toBeInTheDocument();
    });
  });

  it('keeps the Kling video elements panel visible in single-shot and multi-shot modes', async () => {
    render(<CreateVideoClient prefill={{}} />);

    expect(await screen.findByText('Kling video elements')).toBeInTheDocument();

    chooseMultiShot();

    expect(screen.getByText('Kling video elements')).toBeInTheDocument();
  });

  it('restores persisted named subjects on load', async () => {
    getPersistedSubjectRecordsMock.mockResolvedValueOnce([{
      id: 'subject-1',
      displayName: 'Hero creator',
      images: [
        { id: 'image-1', file: new File(['front'], 'front.png', { type: 'image/png' }) },
        { id: 'image-2', file: new File(['side'], 'side.png', { type: 'image/png' }) },
      ],
    }]);

    render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);

    expect(await screen.findByDisplayValue('Hero creator')).toBeInTheDocument();
    expect(screen.getByText('2/4 images')).toBeInTheDocument();
    // This subject was saved before handles were kept, so its handle is built from its name.
    expect(screen.getAllByText('@hero_creator').length).toBeGreaterThan(0);
    // Loading writes nothing back: the record gets its handle when the creator next changes a subject.
    expect(setPersistedSubjectRecordsMock).not.toHaveBeenCalled();
  });

  it('shows the named-subjects editor only for Kling O3 and enforces the image range', async () => {
    render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);

    expect(await screen.findByText('Named subjects')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add subject'));
    expect(screen.getByPlaceholderText('Subject name')).toHaveValue('Subject 1');
    // One subject with zero images is below the 2-image floor.
    expect(screen.getByText(/add at least 2/i)).toBeInTheDocument();
    // The handle chip is derived from the display name for @mentions.
    expect(screen.getAllByText('@subject_1').length).toBeGreaterThan(0);
  });

  it('offers Seedance 2.5 reference video and audio slots with nothing attached', async () => {
    // The reported bug: the model publishes video and audio reference slots that the page
    // never rendered, because reaching them needed a mode picker that was itself hidden
    // until you were already in that mode. Every slot is on screen from a fresh session now.
    render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);

    expect(await screen.findByText('Video and audio references')).toBeInTheDocument();
    expect(screen.getByText('Reference videos')).toBeInTheDocument();
    // The heading and the @-mention row both carry this label.
    expect(screen.getAllByText('Reusable image references').length).toBeGreaterThan(0);
    // Frames stay on screen alongside them.
    expect(screen.getAllByText(/Start Frame/i).length).toBeGreaterThan(0);
    // And the run is frame-shaped until a reference is attached.
    expect(screen.getByText(/takes either frames or references/i)).toBeInTheDocument();
  });

  it('locks the reference group once a Seedance 2.5 frame is attached, and releases it', async () => {
    // Kie documents first/last frame and multimodal references as mutually exclusive
    // scenarios for seedance-2-5, so attaching one greys the other rather than hiding it.
    const view = render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);

    const referenceGroup = await waitFor(() => {
      const found = view.container.querySelector('[aria-disabled]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(referenceGroup.getAttribute('aria-disabled')).toBe('false');

    const startInput = view.container.querySelector<HTMLInputElement>('#video-start-frame-input');
    expect(startInput).not.toBeNull();
    fireEvent.change(startInput!, {
      target: { files: [new File(['frame-bytes'], 'start.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      const locked = Array.from(view.container.querySelectorAll('[aria-disabled="true"]'));
      expect(locked.length).toBeGreaterThan(0);
    });
    // The slots are still on screen — greyed, not removed.
    expect(screen.getByText('Reference videos')).toBeInTheDocument();
    expect(screen.getByText(/cannot combine references with frames/i)).toBeInTheDocument();
  });

  it('never locks both groups at once, even when a draft restores a frame and a reference', async () => {
    // Before this layout, a draft could legitimately hold both: the old surface kept the
    // frames while you worked in references ("your start and end frames are still saved").
    // Those drafts still restore, and locking each group against the other would leave a
    // panel where nothing can be removed and so nothing can be un-locked.
    const startFrame = new File(['frame-bytes'], 'start.png', { type: 'image/png' });
    getPersistedFileMock.mockImplementation(async (key: string) => (
      key === 'create-video:start-image:user-1' ? startFrame : null
    ));
    getPersistedImageElementRecordsMock.mockResolvedValue([
      { id: 'element-1', displayName: 'Hero', handle: '@Hero', file: new File(['ref'], 'hero.png', { type: 'image/png' }), source: 'upload' },
    ] as never);

    const view = render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);
    await screen.findByRole('heading', { name: 'Reference videos' });

    await waitFor(() => {
      expect(getPersistedImageElementRecordsMock).toHaveBeenCalled();
    });

    // At least one group has to stay interactive, or the run can never be resolved.
    await waitFor(() => {
      const groups = Array.from(view.container.querySelectorAll('[aria-disabled]'));
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.every((group) => group.getAttribute('aria-disabled') === 'true')).toBe(false);
    });
  });

  it('keeps both input groups live for Wan 2.7, which combines them', async () => {
    // wan/2-7-r2v takes `first_frame` alongside `reference_image` and `reference_video`,
    // so Wan must never show the either/or copy the exclusive models get.
    render(<CreateVideoClient prefill={{ model: 'wan-2.7' }} />);

    expect((await screen.findAllByText('Reusable image references')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/takes either frames or references/i)).toBeNull();
  });

  /**
   * The clip and track panel is drawn for the models that take a reference clip or
   * a track, and the run sends what the panel holds. The page kept its own list of
   * those models, and MiniMax H3 was not on it (2026-10-04): the model takes three
   * clips and three tracks, its catalog entry says so and the server sends them,
   * and a creator had no place to attach one. A clip saved on another model was
   * counted by the quote and left out of the run.
   *
   * This file's catalog hook hands the page no descriptor, so the page reads its
   * built-in table here, as it does before the catalog has loaded.
   */
  describe('reference clips and tracks', () => {
    const clipInput = 'input[type="file"][accept="video/*"]';
    const trackInput = 'input[type="file"][accept="audio/*"]';
    const runPrompt = 'A dancer crosses a bright studio in the rhythm of the reference clip, slow push in.';

    /** The panel's heading, or null where the page draws no clip and track panel. */
    function panelHeading() {
      return screen.queryByRole('heading', { name: /^Video( and audio)? references$/ });
    }

    /** What the run sent of one kind: its clips, or its tracks. */
    function postedInputs(slot: 'videoReferences' | 'audioReferences') {
      return (postedRun()?.inputs ?? []).filter((input: { slot: string }) => input.slot === slot);
    }

    async function generate(modelName: string) {
      fireEvent.change(screen.getByPlaceholderText(`Describe the ${modelName} scene in rich cinematic detail...`), {
        target: { value: runPrompt },
      });
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedRun()).toBeDefined());
    }

    it('gives MiniMax H3 the panel, with a button for a clip and a button for a track', async () => {
      render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);

      expect(await screen.findByRole('heading', { name: 'Video and audio references' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add video' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Add audio' })).toBeEnabled();
      // Three of each, which is what the model takes.
      expect(screen.getByText('Add up to 3 short clips as motion and framing guidance.')).toBeInTheDocument();
      expect(screen.getByText('Add up to 3 audio clips for beat, voice, or dialogue timing guidance.')).toBeInTheDocument();
    });

    it('sends the clip and the track attached on MiniMax H3, and tells the quote about both', async () => {
      const view = render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);
      await screen.findByRole('heading', { name: 'Video and audio references' });
      const clip = new File(['video-bytes'], 'walk.mp4', { type: 'video/mp4' });
      const track = new File(['audio-bytes'], 'voice.mp3', { type: 'audio/mpeg' });

      fireEvent.change(view.container.querySelector<HTMLInputElement>(clipInput)!, { target: { files: [clip] } });
      expect(await screen.findByText('Video reference 1')).toBeInTheDocument();
      expect(screen.getByText('4.2s clip')).toBeInTheDocument();
      fireEvent.change(view.container.querySelector<HTMLInputElement>(trackInput)!, { target: { files: [track] } });
      expect(await screen.findByText('Audio reference 1')).toBeInTheDocument();
      // A track's card says how long it is. Only the Seedance 2 family prepares assets.
      expect(screen.getByText('6.5s track')).toBeInTheDocument();
      expect(screen.queryByText('Uses URL fallback until prepared')).toBeNull();

      // The quote prices a MiniMax H3 run by the seconds of its clips, so it is told each length.
      await waitFor(() => {
        const request = quoteStandIn.lastRequest();
        expect(request?.modelId).toBe('minimax-h3');
        expect(request?.settings?.referenceMode).toBe('elements');
        expect(request?.inputCounts).toMatchObject({ videos: 1, audios: 1 });
        expect(request?.inputMetadata?.slots?.videoReferences).toEqual({ count: 1, durationsSeconds: [4.2] });
        expect(request?.inputMetadata?.slots?.audioReferences).toEqual({ count: 1, durationsSeconds: [6.5] });
      });

      await generate('MiniMax H3');

      expect(temporaryUploadMock).toHaveBeenCalledWith(clip);
      expect(temporaryUploadMock).toHaveBeenCalledWith(track);
      expect(postedRun().modelId).toBe('minimax-h3');
      expect(postedRun().settings.referenceMode).toBe('elements');
      expect(postedInputs('videoReferences')).toEqual([expect.objectContaining({
        kind: 'video',
        url: 'https://signed.example.com/uploads/user-1/walk.mp4',
        label: 'Video reference 1',
        durationSeconds: 4.2,
      })]);
      expect(postedInputs('audioReferences')).toEqual([expect.objectContaining({
        kind: 'audio',
        url: 'https://signed.example.com/uploads/user-1/voice.mp3',
        label: 'Audio reference 1',
      })]);
    });

    it('shows MiniMax H3 a clip saved on another model, and sends it', async () => {
      // A saved clip stays with the draft when the model changes. The quote counted it
      // on MiniMax H3 while the page had no card to show it or take it off.
      const savedClip = new File(['video-bytes'], 'camera-move.mp4', { type: 'video/mp4' });
      getPersistedMediaRecordsMock.mockImplementation(async (key: string) => (
        key === 'create-video:reference-videos:user-1'
          ? [{ id: 'saved-clip', displayName: 'Camera move', durationSeconds: 5, file: savedClip }]
          : []
      ));
      render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);

      expect(await screen.findByText('Camera move')).toBeInTheDocument();
      expect(screen.getByText('5.0s clip')).toBeInTheDocument();
      await waitFor(() => {
        expect(quoteStandIn.lastRequest()?.inputMetadata?.slots?.videoReferences)
          .toEqual({ count: 1, durationsSeconds: [5] });
      });

      await generate('MiniMax H3');

      expect(postedInputs('videoReferences')).toEqual([expect.objectContaining({
        url: 'https://signed.example.com/uploads/user-1/camera-move.mp4',
        label: 'Camera move',
        durationSeconds: 5,
      })]);
    });

    it('keeps the note about prepared assets on a Seedance 2.5 track', async () => {
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);
      await screen.findByRole('heading', { name: 'Video and audio references' });

      fireEvent.change(view.container.querySelector<HTMLInputElement>(trackInput)!, {
        target: { files: [new File(['audio-bytes'], 'voice.mp3', { type: 'audio/mpeg' })] },
      });

      expect(await screen.findByText('Uses URL fallback until prepared')).toBeInTheDocument();
      expect(screen.queryByText('6.5s track')).toBeNull();
    });

    /**
     * What each model's catalog entry takes, read from the slots the server
     * publishes. Kling 3.0's clips are named video elements, a slot of their own
     * with a panel of their own, so they are not counted here.
     */
    const publishedCatalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
    function publishedLimit(modelId: string, slotKey: 'videoReferences' | 'audioReferences') {
      const entry = publishedCatalog.models.find((model) => model.id === modelId);
      return (entry?.inputModes ?? [])
        .flatMap((mode) => mode.slots)
        .find((slot) => slot.key === slotKey)?.max ?? 0;
    }

    it.each(Object.values(VIDEO_MODELS).map((model) => [model.displayName, model.id] as const))(
      '%s: has a place for a clip and for a track exactly where its catalog entry takes one',
      async (displayName, modelId) => {
        const takesClips = publishedLimit(modelId, 'videoReferences') > 0;
        const takesTracks = publishedLimit(modelId, 'audioReferences') > 0;
        const view = render(<CreateVideoClient prefill={{ model: modelId }} />);
        await screen.findByPlaceholderText(`Describe the ${displayName} scene in rich cinematic detail...`);

        expect(panelHeading()?.textContent ?? null).toBe(
          takesTracks ? 'Video and audio references' : takesClips ? 'Video references' : null
        );
        expect(Boolean(screen.queryByRole('button', { name: 'Add video' }))).toBe(takesClips);
        expect(Boolean(view.container.querySelector(clipInput))).toBe(takesClips);
        expect(Boolean(screen.queryByRole('button', { name: 'Add audio' }))).toBe(takesTracks);
        expect(Boolean(view.container.querySelector(trackInput))).toBe(takesTracks);
      }
    );

    it('checks that table against models of every kind', () => {
      // A table that held no model with a clip, or none without, would prove nothing.
      const ids = Object.keys(VIDEO_MODELS);
      expect(ids.filter((id) => publishedLimit(id, 'audioReferences') > 0)).toContain('minimax-h3');
      expect(ids.filter((id) => publishedLimit(id, 'videoReferences') > 0 && publishedLimit(id, 'audioReferences') === 0))
        .toEqual(['gemini-omni-video', 'gemini-omni-1.1-flash']);
      expect(ids.filter((id) => publishedLimit(id, 'videoReferences') === 0)).toEqual(expect.arrayContaining([
        'kling-3.0-video',
        'kling-o3',
        'seedance-1.5-pro',
      ]));
    });
  });

  it('submits uploaded Kling video elements with handles', async () => {
    const view = render(<CreateVideoClient prefill={{}} />);
    const file = new File(['video-bytes'], 'motion-ref.mp4', { type: 'video/mp4' });
    const input = view.container.querySelector('input[accept="video/mp4,video/quicktime,.mp4,.mov"]') as HTMLInputElement | null;

    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getAllByText('@video_element_1').length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getByPlaceholderText(/describe the kling 3\.0 cinematic scene/i), {
      target: {
        value: 'A dancer follows @video_element_1 with the same timing in a bright studio, cinematic smooth camera movement.',
      },
    });
    fireEvent.click(generateButton());

    // The session is read before anything is uploaded, so a lapsed one uploads nothing.
    await waitFor(() => expect(temporaryUploadMock).toHaveBeenCalledWith(file));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/generations',
        expect.objectContaining({ method: 'POST' })
      );
    });

    const postCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).includes('/api/generations') && init?.method === 'POST'
    ));
    const body = JSON.parse(String(postCall?.[1]?.body));
    const videoElements = body.inputs.filter((input: { slot: string }) => input.slot === 'videoElements');
    expect(videoElements).toHaveLength(1);
    expect(videoElements[0]).toMatchObject({
      handle: '@video_element_1',
      label: 'Video element 1',
    });
    expect(videoElements[0].url).toMatch(/^uploads\/user-1\/.+\.mp4$/);
    expect(videoElements[0].storagePath).toBe(videoElements[0].url);
  });

  /**
   * An element's @handle follows its name, on both of this page's reference cards.
   * A renamed Kling clip kept its old handle (2026-10-02), so the prompt and the
   * shots went on naming "@video_element_1" until the next page load gave the clip
   * the handle of its new name. A renamed image reference did take its new handle,
   * but that card built every handle from the names each time, which moved the
   * handle of a second reference with the same name and dropped a remix's.
   */
  describe('reference handles', () => {
    const KLING_RENAME = 'Rename video element';
    const IMAGE_RENAME = 'Rename element';
    const klingVideoInput = 'input[accept="video/mp4,video/quicktime,.mp4,.mov"]';
    const imageElementInput = 'input[type="file"][accept="image/*"][multiple]';

    function renameCard(container: HTMLElement, placeholder: string, index: number, nextName: string) {
      const field = container.querySelectorAll<HTMLInputElement>(`input[placeholder="${placeholder}"]`)[index];
      fireEvent.change(field, { target: { value: nextName } });
      fireEvent.keyDown(field, { key: 'Enter' });
    }

    /**
     * Types a name into a card's field and presses Escape, as a creator who thinks
     * better of a rename does. The field holds the focus, as it does on the page:
     * Escape leaves the field, and jsdom tells only the focused element that it
     * was left.
     */
    async function typeNameThenEscape(container: HTMLElement, placeholder: string, index: number, typedName: string) {
      const field = container.querySelectorAll<HTMLInputElement>(`input[placeholder="${placeholder}"]`)[index];
      act(() => field.focus());
      fireEvent.change(field, { target: { value: typedName } });
      expect(field).toHaveFocus();
      expect(field).toHaveValue(typedName);

      fireEvent.keyDown(field, { key: 'Escape' });
      // A rename saves the card and then rewrites the prompt. Give one the time to do both.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return field;
    }

    /** The @handle each card of one kind shows, in card order. */
    function cardHandles(container: HTMLElement, placeholder: string) {
      return Array.from(container.querySelectorAll<HTMLInputElement>(`input[placeholder="${placeholder}"]`)).map((field) => {
        // The card body is the name field's nearest ancestor that holds the Insert button.
        let card = field.parentElement;
        while (card && !Array.from(card.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Insert')) {
          card = card.parentElement;
        }
        return Array.from(card?.querySelectorAll('span') ?? [])
          .find((span) => /^@\w+$/.test(span.textContent ?? ''))?.textContent ?? null;
      });
    }

    function promptBox() {
      return screen.getByPlaceholderText(/^Describe the .+ scene in rich cinematic detail/);
    }

    function addKlingClip(container: HTMLElement, name: string) {
      const input = container.querySelector<HTMLInputElement>(klingVideoInput);
      expect(input).not.toBeNull();
      fireEvent.change(input!, { target: { files: [new File(['video-bytes'], name, { type: 'video/mp4' })] } });
    }

    it('gives a renamed Kling clip the handle of its new name, and the prompt follows', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      fireEvent.change(promptBox(), { target: { value: 'A dancer follows @video_element_1, then @video_element_1 again.' } });

      renameCard(view.container, KLING_RENAME, 0, 'Red jacket');

      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@red_jacket']));
      expect(promptBox()).toHaveValue('A dancer follows @red_jacket, then @red_jacket again.');
      // Nothing on the page still offers the old handle, and the prompt has no stale mention.
      expect(screen.queryByText('@video_element_1')).not.toBeInTheDocument();
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('rewrites the mention in every shot prompt when a Kling clip is renamed', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      chooseMultiShot();
      fireEvent.change(await screen.findByPlaceholderText('Describe shot 1...'), {
        target: { value: 'Open on @video_element_1 in the rain' },
      });

      renameCard(view.container, KLING_RENAME, 0, 'Red jacket');

      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@red_jacket']));
      expect(screen.getByPlaceholderText('Describe shot 1...')).toHaveValue('Open on @red_jacket in the rain');
    });

    // What a Kling 3.0 shot prompt does with its clips' handles: it offers them at "@",
    // reads the shots for them before a run, and tells Enhance about them. A Kling O3
    // shot prompt does the same with its subjects (see "Kling O3 subject handles").
    it('offers a Kling clip under a shot prompt at "@", and inserts the handle picked', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      chooseMultiShot();
      const shot = await screen.findByPlaceholderText('Describe shot 1...');
      expect(shotMentionPanelState()).toBeNull();

      // The clip is called "Video element 1", so this is how a creator starts to look for it.
      fireEvent.change(shot, { target: { value: 'Open on @V' } });

      expect(shotMentionPanelState()).toEqual({
        title: 'Insert video element',
        help: 'Pick a Kling video handle for this shot.',
        offers: ['@video_element_1'],
      });

      fireEvent.click(shotMentionPanel()!.querySelector('button')!);

      expect(shot).toHaveValue('Open on @video_element_1');
      expect(shotMentionPanelState()).toBeNull();
    });

    it('counts each mention of a Kling clip in a shot as the 37 characters Kie counts', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));
      chooseMultiShot();
      const shot = await screen.findByPlaceholderText('Describe shot 1...');
      const generate = () => generateButton();

      // 479 characters as typed; 500 as Kie counts the 16-character handle's one mention.
      const atLimit = `${'a'.repeat(500 - 37 - 1)} @video_element_1`;
      fireEvent.change(shot, { target: { value: atLimit } });
      expect(screen.getByText('500 / 500')).toHaveAttribute('data-state', 'near');
      expect(generate()).toBeEnabled();

      fireEvent.change(shot, { target: { value: `a${atLimit}` } });
      expect(screen.getByText('501 / 500')).toHaveAttribute('data-state', 'over');
      expect(screen.getByText('Shot 1: Kling 3.0 Cinematic shot prompts support up to 500 characters, counting each video element mention as 37.')).toBeInTheDocument();
      expect(generate()).toBeDisabled();
    });

    it('stops a multi-shot run at a mention no Kling clip has, before the clip is uploaded', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      chooseMultiShot();
      // One letter short.
      fireEvent.change(await screen.findByPlaceholderText('Describe shot 1...'), {
        target: { value: 'Open on @video_elemnt_1 in the rain, slow push in.' },
      });
      fireEvent.click(generateButton());

      expect(await unknownMentionLine()).toBe('Unknown element mention: @video_elemnt_1');
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(postedRun()).toBeUndefined();
    });

    it('sends a multi-shot run whose shot mentions its Kling clip', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      chooseMultiShot();
      fireEvent.change(await screen.findByPlaceholderText('Describe shot 1...'), {
        target: { value: 'Open on @video_element_1 in the rain, slow push in.' },
      });
      fireEvent.click(generateButton());

      await waitFor(() => expect(postedRun()).toBeDefined());
      const run = postedRun();
      expect(run.settings).toMatchObject({ isMultiShot: true });
      expect(run.shots).toEqual([{ prompt: 'Open on @video_element_1 in the rain, slow push in.', duration: 5 }]);
      expect(
        run.inputs
          .filter((input: { slot: string }) => input.slot === 'videoElements')
          .map((input: { handle: string }) => input.handle)
      ).toEqual(['@video_element_1']);
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it("tells a shot's Enhance button about the Kling clips", async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      chooseMultiShot();
      await screen.findByPlaceholderText('Describe shot 1...');

      expect(shotEnhanceButton(0)?.context?.elementReferences).toEqual([
        { handle: '@video_element_1', displayName: 'Video element 1' },
      ]);
    });

    it('accepts the new handle typed by hand straight after a Kling clip is renamed', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toHaveLength(1));

      renameCard(view.container, KLING_RENAME, 0, 'Red jacket');
      await waitFor(() => expect(screen.getByDisplayValue('Red jacket')).toBeInTheDocument());
      fireEvent.change(promptBox(), { target: { value: 'A dancer follows @red_jacket across the stage' } });

      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@red_jacket']);
    });

    // Escape in a name field renamed the card to what had been typed (2026-10-03).
    it('puts the old name back when Escape is pressed in a Kling clip name field', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));
      fireEvent.change(promptBox(), { target: { value: 'A dancer follows @video_element_1 across the stage' } });

      const field = await typeNameThenEscape(view.container, KLING_RENAME, 0, 'Red jacket');

      // Escape left the field, and nothing took the name that was typed.
      expect(field).not.toHaveFocus();
      expect(field).toHaveValue('Video element 1');
      expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']);
      expect(promptBox()).toHaveValue('A dancer follows @video_element_1 across the stage');
      const savedNames = setPersistedMediaRecordsMock.mock.calls
        .filter(([key]) => key === 'create-video:kling-video-elements:user-1')
        .flatMap(([, records]) => records.map((record) => record.displayName));
      expect(savedNames).not.toContain('Red jacket');
    });

    it('shows the same Kling clip handles after a reload as before it', async () => {
      const first = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(first.container, 'first.mp4');
      await waitFor(() => expect(cardHandles(first.container, KLING_RENAME)).toHaveLength(1));
      addKlingClip(first.container, 'second.mp4');
      await waitFor(() => expect(cardHandles(first.container, KLING_RENAME)).toEqual(['@video_element_1', '@video_element_2']));

      // Two clips with one name: the second takes a numbered handle.
      renameCard(first.container, KLING_RENAME, 0, 'Dancer');
      await waitFor(() => expect(cardHandles(first.container, KLING_RENAME)).toEqual(['@dancer', '@video_element_2']));
      renameCard(first.container, KLING_RENAME, 1, 'Dancer');
      await waitFor(() => expect(cardHandles(first.container, KLING_RENAME)).toEqual(['@dancer', '@dancer_2']));
      // Renaming the first frees "@dancer". The second keeps the handle the prompt uses for it.
      renameCard(first.container, KLING_RENAME, 0, 'Red jacket');
      await waitFor(() => expect(cardHandles(first.container, KLING_RENAME)).toEqual(['@red_jacket', '@dancer_2']));

      // The reload: the page goes away, and the next one starts from what was saved.
      const saved = setPersistedMediaRecordsMock.mock.calls
        .filter(([key]) => key === 'create-video:kling-video-elements:user-1')
        .at(-1)?.[1] ?? [];
      expect(saved).toHaveLength(2);
      first.unmount();
      getPersistedMediaRecordsMock.mockImplementation(async (key: string) => (
        key === 'create-video:kling-video-elements:user-1' ? saved : []
      ));

      const second = render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(cardHandles(second.container, KLING_RENAME)).toEqual(['@red_jacket', '@dancer_2']));
    });

    it('keeps a restored Kling clip handle until its own clip is renamed', async () => {
      // The handles the original prompt was written with. Neither is the handle its
      // clip's name would give ("@opening_shot", "@closing_shot").
      stubRemix({
        generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead crosses to @rival at dusk', category: 'video', model: 'kling-3.0-video' },
        result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
        inputs: {
          video: {
            referenceMode: 'elements',
            startFrame: null,
            endFrame: null,
            elements: [],
            referenceVideos: ['00', '01'].map((index) => ({
              kind: 'video' as const,
              storagePath: `generation_inputs/owner-1/gen-1/${index}-kling_video_element.mp4`,
              sourceGenerationId: 'gen-1',
              url: `https://signed.example.com/generation_inputs/owner-1/gen-1/${index}-kling_video_element.mp4`,
            })),
            referenceAudios: [],
          },
        },
        workflowSettings: {
          model: 'kling-3.0-video',
          klingVideoElements: [
            { id: 'remix-1', displayName: 'Opening shot', handle: '@lead' },
            { id: 'remix-2', displayName: 'Closing shot', handle: '@rival' },
          ],
        },
        restoreIssues: [],
      });

      const view = render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@lead', '@rival']));
      expect(promptBox()).toHaveValue('@lead crosses to @rival at dusk');

      // Renaming the other clip, and adding one, leave "@lead" alone.
      renameCard(view.container, KLING_RENAME, 1, 'Villain');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@lead', '@villain']));
      addKlingClip(view.container, 'third.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@lead', '@villain', '@video_element_3']));
      expect(promptBox()).toHaveValue('@lead crosses to @villain at dusk');

      renameCard(view.container, KLING_RENAME, 0, 'Captain');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@captain', '@villain', '@video_element_3']));
      expect(promptBox()).toHaveValue('@captain crosses to @villain at dusk');
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('gives a renamed image reference the handle of its new name, and the prompt follows', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'saved-1', displayName: 'Saved product', file: new File(['image'], 'saved.png', { type: 'image/png' }) },
      ]);
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@saved_product']));

      fireEvent.change(promptBox(), { target: { value: 'A slow orbit around @saved_product on a plinth' } });

      renameCard(view.container, IMAGE_RENAME, 0, 'Red jacket');

      await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@red_jacket']));
      expect(promptBox()).toHaveValue('A slow orbit around @red_jacket on a plinth');
      expect(screen.queryByText('@saved_product')).not.toBeInTheDocument();
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('puts the old name back when Escape is pressed in an image reference name field', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'saved-1', displayName: 'Saved product', file: new File(['image'], 'saved.png', { type: 'image/png' }) },
      ]);
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@saved_product']));
      fireEvent.change(promptBox(), { target: { value: 'A slow orbit around @saved_product on a plinth' } });

      const field = await typeNameThenEscape(view.container, IMAGE_RENAME, 0, 'Dancer');

      // Escape left the field, and nothing took the name that was typed.
      expect(field).not.toHaveFocus();
      expect(field).toHaveValue('Saved product');
      expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@saved_product']);
      expect(promptBox()).toHaveValue('A slow orbit around @saved_product on a plinth');
      const savedNames = setPersistedImageElementRecordsMock.mock.calls
        .flatMap(([, records]) => records.map((record) => record.displayName));
      expect(savedNames).not.toContain('Dancer');
    });

    it('shows the same image reference handles after a reload as before it', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'saved-1', displayName: 'Dancer', file: new File(['one'], 'one.png', { type: 'image/png' }) },
      ]);
      const first = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await waitFor(() => expect(cardHandles(first.container, IMAGE_RENAME)).toEqual(['@dancer']));

      // A second reference with the same name takes a numbered handle.
      const input = first.container.querySelector<HTMLInputElement>(imageElementInput);
      fireEvent.change(input!, { target: { files: [new File(['two'], 'two.png', { type: 'image/png' })] } });
      await waitFor(() => expect(cardHandles(first.container, IMAGE_RENAME)).toHaveLength(2));
      renameCard(first.container, IMAGE_RENAME, 1, 'Dancer');
      await waitFor(() => expect(cardHandles(first.container, IMAGE_RENAME)).toEqual(['@dancer', '@dancer_2']));
      // Renaming the first frees "@dancer". The second keeps the handle the prompt uses for it.
      renameCard(first.container, IMAGE_RENAME, 0, 'Red jacket');
      await waitFor(() => expect(cardHandles(first.container, IMAGE_RENAME)).toEqual(['@red_jacket', '@dancer_2']));

      const saved = setPersistedImageElementRecordsMock.mock.calls.at(-1)?.[1] ?? [];
      expect(saved).toHaveLength(2);
      first.unmount();
      getPersistedImageElementRecordsMock.mockResolvedValue(saved);

      const second = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await waitFor(() => expect(cardHandles(second.container, IMAGE_RENAME)).toEqual(['@red_jacket', '@dancer_2']));
    });

    it('keeps a restored image reference handle until its own reference is renamed', async () => {
      stubRemix({
        generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead walks past @prop at dusk', category: 'video', model: 'seedance-2-5' },
        result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
        inputs: {
          video: {
            referenceMode: 'elements',
            startFrame: null,
            endFrame: null,
            elements: [
              { id: 'remix-1', displayName: 'Hero shot', handle: '@lead', url: 'https://signed.example.com/lead.png', storagePath: 'generation_inputs/owner-1/gen-1/00.png', sourceGenerationId: 'gen-1' },
              { id: 'remix-2', displayName: 'Umbrella', handle: '@prop', url: 'https://signed.example.com/prop.png', storagePath: 'generation_inputs/owner-1/gen-1/01.png', sourceGenerationId: 'gen-1' },
            ],
            referenceVideos: [],
            referenceAudios: [],
          },
        },
        workflowSettings: { model: 'seedance-2-5' },
        restoreIssues: [],
      });

      const view = render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@prop']));
      expect(promptBox()).toHaveValue('@lead walks past @prop at dusk');
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();

      renameCard(view.container, IMAGE_RENAME, 1, 'Red umbrella');
      await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@red_umbrella']));
      expect(promptBox()).toHaveValue('@lead walks past @red_umbrella at dusk');

      renameCard(view.container, IMAGE_RENAME, 0, 'Captain');
      await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@captain', '@red_umbrella']));
      expect(promptBox()).toHaveValue('@captain walks past @red_umbrella at dusk');
    });

    /**
     * A remix brings a run's references back on every model that takes them. Only
     * the Seedance 2 family got them back (2026-10-04). On each other model the
     * restore dropped the run's image references, and its clips and tracks with
     * them, so the prompt came back with its mentions and no card, and the line
     * under it read "Unknown element mentions: @lead, @prop".
     */
    describe('restored by a remix', () => {
      const KEPT = 'generation_inputs/owner-1/gen-1';
      type KeptInputs = NonNullable<RemixSourceBundle['inputs']['video']>;

      const keptImage = (place: string, displayName: string, handle: string): KeptInputs['elements'][number] => ({
        id: `remix-${place}`,
        displayName,
        handle,
        url: `https://signed.example.com/${KEPT}/${place}-reference_image.png`,
        storagePath: `${KEPT}/${place}-reference_image.png`,
        sourceGenerationId: 'gen-1',
      });
      const keptMedia = <Kind extends 'image' | 'video' | 'audio'>(kind: Kind, file: string, label: string, durationSeconds?: number) => ({
        kind,
        label,
        storagePath: `${KEPT}/${file}`,
        sourceGenerationId: 'gen-1',
        url: `https://signed.example.com/${KEPT}/${file}`,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
      // Neither handle is the one its reference's name would give ("@hero_shot",
      // "@umbrella"): the prompt was written with these.
      const LEAD = keptImage('00', 'Hero shot', '@lead');
      const PROP = keptImage('01', 'Umbrella', '@prop');
      const PROMPT = '@lead walks past @prop at dusk';
      const CLIP = keptMedia('video', '02-reference_video.mp4', 'Camera move', 4.5);
      const TRACK = keptMedia('audio', '03-reference_audio.mp3', 'Voice line', 6);

      /** What the server answers for a run that used references. */
      function referenceRun(model: string, overrides: {
        prompt?: string;
        settings?: Record<string, unknown>;
        video?: Partial<KeptInputs>;
      } = {}): RemixSourceBundle {
        return {
          generation: { id: 'gen-1', title: 'Harbour', prompt: overrides.prompt ?? PROMPT, category: 'video', model },
          result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
          inputs: {
            video: {
              referenceMode: 'elements',
              startFrame: null,
              endFrame: null,
              elements: [LEAD, PROP],
              referenceVideos: [],
              referenceAudios: [],
              ...overrides.video,
            },
          },
          workflowSettings: { model, referenceMode: 'elements', ...overrides.settings },
          restoreIssues: [],
        };
      }

      function renderRemix(bundle: RemixSourceBundle) {
        stubRemix(bundle);
        return render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      }

      /** The name on each image reference card, in card order. */
      function cardNames(container: HTMLElement) {
        return Array.from(container.querySelectorAll<HTMLInputElement>(`input[placeholder="${IMAGE_RENAME}"]`))
          .map((field) => field.value);
      }

      /** What the page last asked a price for. */
      function quotedRun() {
        return quoteStandIn.lastRequest();
      }

      /** The inputs of the run the page posted, as [slot, url, label] with a handle where the input has one. */
      function postedInputs() {
        return (postedRun().inputs as Array<{ slot: string; url: string; label: string; handle?: string }>)
          .map((input) => [input.slot, input.url, input.label, ...(input.handle ? [input.handle] : [])]);
      }

      it.each([
        ['Seedance 1.5 Pro', 'seedance-1.5-pro', {}],
        ['Wan 2.7', 'wan-2.7', {}],
        ['Kling O3', 'kling-o3', {}],
        ['MiniMax H3', 'minimax-h3', {}],
        ['HappyHorse 1.1', 'happyhorse-1.1', {}],
        ['Gemini Omni', 'gemini-omni-video', {}],
        ['Veo 3.1 Fast', 'veo-3.1', { mode: 'veo3_fast' }],
        ['Veo 3.1 Lite', 'veo-3.1', { mode: 'veo3_lite' }],
      ])('brings the image references of a %s run back under the handles its prompt mentions', async (_name, model, settings) => {
        const view = renderRemix(referenceRun(model, { settings }));

        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@prop']));
        expect(cardNames(view.container)).toEqual(['Hero shot', 'Umbrella']);
        expect(screen.getByAltText('Hero shot')).toHaveAttribute('src', LEAD.url);
        expect(screen.getByAltText('Umbrella')).toHaveAttribute('src', PROP.url);
        expect(promptBox()).toHaveValue(PROMPT);
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it('brings the one image reference of a Grok Imagine run back', async () => {
        const prompt = '@lead walks along the harbour at dusk';
        const view = renderRemix(referenceRun('grok-imagine-video', {
          prompt,
          settings: { mode: 'normal' },
          video: { elements: [LEAD] },
        }));

        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead']));
        expect(screen.getByAltText('Hero shot')).toHaveAttribute('src', LEAD.url);
        expect(promptBox()).toHaveValue(prompt);
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it('sends a restored reference as the file the run kept, under its handle, and uploads nothing', async () => {
        const view = renderRemix(referenceRun('seedance-1.5-pro'));
        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@prop']));

        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        const run = postedRun();
        expect(run.modelId).toBe('seedance-1.5-pro');
        expect(run.prompt).toBe(PROMPT);
        expect(run.sourceGenerationId).toBe('gen-1');
        expect(run.settings.referenceMode).toBe('elements');
        expect(run.inputs).toEqual([LEAD, PROP].map((reference) => expect.objectContaining({
          slot: 'imageReferences',
          kind: 'image',
          url: reference.url,
          label: reference.displayName,
          handle: reference.handle,
          storagePath: reference.storagePath,
          sourceGenerationId: 'gen-1',
        })));
        expect(temporaryUploadMock).not.toHaveBeenCalled();
      });

      it('brings a Wan 2.7 run back with its first frame beside its references', async () => {
        const firstFrame = keptMedia('image', '02-start_frame.png', 'Start frame');
        const view = renderRemix(referenceRun('wan-2.7', { video: { startFrame: firstFrame } }));

        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@prop']));
        expect(screen.getByAltText('Start frame')).toHaveAttribute('src', firstFrame.url);
        // Wan 2.7 is the one model that takes a first frame together with
        // references, so neither side is locked and nothing is in conflict.
        expect(screen.getByText(/can use this first frame together with your reusable images/)).toBeInTheDocument();
        expect(screen.queryByText(/cannot combine/)).not.toBeInTheDocument();

        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        expect(postedInputs()).toEqual([
          ['imageReferences', LEAD.url, 'Hero shot', '@lead'],
          ['imageReferences', PROP.url, 'Umbrella', '@prop'],
          ['startFrame', firstFrame.url, 'Start frame'],
        ]);
      });

      it.each([
        ['Wan 2.7', 'wan-2.7'],
        ['MiniMax H3', 'minimax-h3'],
      ])('brings the reference clip and the track of a %s run back with their lengths', async (_name, model) => {
        const view = renderRemix(referenceRun(model, { video: { referenceVideos: [CLIP], referenceAudios: [TRACK] } }));

        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@prop']));
        expect(screen.getByText('Camera move')).toBeInTheDocument();
        expect(screen.getByText('4.5s clip')).toBeInTheDocument();
        expect(screen.getByText('Voice line')).toBeInTheDocument();
        // The quote prices and caps a run by its clips and tracks, so it is told of them.
        await waitFor(() => {
          expect(quotedRun()?.modelId).toBe(model);
          expect(quotedRun()?.inputCounts).toMatchObject({ images: 2, videos: 1, audios: 1 });
          expect(quotedRun()?.inputMetadata?.slots?.videoReferences).toEqual({ count: 1, durationsSeconds: [4.5] });
          expect(quotedRun()?.inputMetadata?.slots?.audioReferences).toEqual({ count: 1, durationsSeconds: [6] });
        });

        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        expect(postedInputs()).toEqual([
          ['imageReferences', LEAD.url, 'Hero shot', '@lead'],
          ['imageReferences', PROP.url, 'Umbrella', '@prop'],
          ['videoReferences', CLIP.url, 'Camera move'],
          ['audioReferences', TRACK.url, 'Voice line'],
        ]);
        expect(temporaryUploadMock).not.toHaveBeenCalled();
      });

      it('brings the reference clip of a Gemini Omni run back', async () => {
        // A run with a clip and no image reference, so this reads the clip alone.
        const prompt = 'Follow the camera move of the clip through the harbour.';
        renderRemix(referenceRun('gemini-omni-video', { prompt, video: { elements: [], referenceVideos: [CLIP] } }));

        await waitFor(() => expect(screen.getByText('Camera move')).toBeInTheDocument());
        expect(screen.getByText('4.5s clip')).toBeInTheDocument();
        expect(promptBox()).toHaveValue(prompt);
        await waitFor(() => {
          expect(quotedRun()?.modelId).toBe('gemini-omni-video');
          expect(quotedRun()?.inputCounts).toMatchObject({ images: 0, videos: 1 });
          expect(quotedRun()?.inputMetadata?.slots?.videoReferences).toEqual({ count: 1, durationsSeconds: [4.5] });
        });

        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        expect(postedInputs()).toEqual([['videoReferences', CLIP.url, 'Camera move']]);
      });

      it('brings the clips of a Kling 3.0 run back as its video elements, and as nothing else', async () => {
        // The bundle hands a Kling clip over as a reference clip, and Kling 3.0 has no
        // slot for one: its clips are its video elements. Restored as a reference
        // clip too, it would wait on the standby card beside its own element.
        const view = renderRemix(referenceRun('kling-3.0-video', {
          prompt: '@dancer crosses the stage at dusk',
          settings: { klingVideoElements: [{ id: 'remix-1', displayName: 'Dancer', handle: '@dancer' }] },
          video: { elements: [], referenceVideos: [CLIP] },
        }));

        await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@dancer']));
        expect(screen.queryByText('Saved references are on standby')).not.toBeInTheDocument();
        expect(screen.queryByText(/stays? saved/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it('brings back no more image references than the model takes, and says which mention is left without one', async () => {
        // A run holds no more than its model takes, so this is a model whose limit
        // has come down since: Grok Imagine takes one image reference.
        const view = renderRemix(referenceRun('grok-imagine-video', { settings: { mode: 'normal' } }));

        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead']));
        expect(screen.queryByAltText('Umbrella')).not.toBeInTheDocument();
        expect(await unknownMentionLine()).toBe('Unknown element mention: @prop');
      });

      // The Seedance branch adds its own notice for a clip it cannot bring back. It used to
      // add it only when no notice stood yet, so a cap notice before it hid it (2026-10-20).
      it('tells a Seedance remix both that the cap left references out and that a clip did not come back', async () => {
        const six = Array.from({ length: 6 }, (_, index) => keptImage(`0${index}`, `Shot ${index + 1}`, `@shot_${index + 1}`));
        renderRemix(referenceRun('seedance-2', {
          prompt: 'The harbour at dusk',
          // An older run kept a prepared clip by its asset id alone, with no link to measure.
          settings: { referenceVideoUrls: ['prepared-clip-asset'] },
          video: { elements: six },
        }));

        expect(await screen.findByText(
          /Seedance 2 takes up to 5 reference images, so 5 of this run's 6 came back\. Some source media could not be restored automatically/,
        )).toBeInTheDocument();
      });

      // A run's saved Seedance assets follow its references, a lost one included. The remix
      // paired them by place among the references that came back, so after a lost one each
      // reference went out with the one before it's prepared asset, and Kie got that
      // picture in its place (2026-10-20).
      it('sends each restored Seedance reference with its own prepared asset after a lost one', async () => {
        const lost = { ...keptImage('09', 'Lost shot', '@lost'), url: null, storagePath: null };
        const prepared = (assetId: string) => ({
          assetId,
          assetType: 'Image' as const,
          status: 'active' as const,
          sourceUrl: null,
          error: null,
          lastCheckedAt: null,
        });
        const view = renderRemix(referenceRun('seedance-2', {
          settings: { seedanceAssets: { images: [prepared('asset-lost'), prepared('asset-lead'), prepared('asset-prop')], videos: [], audios: [] } },
          video: { elements: [lost, LEAD, PROP] },
        }));

        await waitFor(() => expect(cardHandles(view.container, IMAGE_RENAME)).toEqual(['@lead', '@prop']));
        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        expect((postedRun().inputs as Array<{ slot: string; url: string; assetId?: string | null }>)
          .filter((input) => input.slot === 'imageReferences')
          .map((input) => [input.url, input.assetId])).toEqual([
          [LEAD.url, 'asset-lead'],
          [PROP.url, 'asset-prop'],
        ]);
      });

      it('restores no image reference into a multi-shot run, where the page shows no reference card and sends none', async () => {
        const shots = [
          { id: 'shot-1', prompt: 'Open on the harbour in the rain, slow push in.', duration: 5 },
          { id: 'shot-2', prompt: 'Cut closer as the lamps come on.', duration: 5 },
        ];
        // Kling O3 is the one multi-shot model the reference table does not switch
        // off, and that is for its named subjects.
        renderRemix(referenceRun('kling-o3', {
          prompt: shots[0].prompt,
          settings: { isMultiShot: true, multiPrompts: shots },
        }));

        await waitFor(() => expect(screen.getByPlaceholderText('Describe shot 2...')).toHaveValue(shots[1].prompt));
        await waitFor(() => expect(quotedRun()?.modelId).toBe('kling-o3'));
        expect(quotedRun()?.settings?.isMultiShot).toBe(true);
        // One restored there would be held where the page has no card for it, and
        // the page would say so.
        expect(screen.queryByText('Reusable references are paused in multi-shot')).not.toBeInTheDocument();
      });

      it('brings a run that used frames back with its frames, and no reference card', async () => {
        const startFrame = keptMedia('image', '00-start_frame.png', 'Start frame');
        const endFrame = keptMedia('image', '01-end_frame.png', 'End frame');
        const prompt = 'A lighthouse at dusk, slow push in.';
        const view = renderRemix(referenceRun('seedance-1.5-pro', {
          prompt,
          settings: { referenceMode: 'frames' },
          video: { referenceMode: 'frames', startFrame, endFrame, elements: [] },
        }));

        await waitFor(() => expect(screen.getByAltText('Start frame')).toHaveAttribute('src', startFrame.url));
        expect(screen.getByAltText('End frame')).toHaveAttribute('src', endFrame.url);
        expect(cardHandles(view.container, IMAGE_RENAME)).toEqual([]);
        expect(promptBox()).toHaveValue(prompt);
      });
    });
  });

  /**
   * A Kling O3 subject's @handle is written in lower case, as every other handle
   * is. It kept the capitals of the subject's name ("@Hero_creator", 2026-10-03),
   * and the code that reads handles out of a prompt reads lower case only. Typed
   * the way the card showed it, the handle was not read, and the "@" panel shut at
   * its first capital. Typed in lower case it was refused as an unknown element,
   * although that is the spelling the server gives the provider.
   *
   * The handle is also kept with its subject, as an element's is on the other two
   * cards. It was built from the subjects' names each time the cards were drawn
   * (2026-10-03): a renamed subject left its old mention in the prompt and the
   * shots, and renaming or removing the first of two subjects with one name gave
   * its handle to the second, so a mention named another subject.
   */
  describe('Kling O3 subject handles', () => {
    function subjectFields(container: HTMLElement) {
      return Array.from(container.querySelectorAll<HTMLInputElement>('input[placeholder="Subject name"]'));
    }

    /** A subject's card: its name field's nearest ancestor that holds the image picker. */
    function subjectCard(field: HTMLInputElement) {
      let card = field.parentElement;
      while (card && !card.querySelector('input[type="file"]')) {
        card = card.parentElement;
      }
      return card;
    }

    /** The @handle each subject card shows, in card order. */
    function subjectHandles(container: HTMLElement) {
      return subjectFields(container).map((field) => (
        Array.from(subjectCard(field)?.querySelectorAll('span') ?? [])
          .find((span) => /^@\w+$/.test(span.textContent ?? ''))?.textContent ?? null
      ));
    }

    function promptBox() {
      return screen.getByPlaceholderText(/^Describe the .+ scene in rich cinematic detail/);
    }

    /** Types a name into a subject's name field and commits it with Enter. */
    function nameSubject(container: HTMLElement, index: number, name: string) {
      const field = subjectFields(container)[index];
      fireEvent.change(field, { target: { value: name } });
      fireEvent.keyDown(field, { key: 'Enter' });
    }

    async function renderWithSubjects(...names: string[]) {
      const view = render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);
      await screen.findByText('Named subjects');
      for (const [index, name] of names.entries()) {
        fireEvent.click(screen.getByText('Add subject'));
        nameSubject(view.container, index, name);
        await waitFor(() => expect(subjectFields(view.container)[index]).toHaveValue(name));
      }
      return view;
    }

    /** Gives a subject its images. A subject is saved only once it has some. */
    async function attachImages(container: HTMLElement, index: number, names: string[]) {
      const card = subjectCard(subjectFields(container)[index]);
      const picker = card?.querySelector<HTMLInputElement>('input[type="file"]');
      expect(picker).not.toBeNull();
      fireEvent.change(picker!, {
        target: { files: names.map((name) => new File([name], name, { type: 'image/png' })) },
      });
      await waitFor(() => expect(card).toHaveTextContent(`${names.length}/4 images`));
    }

    it('writes the handle in lower case, on the card and where the prompt offers it', async () => {
      const view = await renderWithSubjects('Hero creator');

      expect(subjectHandles(view.container)).toEqual(['@hero_creator']);
      // Nothing on the page offers the handle in another spelling.
      expect(screen.queryByText('@Hero_creator')).not.toBeInTheDocument();
    });

    it('accepts the handle typed by hand', async () => {
      await renderWithSubjects('Hero creator');

      fireEvent.change(promptBox(), { target: { value: 'A scene with @hero_creator walking' } });

      expect(promptBox()).toHaveValue('A scene with @hero_creator walking');
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('puts a subject\'s handle in the prompt from the Insert beside it', async () => {
      await renderWithSubjects('Hero creator');
      fireEvent.change(promptBox(), { target: { value: 'A scene with' } });

      fireEvent.click(screen.getByRole('button', { name: 'Insert @hero_creator' }));

      expect((promptBox() as HTMLTextAreaElement).value).toContain('@hero_creator');
    });

    it('keeps the "@" panel open at a capital letter, and inserts the handle from it', async () => {
      await renderWithSubjects('Hero creator');

      // The name is "Hero creator", so this is how a creator starts to look for it.
      fireEvent.change(promptBox(), { target: { value: 'A scene with @H' } });

      const title = await screen.findByText('Insert reference');
      // The panel is the title's nearest ancestor that holds a reference to pick.
      let panel = title.parentElement;
      while (panel && !panel.querySelector('button')) {
        panel = panel.parentElement;
      }
      const suggestion = Array.from(panel?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes('@hero_creator'));
      expect(suggestion).toBeDefined();

      fireEvent.click(suggestion!);

      // What was typed is replaced by the handle as it is written.
      expect(promptBox()).toHaveValue('A scene with @hero_creator');
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('numbers the later of two subjects whose names differ only by a capital', async () => {
      const view = await renderWithSubjects('Hero', 'hero');

      // The server reads both names as one handle, so the page must tell them apart itself.
      expect(subjectHandles(view.container)).toEqual(['@hero', '@hero_2']);
    });

    it('gives a renamed subject the handle of its new name, and the prompt follows', async () => {
      const view = await renderWithSubjects('Hero');
      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@hero']));

      fireEvent.change(promptBox(), { target: { value: '@hero walks in, then @hero waves.' } });

      nameSubject(view.container, 0, 'Villain');

      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@villain']));
      await waitFor(() => expect(promptBox()).toHaveValue('@villain walks in, then @villain waves.'));
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('rewrites the mention in every shot prompt when a subject is renamed', async () => {
      const view = await renderWithSubjects('Hero');
      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@hero']));

      chooseMultiShot();
      fireEvent.change(await screen.findByPlaceholderText('Describe shot 1...'), {
        target: { value: 'Open on @hero in the rain' },
      });

      nameSubject(view.container, 0, 'Villain');

      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@villain']));
      await waitFor(() => expect(screen.getByPlaceholderText('Describe shot 1...')).toHaveValue('Open on @villain in the rain'));
    });

    it('leaves the second of two subjects with one name its handle when the first is renamed', async () => {
      const view = await renderWithSubjects('Hero', 'Hero');
      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@hero', '@hero_2']));

      fireEvent.change(promptBox(), { target: { value: '@hero hands the cup to @hero_2' } });

      nameSubject(view.container, 0, 'Villain');

      // Renaming the first frees "@hero". The second keeps the handle the prompt uses for it.
      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@villain', '@hero_2']));
      await waitFor(() => expect(promptBox()).toHaveValue('@villain hands the cup to @hero_2'));
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('leaves the second of two subjects with one name its handle when the first is removed', async () => {
      const view = await renderWithSubjects('Hero', 'Hero');
      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@hero', '@hero_2']));

      fireEvent.change(promptBox(), { target: { value: '@hero_2 walks on alone' } });

      fireEvent.click(screen.getAllByRole('button', { name: 'Remove Hero' })[0]);

      await waitFor(() => expect(subjectFields(view.container)).toHaveLength(1));
      // The subject that is left is the one the prompt mentions.
      expect(subjectHandles(view.container)).toEqual(['@hero_2']);
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('sends the subject that is left under the handle the prompt mentions it by', async () => {
      const view = await renderWithSubjects('Hero', 'Hero');
      await attachImages(view.container, 1, ['second-front.png', 'second-side.png']);

      const prompt = '@hero_2 walks on alone through the bright studio, slow push in on the face.';
      fireEvent.change(promptBox(), { target: { value: prompt } });
      fireEvent.click(screen.getAllByRole('button', { name: 'Remove Hero' })[0]);
      await waitFor(() => expect(subjectFields(view.container)).toHaveLength(1));

      fireEvent.click(generateButton());

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/generations',
          expect.objectContaining({ method: 'POST' })
        );
      });

      const postCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input).includes('/api/generations') && init?.method === 'POST'
      ));
      const body = JSON.parse(String(postCall?.[1]?.body));
      expect(body.prompt).toBe(prompt);
      const subjectImages = body.inputs.filter((input: { slot: string }) => input.slot === 'subjectImages');
      expect(subjectImages.map((input: { handle: string; url: string }) => [input.handle, input.url])).toEqual([
        ['@hero_2', 'uploads/user-1/second-front.png'],
        ['@hero_2', 'uploads/user-1/second-side.png'],
      ]);
    });

    it('renames a subject when its name field is left or Enter is pressed, not while the name is typed', async () => {
      const view = await renderWithSubjects('Hero');
      fireEvent.change(promptBox(), { target: { value: 'A scene with @hero walking' } });
      const field = subjectFields(view.container)[0];

      // Half typed, the field reads "Vil". To the prompt the subject is still "@hero".
      fireEvent.change(field, { target: { value: 'Vil' } });
      expect(field).toHaveValue('Vil');
      expect(subjectHandles(view.container)).toEqual(['@hero']);
      expect(promptBox()).toHaveValue('A scene with @hero walking');
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();

      fireEvent.change(field, { target: { value: '  Villain ' } });
      fireEvent.blur(field);

      await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@villain']));
      expect(field).toHaveValue('Villain');
      expect(promptBox()).toHaveValue('A scene with @villain walking');
    });

    it('reads the mention being typed from the prompt as it stands, a frame after a rename rewrote it', async () => {
      const view = await renderWithSubjects('Hero');
      fireEvent.change(promptBox(), { target: { value: 'A scene with @hero' } });

      // The rename rewrites the prompt, and the page reads the mention at the caret
      // again once it has drawn that. The prompt is typed into before it gets there.
      nameSubject(view.container, 0, 'Villain');
      expect(promptBox()).toHaveValue('A scene with @villain');
      fireEvent.change(promptBox(), { target: { value: 'A scene with @villain and @V' } });
      await new Promise((resolve) => setTimeout(resolve, 60));

      // The panel is still at what was typed last, not at the prompt the rename left.
      const title = screen.getByText('Insert reference');
      let panel = title.parentElement;
      while (panel && !panel.querySelector('button')) {
        panel = panel.parentElement;
      }
      expect(panel).toHaveTextContent('@V');
      const suggestion = Array.from(panel?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes('@villain'));
      expect(suggestion).toBeDefined();

      fireEvent.click(suggestion!);

      expect(promptBox()).toHaveValue('A scene with @villain and @villain');
    });

    it('puts the old name back on Escape, and leaves the handle and the prompt alone', async () => {
      const view = await renderWithSubjects('Hero');
      fireEvent.change(promptBox(), { target: { value: 'A scene with @hero walking' } });
      const field = subjectFields(view.container)[0];

      // Escape takes the focus off the field, which must not take the typed name
      // with it. Only a field that has the focus can lose it.
      field.focus();
      fireEvent.change(field, { target: { value: 'Villain' } });
      fireEvent.keyDown(field, { key: 'Escape' });

      await waitFor(() => expect(field).toHaveValue('Hero'));
      expect(field).not.toHaveFocus();
      expect(subjectHandles(view.container)).toEqual(['@hero']);
      expect(promptBox()).toHaveValue('A scene with @hero walking');
    });

    it('keeps the name of a subject whose name field is left empty', async () => {
      const view = await renderWithSubjects('Hero');
      const field = subjectFields(view.container)[0];

      fireEvent.change(field, { target: { value: '   ' } });
      fireEvent.blur(field);

      await waitFor(() => expect(field).toHaveValue('Hero'));
      expect(subjectHandles(view.container)).toEqual(['@hero']);
    });

    it('calls a subject by its place when its name has nothing a handle can hold', async () => {
      const view = await renderWithSubjects('Hero', 'नायक');

      expect(subjectHandles(view.container)).toEqual(['@hero', '@subject_2']);
    });

    it('saves the handle with the subject, and shows the same handles after a reload', async () => {
      const first = await renderWithSubjects('Hero', 'Hero');
      await attachImages(first.container, 0, ['first-front.png', 'first-side.png']);
      await attachImages(first.container, 1, ['second-front.png', 'second-side.png']);

      // Renaming the first frees "@hero". The second keeps the handle the prompt uses for it.
      nameSubject(first.container, 0, 'Villain');
      await waitFor(() => expect(subjectHandles(first.container)).toEqual(['@villain', '@hero_2']));

      // The reload: the page goes away, and the next one starts from what was saved.
      const saved = setPersistedSubjectRecordsMock.mock.calls.at(-1)?.[1] ?? [];
      expect(saved.map((subject) => [subject.displayName, subject.handle])).toEqual([
        ['Villain', '@villain'],
        ['Hero', '@hero_2'],
      ]);
      first.unmount();
      getPersistedSubjectRecordsMock.mockResolvedValue(saved);

      const second = render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);
      // Built from the names again, the second would come back as "@hero".
      await waitFor(() => expect(subjectHandles(second.container)).toEqual(['@villain', '@hero_2']));
    });

    it('sends each subject image under the handle the prompt mentions', async () => {
      const view = await renderWithSubjects('Hero creator');
      const picker = subjectCard(subjectFields(view.container)[0])?.querySelector<HTMLInputElement>('input[type="file"]');
      expect(picker).not.toBeNull();
      fireEvent.change(picker!, {
        target: {
          files: [
            new File(['front'], 'hero-front.png', { type: 'image/png' }),
            new File(['side'], 'hero-side.png', { type: 'image/png' }),
          ],
        },
      });
      await screen.findByText('2/4 images');

      const prompt = '@hero_creator lifts the serum and smiles at the camera in a bright studio, slow push in.';
      fireEvent.change(promptBox(), { target: { value: prompt } });
      fireEvent.click(generateButton());

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/generations',
          expect.objectContaining({ method: 'POST' })
        );
      });

      const postCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input).includes('/api/generations') && init?.method === 'POST'
      ));
      const body = JSON.parse(String(postCall?.[1]?.body));
      expect(body.prompt).toBe(prompt);
      expect(body.settings.referenceMode).toBe('subjects');
      const subjectImages = body.inputs.filter((input: { slot: string }) => input.slot === 'subjectImages');
      expect(subjectImages.map((input: { handle: string; label: string }) => [input.handle, input.label])).toEqual([
        ['@hero_creator', 'Hero creator'],
        ['@hero_creator', 'Hero creator'],
      ]);
    });

    /**
     * A shot prompt takes a subject's handle the way the single prompt does. The
     * subject card says "mention its @handle in the prompt or shot prompts", but
     * in multi-shot mode nothing offered the handle: the "@" panel under a shot
     * opened for Kling 3.0's video elements only, and the row of handles to click
     * belongs to the single prompt's card. A mistyped handle went unnoticed too.
     * The page read shot prompts for unknown mentions on Kling 3.0 only, so a Kling
     * O3 run uploaded every subject image before the server refused it. And the
     * Enhance button of a shot was not told the subjects, so the enhancer had no
     * handle to keep (2026-10-03).
     */
    describe('in a shot prompt', () => {
      async function renderShotsWithSubjects(...names: string[]) {
        const view = await renderWithSubjects(...names);
        chooseMultiShot();
        await screen.findByPlaceholderText('Describe shot 1...');
        return view;
      }

      function shotBox(shot = 1) {
        return screen.getByPlaceholderText(`Describe shot ${shot}...`);
      }

      /** Gives the first subject the two images a run needs. */
      async function attachSubjectImages(container: HTMLElement) {
        const picker = subjectCard(subjectFields(container)[0])?.querySelector<HTMLInputElement>('input[type="file"]');
        expect(picker).not.toBeNull();
        fireEvent.change(picker!, {
          target: {
            files: [
              new File(['front'], 'hero-front.png', { type: 'image/png' }),
              new File(['side'], 'hero-side.png', { type: 'image/png' }),
            ],
          },
        });
        await screen.findByText('2/4 images');
      }

      it('offers the subjects under a shot prompt at "@", and finds one by its name', async () => {
        await renderShotsWithSubjects('Hero creator', 'Serum bottle');
        expect(shotMentionPanelState()).toBeNull();

        fireEvent.change(shotBox(), { target: { value: 'Open on @' } });

        expect(shotMentionPanelState()).toEqual({
          title: 'Insert subject',
          help: 'Pick a named subject for this shot.',
          offers: ['@hero_creator', '@serum_bottle'],
        });

        // The name is "Hero creator", so this is how a creator starts to look for it.
        fireEvent.change(shotBox(), { target: { value: 'Open on @H' } });

        expect(shotMentionPanelState()?.offers).toEqual(['@hero_creator']);
      });

      it('inserts the handle picked in place of what was typed', async () => {
        await renderShotsWithSubjects('Hero creator');

        fireEvent.change(shotBox(), { target: { value: 'Open on @H' } });
        expect(shotMentionPanelState()?.offers).toEqual(['@hero_creator']);

        fireEvent.click(shotMentionPanel()!.querySelector('button')!);

        expect(shotBox()).toHaveValue('Open on @hero_creator');
        expect(shotMentionPanelState()).toBeNull();
      });

      it('says so when no subject matches what was typed', async () => {
        await renderShotsWithSubjects('Hero creator');

        fireEvent.change(shotBox(), { target: { value: 'Open on @z' } });

        expect(shotMentionPanelState()).toEqual({
          title: 'Insert subject',
          help: 'No matching subjects yet.',
          offers: [],
        });
      });

      it('stops a run at a mention no subject has, before any subject image is uploaded', async () => {
        const view = await renderShotsWithSubjects('Hero creator');
        await attachSubjectImages(view.container);

        fireEvent.change(shotBox(), { target: { value: 'Open on @hero_creator in the rain, slow push in.' } });
        fireEvent.click(screen.getByText('Add New Shot'));
        // One letter short, in the second shot.
        fireEvent.change(await screen.findByPlaceholderText('Describe shot 2...'), {
          target: { value: 'Cut closer while @hero_creatr turns to the camera.' },
        });
        fireEvent.click(generateButton());

        // The words the server refuses the run with, said before anything is sent.
        expect(await unknownMentionLine()).toBe('Unknown element mention: @hero_creatr');
        expect(temporaryUploadMock).not.toHaveBeenCalled();
        expect(postedRun()).toBeUndefined();
      });

      it('sends a run whose shots mention its subjects', async () => {
        const view = await renderShotsWithSubjects('Hero creator');
        await attachSubjectImages(view.container);

        fireEvent.change(shotBox(), { target: { value: 'Open on @hero_creator in the rain, slow push in.' } });
        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        const run = postedRun();
        expect(run.settings).toMatchObject({ isMultiShot: true, referenceMode: 'subjects' });
        expect(run.shots).toEqual([{ prompt: 'Open on @hero_creator in the rain, slow push in.', duration: 5 }]);
        expect(
          run.inputs
            .filter((input: { slot: string }) => input.slot === 'subjectImages')
            .map((input: { handle: string }) => input.handle)
        ).toEqual(['@hero_creator', '@hero_creator']);
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it("tells a shot's Enhance button about the subjects, so the enhancer keeps their handles", async () => {
        await renderShotsWithSubjects('Hero creator');

        fireEvent.change(shotBox(), { target: { value: 'Open on @hero_creator in the rain' } });

        expect(shotEnhanceButton(0)?.prompt).toBe('Open on @hero_creator in the rain');
        expect(shotEnhanceButton(0)?.context?.elementReferences).toEqual([
          { handle: '@hero_creator', displayName: 'Hero creator' },
        ]);
      });
    });

    /**
     * A remix of a run that used named subjects brings the subjects back. A run
     * kept nothing of its subjects, so its remix restored the prompt with its
     * mentions and no subject card, and the line under the prompt read "Unknown
     * element mention: @hero" until the creator built a subject of that name
     * again (2026-10-03).
     *
     * A subject comes back under the handle the prompt was written with, which is
     * not always the handle its name would give, and with the pictures the run
     * kept of it.
     */
    describe('restored by a remix', () => {
      const KEPT = 'generation_inputs/owner-1/gen-1';
      const keptImage = (file: string, label: string): RemixResolvedSubject['images'][number] => ({
        kind: 'image',
        label,
        storagePath: `${KEPT}/${file}`,
        sourceGenerationId: null,
        url: `https://signed.example.com/${KEPT}/${file}`,
      });
      // Neither handle is the one its subject's name would give ("@hero_creator",
      // "@serum_bottle"): the creator renamed nothing, the prompt was written this way.
      const SUBJECTS: RemixResolvedSubject[] = [
        {
          handle: '@lead',
          displayName: 'Hero creator',
          images: ['00', '01', '02'].map((place) => keptImage(`${place}-subject_image.png`, 'Hero creator')),
        },
        {
          handle: '@bottle',
          displayName: 'Serum bottle',
          images: ['03', '04'].map((place) => keptImage(`${place}-subject_image.png`, 'Serum bottle')),
        },
      ];
      const PROMPT = '@lead lifts @bottle and smiles at the camera in a bright studio, slow push in.';

      function subjectRun(overrides: {
        prompt?: string;
        subjects?: RemixResolvedSubject[];
        workflowSettings?: Record<string, unknown>;
        restoreIssues?: string[];
      } = {}): RemixSourceBundle {
        return {
          generation: { id: 'gen-1', title: 'Serum launch', prompt: overrides.prompt ?? PROMPT, category: 'video', model: 'kling-o3' },
          result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
          inputs: {
            video: {
              referenceMode: 'elements',
              startFrame: null,
              endFrame: null,
              elements: [],
              referenceVideos: [],
              referenceAudios: [],
              subjects: overrides.subjects ?? SUBJECTS,
            },
          },
          workflowSettings: { model: 'kling-o3', referenceMode: 'elements', ...overrides.workflowSettings },
          restoreIssues: overrides.restoreIssues ?? [],
        };
      }

      /** The pictures on each subject card, in card order. */
      function subjectPictures(container: HTMLElement) {
        return subjectFields(container).map((field) => (
          Array.from(subjectCard(field)?.querySelectorAll('img') ?? []).map((picture) => picture.getAttribute('src'))
        ));
      }

      function renderRemix(bundle: RemixSourceBundle) {
        stubRemix(bundle);
        return render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      }

      it('brings each subject back with its name, its pictures and the handle the prompt mentions', async () => {
        const view = renderRemix(subjectRun());

        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@bottle']));
        expect(subjectFields(view.container).map((field) => field.value)).toEqual(['Hero creator', 'Serum bottle']);
        expect(subjectPictures(view.container)).toEqual([
          ['00', '01', '02'].map((place) => `https://signed.example.com/${KEPT}/${place}-subject_image.png`),
          ['03', '04'].map((place) => `https://signed.example.com/${KEPT}/${place}-subject_image.png`),
        ]);
        expect(subjectCard(subjectFields(view.container)[0])).toHaveTextContent('3/4 images');
        expect(subjectCard(subjectFields(view.container)[1])).toHaveTextContent('2/4 images');
        expect(promptBox()).toHaveValue(PROMPT);
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it('sends a restored picture as the file the run kept, and uploads nothing', async () => {
        const view = renderRemix(subjectRun());
        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@bottle']));

        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        const run = postedRun();
        expect(run.modelId).toBe('kling-o3');
        expect(run.prompt).toBe(PROMPT);
        expect(run.sourceGenerationId).toBe('gen-1');
        expect(run.settings.referenceMode).toBe('subjects');
        // The server reads who may use a kept file from its path, so the path is what is sent.
        expect(
          run.inputs
            .filter((input: { slot: string }) => input.slot === 'subjectImages')
            .map((input: { handle: string; label: string; url: string; storagePath: string }) => (
              [input.handle, input.label, input.url, input.storagePath]
            ))
        ).toEqual([
          ['@lead', 'Hero creator', `${KEPT}/00-subject_image.png`, `${KEPT}/00-subject_image.png`],
          ['@lead', 'Hero creator', `${KEPT}/01-subject_image.png`, `${KEPT}/01-subject_image.png`],
          ['@lead', 'Hero creator', `${KEPT}/02-subject_image.png`, `${KEPT}/02-subject_image.png`],
          ['@bottle', 'Serum bottle', `${KEPT}/03-subject_image.png`, `${KEPT}/03-subject_image.png`],
          ['@bottle', 'Serum bottle', `${KEPT}/04-subject_image.png`, `${KEPT}/04-subject_image.png`],
        ]);
        expect(temporaryUploadMock).not.toHaveBeenCalled();
      });

      it('keeps a restored handle until its own subject is renamed', async () => {
        const view = renderRemix(subjectRun());
        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@bottle']));

        // Renaming the other subject, and adding one, leave "@lead" alone.
        nameSubject(view.container, 1, 'Glass vial');
        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@glass_vial']));
        fireEvent.click(screen.getByText('Add subject'));
        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@glass_vial', '@subject_3']));
        expect(promptBox()).toHaveValue('@lead lifts @glass_vial and smiles at the camera in a bright studio, slow push in.');

        nameSubject(view.container, 0, 'Captain');
        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@captain', '@glass_vial', '@subject_3']));
        expect(promptBox()).toHaveValue('@captain lifts @glass_vial and smiles at the camera in a bright studio, slow push in.');
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it('brings the subjects of a multi-shot run back for its shots to mention', async () => {
        const shots = [
          { id: 'shot-1', prompt: 'Open on @lead in the rain, slow push in.', duration: 5 },
          { id: 'shot-2', prompt: 'Cut closer while @lead lifts @bottle to the light.', duration: 5 },
        ];
        const view = renderRemix(subjectRun({
          // A multi-shot run is saved under the prompt of its first shot.
          prompt: shots[0].prompt,
          workflowSettings: { isMultiShot: true, multiPrompts: shots },
        }));

        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@bottle']));
        expect(screen.getByPlaceholderText('Describe shot 2...')).toHaveValue(shots[1].prompt);

        fireEvent.click(generateButton());

        await waitFor(() => expect(postedRun()).toBeDefined());
        const run = postedRun();
        expect(run.shots).toEqual(shots.map(({ prompt, duration }) => ({ prompt, duration })));
        expect(
          run.inputs
            .filter((input: { slot: string }) => input.slot === 'subjectImages')
            .map((input: { handle: string }) => input.handle)
        ).toEqual(['@lead', '@lead', '@lead', '@bottle', '@bottle']);
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      it('brings a subject back without a picture the server could not hand over, and says some media is missing', async () => {
        const [lead, bottle] = SUBJECTS;
        const view = renderRemix(subjectRun({
          subjects: [
            lead,
            { ...bottle, images: [bottle.images[0], { ...bottle.images[1], url: null }] },
          ],
          restoreIssues: ['video-subject:Serum bottle'],
        }));

        // The card and its handle are there, so the prompt's mention still names a subject.
        await waitFor(() => expect(subjectHandles(view.container)).toEqual(['@lead', '@bottle']));
        expect(subjectPictures(view.container)[1]).toEqual([`https://signed.example.com/${KEPT}/03-subject_image.png`]);
        expect(subjectCard(subjectFields(view.container)[1])).toHaveTextContent('1/4 images — add at least 2');
        expect(screen.getByText(/Some source media could not be restored automatically/)).toBeInTheDocument();
        expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
      });

      // A run made before subjects were kept, or one whose creator shared no
      // inputs: the bundle has the prompt and no subject. The line under the
      // prompt says which mention has nothing behind it, as it does for any
      // other reference a remix could not bring back.
      it('brings back no subject from a run that kept none, and names the mentions left without one', async () => {
        const view = renderRemix(subjectRun({ subjects: [] }));

        await waitFor(() => expect(promptBox()).toHaveValue(PROMPT));
        expect(await unknownMentionLine()).toBe('Unknown element mentions: @lead, @bottle');
        expect(subjectFields(view.container)).toHaveLength(0);
      });
    });
  });

  /**
   * A prompt that mentions a saved reference the selected model cannot take.
   *
   * A reference saved on one model stays in the browser, so a prompt on Kling 3.0
   * can still mention it. The row under the prompt answered "Switch to Reusable
   * references to use @hero", which named a mode switch the page lost when the
   * shape of a run became a reading of what is attached (#95). That line was
   * removed (2026-10-03): it showed only while the page had no catalog entry for
   * the model, where Generate is disabled.
   *
   * With saved references left out of the run, such a prompt reaches Generate on
   * a model that has its catalog entry too, and the model's reason alone ("...
   * not available for this model yet") did not say that one word of the prompt
   * was what stopped the run. The row names the mention now, and so does the
   * refusal (2026-10-04).
   *
   * This file's catalog hook hands the page no descriptor, so the page reads its
   * built-in table here. "references saved on another model" below has the same
   * on the catalog's entries.
   */
  describe('a saved reference the model cannot take', () => {
    const prompt = 'A harbour at dusk where @hero walks home';

    function promptBox() {
      return screen.getByPlaceholderText(/^Describe the Kling 3\.0 Cinematic scene/);
    }

    async function renderWithSavedReferenceMentioned() {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'saved-1', displayName: 'Hero', file: new File(['image'], 'hero.png', { type: 'image/png' }) },
      ]);
      const view = render(<CreateVideoClient prefill={{}} />);
      // The saved reference is read back, and Kling 3.0 cannot take it.
      await screen.findByText('Saved references are on standby');
      fireEvent.change(promptBox(), { target: { value: prompt } });
      return view;
    }

    it('says why on the standby card, and names the mention in the row under the prompt', async () => {
      await renderWithSavedReferenceMentioned();

      expect(screen.getByText(/Reusable image references are not available for Kling yet\./)).toBeInTheDocument();
      // The handle is one the page knows, so it is not an unknown mention.
      const row = promptBox().nextElementSibling;
      expect(Array.from(row?.children ?? []).map((part) => part.textContent)).toEqual([
        `${prompt.length} / 2,500`,
        'On standby here: @hero',
      ]);
    });

    it('leaves that row to an unknown mention while the prompt has one', async () => {
      // One line at a time, in the order Generate refuses a prompt.
      await renderWithSavedReferenceMentioned();
      const withUnknown = `${prompt} past @ghost`;
      fireEvent.change(promptBox(), { target: { value: withUnknown } });

      const row = promptBox().nextElementSibling;
      expect(Array.from(row?.children ?? []).map((part) => part.textContent)).toEqual([
        `${withUnknown.length} / 2,500`,
        'Unknown element mention: @ghost',
      ]);
    });

    it('says nothing in that row while the prompt mentions no saved reference', async () => {
      await renderWithSavedReferenceMentioned();
      fireEvent.change(promptBox(), { target: { value: 'A harbour at dusk' } });

      const row = promptBox().nextElementSibling;
      expect(row?.textContent).toBe('17 / 2,500');
      expect(row?.children).toHaveLength(1);
    });

    it('refuses the run and names the mention', async () => {
      const view = await renderWithSavedReferenceMentioned();

      fireEvent.click(generateButton());

      expect(view.container.querySelector('p.text-red-400')?.textContent)
        .toBe('Kling 3.0 Cinematic cannot use @hero. Remove it from the prompt, or pick a model that takes reusable references.');
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalledWith('/api/generations', expect.objectContaining({ method: 'POST' }));
    });
  });

  /**
   * What a creator with no draft opens on: the catalog's default video model at that
   * model's own defaults. Since 2026-10-28 that is Seedance 2 Mini at 480p for 5 s without
   * sound, 19 credits, inside a new account's 25 welcome credits. The page draws Kling 3.0
   * until the catalog has loaded, and none of Kling's form may carry over: at the 720p the
   * page starts with, the run would be 41 credits.
   */
  describe('the catalog default', () => {
    const publishedCatalog = serverCatalog.buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

    it('opens on Seedance 2 Mini at 480p for 5 s without sound, 19 credits', async () => {
      expect(publishedCatalog.defaults.video).toBe('seedance-2-mini');
      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.extraModels = publishedCatalog.models
        .filter((model) => model.id === 'seedance-2-mini') as unknown as Array<Record<string, unknown>>;
      render(<CreateVideoClient prefill={{}} />);

      await waitFor(() => expect(quoteStandIn.lastRequest()?.modelId).toBe('seedance-2-mini'));
      const request = quoteStandIn.lastRequest()!;
      expect(request.settings).toMatchObject({ aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false });
      expect(screen.getByRole('button', { name: /^Generation settings: / }))
        .toHaveAccessibleName('Generation settings: 480P · 16:9 · 5s · Sound off');
      // The server's own price for the request the page asks.
      expect(serverCatalog.quoteGenerationModel({ ...request, catalogRevision: undefined }).costCredits).toBe(19);
    });

    /** Seedance 2 Mini as published, with its control defaults replaced where named. */
    function miniWithDefaults(defaults: Record<string, string | number | boolean>) {
      const mini = publishedCatalog.models.find((model) => model.id === 'seedance-2-mini')!;
      return {
        ...mini,
        controls: mini.controls.map((control) => (control.key in defaults ? { ...control, defaultValue: defaults[control.key] } : control)),
      } as unknown as Record<string, unknown>;
    }

    it('opens on the default\'s published settings when its details arrive before the stand-in\'s', async () => {
      // A browser that has Mini's details but not Kling 3.0's: nothing clears the page's
      // own 720p before Mini is chosen, and the run would be 41 credits.
      modelCatalogState.honestDetails = true;
      modelCatalogState.withoutModels = ['kling-3.0-video'];
      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.extraModels = [miniWithDefaults({ aspectRatio: '9:16', duration: 6, sound: true })];
      render(<CreateVideoClient prefill={{}} />);

      await waitFor(() => expect(quoteStandIn.lastRequest()?.modelId).toBe('seedance-2-mini'));
      await waitFor(() => expect(quoteStandIn.lastRequest()!.settings)
        .toMatchObject({ aspectRatio: '9:16', resolution: '480p', duration: 6, sound: true }));
      expect(screen.getByRole('button', { name: /^Generation settings: / }))
        .toHaveAccessibleName('Generation settings: 480P · 9:16 · 6s · Sound on');
    });

    it('keeps a ratio and a length the link asked for, even the stand-in\'s own', async () => {
      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.extraModels = [miniWithDefaults({ aspectRatio: '9:16', duration: 6 })];
      render(<CreateVideoClient prefill={{ aspectRatio: '16:9', duration: '5' }} />);

      await waitFor(() => expect(quoteStandIn.lastRequest()?.modelId).toBe('seedance-2-mini'));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(quoteStandIn.lastRequest()!.settings).toMatchObject({ aspectRatio: '16:9', resolution: '480p', duration: 5 });
    });

    it('waits for the default\'s details rather than settling on the stand-in', async () => {
      modelCatalogState.videoDefault = 'seedance-2-mini';
      const view = render(<CreateVideoClient prefill={{}} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      modelCatalogState.extraModels = [miniWithDefaults({})];
      view.rerender(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(quoteStandIn.lastRequest()).toMatchObject({
        modelId: 'seedance-2-mini',
        settings: { resolution: '480p', duration: 5 },
      }));
    });

    it('saves a link\'s model only once the first pick has given it its own settings', async () => {
      modelCatalogState.checkingRevision = true;
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-2-mini' }} />);
      await waitFor(() => expect(saveCreatorDraftMock).toHaveBeenCalled());
      expect(saveCreatorDraftMock.mock.calls.at(-1)?.[2]).toMatchObject({ modelId: '' });

      modelCatalogState.extraModels = [miniWithDefaults({})];
      modelCatalogState.checkingRevision = false;
      view.rerender(<CreateVideoClient prefill={{ model: 'seedance-2-mini' }} />);
      await waitFor(() => expect(saveCreatorDraftMock.mock.calls.at(-1)?.[2])
        .toMatchObject({ modelId: 'seedance-2-mini', resolution: '480p', duration: 5 }));
    });

    it('takes the default of the revision the network confirms, not of the browser\'s stored copy', async () => {
      // The browser's copy of the catalog is from before Mini was the default.
      modelCatalogState.revision = 'kept-in-the-browser';
      modelCatalogState.checkingRevision = true;
      modelCatalogState.extraModels = [miniWithDefaults({})];
      const view = render(<CreateVideoClient prefill={{}} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The network brings the published revision a moment later.
      modelCatalogState.revision = 'mini-default-video-20261028';
      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.checkingRevision = false;
      view.rerender(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(quoteStandIn.lastRequest()?.modelId).toBe('seedance-2-mini'));
      await waitFor(() => expect(quoteStandIn.lastRequest()!.settings)
        .toMatchObject({ aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false }));
    });

    it('keeps the creator\'s settings when a later revision arrives', async () => {
      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.extraModels = [miniWithDefaults({})];
      const view = render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(quoteStandIn.lastRequest()?.settings).toMatchObject({ resolution: '480p' }));
      chooseAspectRatio('9:16');
      await waitFor(() => expect(quoteStandIn.lastRequest()!.settings).toMatchObject({ aspectRatio: '9:16' }));

      // A stale quote or the model menu refreshes the catalog.
      modelCatalogState.revision = 'a-later-release';
      view.rerender(<CreateVideoClient prefill={{}} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(quoteStandIn.lastRequest()).toMatchObject({ modelId: 'seedance-2-mini', settings: { aspectRatio: '9:16', resolution: '480p' } });
    });

    it('opens a link that names Seedance 2 Mini on its published settings, not the page\'s 720p', async () => {
      // The model page prices Mini at its defaults, 19 credits, and links here.
      modelCatalogState.extraModels = [miniWithDefaults({})];
      render(<CreateVideoClient prefill={{ model: 'seedance-2-mini' }} />);

      await waitFor(() => expect(quoteStandIn.lastRequest()?.settings).toMatchObject({ resolution: '480p', duration: 5 }));
      expect(serverCatalog.quoteGenerationModel({ ...quoteStandIn.lastRequest()!, catalogRevision: undefined }).costCredits).toBe(19);
    });

    it('never saves the stand-in model with the draft', async () => {
      // The visit ends before the catalog has picked a model: the next one takes the default.
      modelCatalogState.checkingRevision = true;
      const view = render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(saveCreatorDraftMock).toHaveBeenCalled());
      expect(saveCreatorDraftMock.mock.calls.at(-1)?.[2]).toMatchObject({ modelId: '' });

      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.extraModels = [miniWithDefaults({})];
      modelCatalogState.checkingRevision = false;
      view.rerender(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(saveCreatorDraftMock.mock.calls.at(-1)?.[2]).toMatchObject({ modelId: 'seedance-2-mini' }));
    });

    /** The network confirms the revision, whose default is Seedance 2 Mini with these defaults. */
    function confirmMiniDefault(view: ReturnType<typeof render>, defaults: Record<string, string | number | boolean> = {}) {
      modelCatalogState.videoDefault = 'seedance-2-mini';
      modelCatalogState.extraModels = [miniWithDefaults(defaults)];
      modelCatalogState.checkingRevision = false;
      view.rerender(<CreateVideoClient prefill={{}} />);
    }

    it('keeps a model the creator picks while the page waits for the revision', async () => {
      modelCatalogState.checkingRevision = true;
      modelCatalogState.summaries = videoModelSummaries;
      const view = render(<CreateVideoClient prefill={{}} />);
      chooseModel(view.container, 'Seedance 1.5 Pro');
      await waitFor(() => expect(quoteStandIn.lastRequest()?.modelId).toBe('seedance-1.5-pro'));

      confirmMiniDefault(view);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(quoteStandIn.lastRequest()?.modelId).toBe('seedance-1.5-pro');
    });

    it('keeps a setting the creator changes while the page waits, and takes the default\'s for the rest', async () => {
      modelCatalogState.checkingRevision = true;
      const view = render(<CreateVideoClient prefill={{}} />);
      chooseAspectRatio('9:16');
      await waitFor(() => expect(quoteStandIn.lastRequest()?.settings).toMatchObject({ aspectRatio: '9:16' }));

      confirmMiniDefault(view, { aspectRatio: '21:9', duration: 6 });
      await waitFor(() => expect(quoteStandIn.lastRequest()).toMatchObject({
        modelId: 'seedance-2-mini',
        settings: { aspectRatio: '9:16', resolution: '480p', duration: 6, sound: false },
      }));
    });

    it('keeps a saved draft\'s settings when a link names its model, as after the page\'s own reload', async () => {
      loadCreatorDraftMock.mockResolvedValue({
        prompt: 'A harbour at dusk',
        modelId: 'seedance-2-mini',
        mode: '',
        aspectRatio: '9:16',
        sound: true,
        resolution: '720p',
        duration: 10,
      });
      modelCatalogState.extraModels = [miniWithDefaults({})];
      render(<CreateVideoClient prefill={{ model: 'seedance-2-mini' }} />);

      // Read back first, then settled: the page's first pick must not put Mini's defaults over it.
      await waitFor(() => expect(quoteStandIn.lastRequest()?.settings).toMatchObject({ aspectRatio: '9:16' }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(quoteStandIn.lastRequest()).toMatchObject({
        modelId: 'seedance-2-mini',
        settings: { aspectRatio: '9:16', resolution: '720p', duration: 10, sound: true },
      });
    });
  });

  /**
   * References saved in the browser on one model, and a model that cannot take them.
   *
   * The browser keeps a creator's references when the model changes, so a draft can
   * hold an image, a clip or a track that the selected model has no slot for. The
   * page counted all of them (2026-10-03). Two images saved on Seedance 2 made Kling
   * 3.0 and Hailuo 2.3 references runs: the price quote refused them, Generate stayed
   * off, and the page had no card to remove the images by, while its own card said
   * they were on standby. A saved clip did the same to every model that takes none.
   *
   * Here the page reads the catalog entries the server publishes, as it does in the
   * browser once the catalog has loaded. The rest of this file leaves it on its
   * built-in table, where a saved image never made Kling 3.0 a references run, which
   * is how this went unseen. The server's own quote function prices what the page asks.
   */
  describe('references saved on another model', () => {
    type VideoModelId = Parameters<typeof serverCatalog.getVideoInputLimits>[0];
    const publishedCatalog = serverCatalog.buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
    const videoModelIds = publishedCatalog.models
      .filter((model) => model.kind === 'video')
      .map((model) => model.id as VideoModelId);
    const registry = clientModels.VIDEO_MODELS as unknown as Record<string, Record<string, unknown>>;
    let builtInTable: Record<string, Record<string, unknown>>;

    beforeEach(() => {
      builtInTable = { ...registry };
      catalogClient.applyGenerationModelCatalogToRegistries(publishedCatalog, { image: {}, video: registry, motion: {} });
    });

    afterEach(() => {
      for (const id of Object.keys(registry)) delete registry[id];
      Object.assign(registry, builtInTable);
    });

    const picture = (name: string) => new File(['image'], `${name}.png`, { type: 'image/png' });

    /** What the browser holds when the page opens. */
    function saveInTheBrowser(saved: { images?: number; clip?: boolean; clips?: number; track?: boolean; klingClip?: boolean; startFrame?: boolean }) {
      getPersistedImageElementRecordsMock.mockResolvedValue(Array.from({ length: saved.images ?? 0 }, (_, index) => ({
        id: `saved-image-${index + 1}`,
        displayName: `Saved image ${index + 1}`,
        file: picture(`saved-image-${index + 1}`),
      })));
      getPersistedMediaRecordsMock.mockImplementation(async (key: string) => {
        if (key === 'create-video:reference-videos:user-1' && (saved.clip || saved.clips)) {
          return Array.from({ length: saved.clips ?? 1 }, (_, index) => ({
            id: `saved-clip-${index + 1}`,
            displayName: index === 0 ? 'Saved clip' : `Saved clip ${index + 1}`,
            file: new File(['clip'], `saved-clip-${index + 1}.mp4`, { type: 'video/mp4' }),
            durationSeconds: 4,
          }));
        }
        if (key === 'create-video:reference-audios:user-1' && saved.track) {
          return [{ id: 'saved-track', displayName: 'Saved track', file: new File(['track'], 'saved-track.mp3', { type: 'audio/mpeg' }), durationSeconds: 6 }];
        }
        if (key === 'create-video:kling-video-elements:user-1' && saved.klingClip) {
          return [{ id: 'saved-kling-clip', displayName: 'Saved Kling clip', handle: '@saved_kling_clip', file: new File(['clip'], 'saved-kling-clip.mp4', { type: 'video/mp4' }), durationSeconds: 4 }];
        }
        return [];
      });
      if (saved.startFrame) {
        getPersistedFileMock.mockImplementation(async (key: string) => (
          key === 'create-video:start-image:user-1' ? picture('start') : null
        ));
      }
    }

    /**
     * Waits until the page has read the saved draft back and drawn itself with it. A
     * reference on standby leaves no mark on the page, so there is nothing to look for:
     * the reads resolve together, and one turn of the event loop later the page has
     * taken them in one render.
     */
    async function restored() {
      await waitFor(() => expect(getPersistedMediaRecordsMock).toHaveBeenCalledTimes(3));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    /** What the page last asked the price quote for. */
    function lastQuoteRequest() {
      const request = quoteStandIn.lastRequest();
      expect(request).toBeTruthy();
      return request as GenerationModelQuoteInput & {
        settings: Record<string, unknown>;
        inputCounts: { images: number; videos: number; audios: number };
        inputMetadata: { slots: Record<string, { count: number }> };
      };
    }

    /** How many inputs a quote request says go in a slot: a run sends nothing for an empty slot. */
    function slotCount(request: GenerationModelQuoteInput, slot: string) {
      return request.inputMetadata?.slots?.[slot]?.count ?? 0;
    }

    /** The server's answer to that request: null when it gives a price, or why it refuses. */
    function refusedByTheServer(request: GenerationModelQuoteInput) {
      try {
        // This file's catalog hook has a revision of its own; the question is the rules.
        serverCatalog.quoteGenerationModel({ ...request, catalogRevision: undefined });
        return null;
      } catch (error) {
        if (!(error instanceof serverCatalog.CatalogError)) throw error;
        return error.fieldErrors;
      }
    }

    /** What the empty canvas asks for: frames or references, as the run will use them. */
    function canvasAsksFor() {
      return screen.getByText(/^(Write (a prompt|each shot)|Add a start frame)/).textContent;
    }
    const ASKS_FOR_FRAMES = 'Write a prompt, add frames if you like, then Generate.';
    const ASKS_FOR_REFERENCES = 'Write a prompt, add references if you like, then Generate.';
    // Hailuo 2.3 has no run without its start frame.
    const ASKS_FOR_START_FRAME = 'Add a start frame and write a prompt, then Generate.';
    const ASKS_FOR_PROMPT = 'Write a prompt, then Generate.';

    /** The group that holds the start frame, and whether the page has greyed it out. */
    function frameGroupLocked(container: HTMLElement) {
      const group = container.querySelector('#video-start-frame-input')?.closest('[aria-disabled]');
      expect(group).not.toBeNull();
      return group!.getAttribute('aria-disabled') === 'true';
    }

    function runInputs(slot: string) {
      return (postedRun()?.inputs ?? []).filter((input: { slot: string }) => input.slot === slot);
    }

    /** The references the standby card offers to take off, by name. */
    function standbyChips() {
      return Array.from(screen.queryByRole('list', { name: 'References on standby' })?.querySelectorAll('li') ?? [])
        .map((chip) => chip.textContent);
    }

    /** What the standby card says under its title, or null where the page shows no such card. */
    function standbyCard() {
      const title = screen.queryByText('Saved references are on standby');
      return title
        ? Array.from(title.parentElement?.querySelectorAll('p') ?? []).slice(1).map((line) => line.textContent)
        : null;
    }

    it.each(videoModelIds)('%s: asks the quote for what the model takes of a saved image, clip, track and Kling clip', async (modelId) => {
      // One of each kind the browser keeps, so within what any model takes of a kind it
      // has a slot for. Hailuo 2.3 animates a start image and has no run without one.
      saveInTheBrowser({ images: 1, clip: true, track: true, klingClip: true, startFrame: modelId === 'hailuo-2.3' });
      render(<CreateVideoClient prefill={{ model: modelId }} />);
      await restored();

      const request = lastQuoteRequest();
      const limits = serverCatalog.getVideoInputLimits(modelId);
      // Kling 3.0's clips are its named video elements, a slot of their own.
      const takesClips = limits.videos > 0 && modelId !== 'kling-3.0-video';
      const carried = {
        imageReferences: limits.images > 0 ? 1 : 0,
        videoReferences: takesClips ? 1 : 0,
        audioReferences: limits.audios > 0 ? 1 : 0,
        videoElements: modelId === 'kling-3.0-video' ? 1 : 0,
      };

      expect({
        imageReferences: slotCount(request, 'imageReferences'),
        videoReferences: slotCount(request, 'videoReferences'),
        audioReferences: slotCount(request, 'audioReferences'),
        videoElements: slotCount(request, 'videoElements'),
      }).toEqual(carried);
      expect(request.inputCounts.videos).toBe(carried.videoReferences + carried.videoElements);
      expect(request.inputCounts.audios).toBe(carried.audioReferences);
      const carriesAReference = carried.imageReferences + carried.videoReferences + carried.audioReferences > 0;
      expect(request.settings.referenceMode).toBe(carriesAReference || !limits.startFrame ? 'elements' : 'frames');
      // And the server gives that request a price.
      expect(refusedByTheServer(request)).toBeNull();
    });

    it('checks that against models of every kind', () => {
      // A list with no model that takes nothing, or none that takes everything, would
      // let the test above pass without proving anything.
      const takes = (modelId: VideoModelId) => {
        const limits = serverCatalog.getVideoInputLimits(modelId);
        return `${limits.images > 0 ? 'images' : '-'} ${limits.videos > 0 && modelId !== 'kling-3.0-video' ? 'clips' : '-'} ${limits.audios > 0 ? 'tracks' : '-'}`;
      };

      expect(videoModelIds.filter((modelId) => takes(modelId) === '- - -').sort()).toEqual(['hailuo-2.3', 'kling-3.0-turbo', 'kling-3.0-video']);
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images - -').length).toBeGreaterThan(2);
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images clips -')).toEqual(['gemini-omni-video', 'gemini-omni-1.1-flash']);
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images clips tracks').length).toBeGreaterThan(2);
    });

    it('makes a frames run on Kling 3.0 while two saved images are on standby, and says so', async () => {
      saveInTheBrowser({ images: 2, startFrame: true });
      const view = render(<CreateVideoClient prefill={{}} />);
      await screen.findByText('Saved references are on standby');
      await restored();

      // The request is the one the page makes with nothing saved: a frame, no reference.
      const request = lastQuoteRequest();
      expect(request.settings.referenceMode).toBe('frames');
      expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
      expect(slotCount(request, 'imageReferences')).toBe(0);
      expect(slotCount(request, 'startFrame')).toBe(1);
      expect(refusedByTheServer(request)).toBeNull();

      // The canvas asks for what the standby card says the run takes: frames, not references.
      expect(canvasAsksFor()).toBe(ASKS_FOR_FRAMES);
      expect(slotCount(request, 'videoElements')).toBe(0);
      // Nothing by the prompt speaks of references the run does not use.
      expect(screen.queryByText(/Upload reference images below/)).toBeNull();
      const enhance = enhanceButtonPropsMock.mock.calls.at(-1)?.[0] as { helperText?: string; context?: EnhancerContext } | undefined;
      expect(enhance?.helperText).toBeUndefined();
      expect(enhance?.context).toMatchObject({ referenceImageCount: 0, hasStartImage: true });
      expect(view.container.querySelectorAll('input[placeholder="Rename element"]')).toHaveLength(0);

      // The run sends the frame and neither of the saved images.
      fireEvent.change(screen.getByPlaceholderText(/^Describe the Kling 3\.0 Cinematic scene/), {
        target: { value: 'A harbour at dusk, a slow push in over the water as the lamps come on along the quay.' },
      });
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedRun()).toBeDefined());

      expect(postedRun().settings.referenceMode).toBe('frames');
      expect(runInputs('startFrame')).toHaveLength(1);
      expect(runInputs('imageReferences')).toHaveLength(0);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      expect(temporaryUploadMock.mock.calls[0][0]).toMatchObject({ name: 'start.png' });
    });

    it('asks for the start frame Hailuo 2.3 cannot run without, until one is added', async () => {
      saveInTheBrowser({});
      const view = render(<CreateVideoClient prefill={{ model: 'hailuo-2.3' }} />);
      await restored();

      expect(canvasAsksFor()).toBe(ASKS_FOR_START_FRAME);
      fireEvent.change(view.container.querySelector<HTMLInputElement>('#video-start-frame-input')!, {
        target: { files: [picture('start')] },
      });
      await waitFor(() => expect(canvasAsksFor()).toBe(ASKS_FOR_PROMPT));
    });

    it.each(['kling-3.0-turbo', 'hailuo-2.3'] as const)('makes a frames run on %s while two saved images are on standby', async (modelId) => {
      saveInTheBrowser({ images: 2, startFrame: true });
      render(<CreateVideoClient prefill={{ model: modelId }} />);
      await screen.findByText('Saved references are on standby');
      await restored();

      const request = lastQuoteRequest();
      expect(request.settings.referenceMode).toBe('frames');
      expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
      expect(refusedByTheServer(request)).toBeNull();
      // Hailuo's start frame is already there, so the canvas asks only for the prompt.
      expect(canvasAsksFor()).toBe(modelId === 'hailuo-2.3' ? ASKS_FOR_PROMPT : ASKS_FOR_FRAMES);
      expect(slotCount(request, 'startFrame')).toBe(1);
    });

    it('leaves the frames of Seedance 1.5 Pro free while a saved clip and track are on standby', async () => {
      // The model takes two images and no clip. The saved clip greyed the frames out
      // under "Clear your references", on a page with no card for a clip.
      saveInTheBrowser({ clip: true, track: true });
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await screen.findByText('Frames or references');
      await restored();

      expect(frameGroupLocked(view.container)).toBe(false);
      expect(screen.getByText(/takes either frames or references in a single run/)).toBeInTheDocument();
      expect(canvasAsksFor()).toBe(ASKS_FOR_FRAMES);
      expect(slotCount(lastQuoteRequest(), 'startFrame')).toBe(0);
      expect(lastQuoteRequest().settings.referenceMode).toBe('frames');

      // A frame attached now locks the references, as on a draft that holds no clip.
      fireEvent.change(view.container.querySelector<HTMLInputElement>('#video-start-frame-input')!, {
        target: { files: [picture('start')] },
      });
      expect(await screen.findByText(/cannot combine references with frames\. Clear your frames/)).toBeInTheDocument();
      await waitFor(() => expect(slotCount(lastQuoteRequest(), 'startFrame')).toBe(1));
      // Locked for the keyboard too: the add tile's file field is off, not just greyed.
      expect(screen.getByText('Add reference images').closest('label')?.querySelector('input[type="file"]')).toBeDisabled();
    });

    it('counts the image and not the clip in a references run on Seedance 1.5 Pro', async () => {
      saveInTheBrowser({ images: 1, clip: true, track: true });
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await screen.findByPlaceholderText('Rename element');
      await restored();

      expect(canvasAsksFor()).toBe(ASKS_FOR_REFERENCES);
      // The reference holds the run, so the frames are locked, for the keyboard too.
      expect(frameGroupLocked(view.container)).toBe(true);
      expect(view.container.querySelector('#video-start-frame-input')).toBeDisabled();
      const request = lastQuoteRequest();
      expect(slotCount(request, 'imageReferences')).toBe(1);
      expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
      expect(refusedByTheServer(request)).toBeNull();
    });

    it('sends the image and the clip on Gemini Omni, and leaves a saved track out', async () => {
      // Gemini Omni takes images and one clip, and no track. Its page has no card for a
      // track, and Generate answered "supports up to 0 reference audio files per run".
      saveInTheBrowser({ images: 1, clip: true, track: true });
      render(<CreateVideoClient prefill={{ model: 'gemini-omni-video' }} />);
      await screen.findByPlaceholderText('Rename element');
      await restored();

      expect(screen.getByText('Saved clip')).toBeInTheDocument();
      // The track is offered only on the standby card, where it can be taken off.
      expect(standbyChips()).toEqual(['Saved track']);
      expect(screen.queryByRole('heading', { name: 'Video and audio references' })).toBeNull();
      expect(slotCount(lastQuoteRequest(), 'imageReferences') + slotCount(lastQuoteRequest(), 'videoReferences')).toBe(2);
      expect(refusedByTheServer(lastQuoteRequest())).toBeNull();

      fireEvent.change(screen.getByPlaceholderText(/^Describe the Gemini Omni Video scene/), {
        target: { value: 'A dancer crosses a bright studio in the rhythm of the reference clip, slow push in, soft daylight.' },
      });
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedRun()).toBeDefined());

      expect(runInputs('imageReferences')).toHaveLength(1);
      expect(runInputs('videoReferences')).toHaveLength(1);
      expect(runInputs('audioReferences')).toHaveLength(0);
    });

    it('keeps Kling O3 a frames run in multi-shot, where the page says saved images are paused', async () => {
      saveInTheBrowser({ images: 1, startFrame: true });
      const view = render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);
      await screen.findByPlaceholderText('Rename element');
      await restored();
      // Single-shot first: the image is in the run, and the saved frame is the odd one out.
      expect(lastQuoteRequest().settings.referenceMode).toBe('elements');

      chooseMultiShot();
      await screen.findByText('Reusable references are paused in multi-shot');

      const request = lastQuoteRequest();
      expect(request.settings.referenceMode).toBe('frames');
      expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
      expect(slotCount(request, 'imageReferences')).toBe(0);
      expect(refusedByTheServer(request)).toBeNull();
      expect(frameGroupLocked(view.container)).toBe(false);

      fireEvent.change(screen.getByPlaceholderText('Describe shot 1...'), {
        target: { value: 'A lighthouse keeper climbs the stairs with a lamp, the camera rising with him, warm light on stone.' },
      });
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedRun()).toBeDefined());

      expect(postedRun().settings.referenceMode).toBe('frames');
      expect(runInputs('startFrame')).toHaveLength(1);
      expect(runInputs('imageReferences')).toHaveLength(0);
    });

    it('runs the named subjects of Kling O3 while a saved clip is on standby', async () => {
      // Kling O3 takes no clip. The saved one made the run a references run, which named
      // subjects replace, so Generate asked the creator to remove what the page did not show.
      saveInTheBrowser({ clip: true });
      getPersistedSubjectRecordsMock.mockResolvedValue([{
        id: 'subject-1',
        displayName: 'Hero creator',
        images: [
          { id: 'image-1', file: picture('front') },
          { id: 'image-2', file: picture('side') },
        ],
      }]);
      render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);
      await screen.findByDisplayValue('Hero creator');
      await restored();

      const request = lastQuoteRequest();
      expect(request.settings.referenceMode).toBe('subjects');
      expect(request.inputCounts).toMatchObject({ images: 2, videos: 0, audios: 0 });
      expect(slotCount(request, 'videoReferences')).toBe(0);

      fireEvent.change(screen.getByPlaceholderText(/^Describe the Kling O3 scene/), {
        target: { value: '@hero_creator lifts the serum and smiles at the camera in a bright studio, slow push in.' },
      });
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedRun()).toBeDefined());

      expect(postedRun().settings.referenceMode).toBe('subjects');
      expect(runInputs('subjectImages')).toHaveLength(2);
      expect(runInputs('videoReferences')).toHaveLength(0);
      expect(postedRun().expectedCostCredits).toBe(12);
    });

    it('names every saved image the prompt mentions, under the prompt and when Generate refuses it', async () => {
      // With images left out of the run, a prompt that mentions one reaches Generate on a
      // model that takes none. The model's reason alone did not say which word stopped it.
      saveInTheBrowser({ images: 2, startFrame: true });
      const view = render(<CreateVideoClient prefill={{}} />);
      await screen.findByText('Saved references are on standby');
      await restored();

      const promptBox = screen.getByPlaceholderText(/^Describe the Kling 3\.0 Cinematic scene/);
      const prompt = 'A harbour at dusk where @saved_image_1 meets @saved_image_2 by the water, slow push in.';
      fireEvent.change(promptBox, { target: { value: prompt } });

      expect(Array.from(promptBox.nextElementSibling?.children ?? []).map((part) => part.textContent)).toEqual([
        `${prompt.length} / 2,500`,
        'On standby here: @saved_image_1, @saved_image_2',
      ]);

      fireEvent.click(generateButton());

      expect(view.container.querySelector('p.text-red-400')?.textContent)
        .toBe('Kling 3.0 Cinematic cannot use @saved_image_1, @saved_image_2. Remove them from the prompt, or pick a model that takes reusable references.');
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(postedRun()).toBeUndefined();
    });

    it('says on the standby card that a saved clip and track are not used', async () => {
      // The card spoke for images only, so a clip saved on another model was left out of
      // a run without a word.
      saveInTheBrowser({ clip: true, track: true });
      render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await screen.findByText('Saved references are on standby');
      await restored();

      expect(standbyCard()).toEqual([
        'Your saved clip and track stay saved. Seedance 1.5 Pro takes no reference clip or track, so this run does not use them.',
      ]);
    });

    it.each([
      {
        saved: { clips: 2 },
        model: 'kling-o3',
        says: 'Your saved clips stay saved. Kling O3 takes no reference clip, so this run does not use them.',
      },
      {
        saved: { clip: true, track: true },
        model: 'gemini-omni-video',
        says: 'Your saved track stays saved. Gemini Omni Video takes no reference track, so this run does not use it.',
      },
      {
        saved: { clip: true },
        model: 'hailuo-2.3',
        says: 'Your saved clip stays saved. Hailuo 2.3 takes no reference clip, so this run does not use it.',
      },
    ] as const)('says it of what $model does not take', async ({ saved, model, says }) => {
      saveInTheBrowser(saved);
      render(<CreateVideoClient prefill={{ model }} />);
      await screen.findByText('Saved references are on standby');
      await restored();

      expect(standbyCard()).toEqual([says]);
    });

    it('speaks for saved images and a saved clip on one card', async () => {
      saveInTheBrowser({ images: 2, clip: true });
      render(<CreateVideoClient prefill={{}} />);
      await screen.findByText('Saved references are on standby');
      await restored();

      expect(standbyCard()).toEqual([
        'Your 2 saved image references remain available. Reusable references are not available for this model yet. Use start / end frames for this run, or choose a supported single-shot mode to use reusable references.',
        'Your saved clip stays saved. Kling 3.0 Cinematic takes no reference clip, so this run does not use it.',
      ]);
      expect(screen.getAllByText('Saved references are on standby')).toHaveLength(1);
    });

    it('shows no standby card on a model that takes what is saved', async () => {
      saveInTheBrowser({ images: 1, clip: true, track: true });
      render(<CreateVideoClient prefill={{ model: 'wan-2.7' }} />);
      await screen.findByPlaceholderText('Rename element');
      await restored();

      expect(screen.getByText('Saved clip')).toBeInTheDocument();
      expect(standbyCard()).toBeNull();
    });

    /**
     * The price is the server's own quote of the run the page sends. The server quotes a
     * run again from the inputs it posts when it starts it, every input counted by its
     * kind, and charges or refuses that quote. The page counted inputs by the part each
     * plays, so Wan 2.7's start frame, sent beside five references, was left out of an
     * 80-credit quote and the start refused the run for its sixth image (2026-10-18).
     */
    describe('the price of the run the page sends', () => {
      const runPrompt = 'A dancer crosses a bright studio in the rhythm of the references, slow push in, soft daylight.';

      /** The page's last quote request, less the catalog revision this file's hook makes up. */
      function shownQuote() {
        const { catalogRevision: _revision, ...quote } = lastQuoteRequest();
        void _revision;
        return quote;
      }

      /** What the server quotes when it starts the run the page posted, less the revision. */
      function startQuote() {
        const { catalogRevision: _revision, ...quote } = buildUnifiedGenerationQuoteInput(parseUnifiedGenerationRequest(postedRun()));
        void _revision;
        return quote;
      }

      async function generate() {
        fireEvent.change(screen.getByPlaceholderText(/^Describe the .+ scene in rich cinematic detail/), {
          target: { value: runPrompt },
        });
        fireEvent.click(generateButton());
        await waitFor(() => expect(postedRun()).toBeDefined());
      }

      it("counts Wan 2.7's start frame beside five reference images as the run's sixth image", async () => {
        saveInTheBrowser({ images: 5, startFrame: true });
        render(<CreateVideoClient prefill={{ model: 'wan-2.7' }} />);
        await screen.findAllByPlaceholderText('Rename element');
        await restored();

        const shown = shownQuote();
        expect(shown.inputCounts).toMatchObject({ images: 6, videos: 0, audios: 0 });
        expect(shown.inputMetadata?.slots).toMatchObject({ imageReferences: { count: 5 }, startFrame: { count: 1 } });

        await generate();

        expect(runInputs('imageReferences')).toHaveLength(5);
        expect(runInputs('startFrame')).toHaveLength(1);
        // The request the page priced is the one the start prices, so the price on the
        // button, or the refusal under it, is the start's own answer.
        expect(shown).toEqual(startQuote());
        // And the run carries it: its own quote input is the request that was priced.
        expect(postedRun().expectedCostCredits).toBe(12);
      });

      it("counts Wan 2.7's start frame beside five reference clips as an image of the run", async () => {
        saveInTheBrowser({ clips: 5, startFrame: true });
        render(<CreateVideoClient prefill={{ model: 'wan-2.7' }} />);
        await screen.findByText('Saved clip 5');
        await restored();

        const shown = shownQuote();
        expect(shown.inputCounts).toMatchObject({ images: 1, videos: 5, audios: 0 });
        expect(shown.inputMetadata?.slots).toMatchObject({
          videoReferences: { count: 5, durationsSeconds: [4, 4, 4, 4, 4] },
          startFrame: { count: 1 },
        });

        await generate();

        expect(runInputs('videoReferences')).toHaveLength(5);
        expect(runInputs('startFrame')).toHaveLength(1);
        expect(shown).toEqual(startQuote());
        expect(postedRun().expectedCostCredits).toBe(12);
      });

      it.each(videoModelIds)('%s: prices exactly the run it sends of a saved image, clip, track, Kling clip and start frame', async (modelId) => {
        saveInTheBrowser({ images: 1, clip: true, track: true, klingClip: true, startFrame: true });
        render(<CreateVideoClient prefill={{ model: modelId }} />);
        await restored();

        const shown = shownQuote();
        // A frame the run leaves out is no part of its price either. Counted, a saved frame
        // had the quote refuse the references run of a model that takes frames or
        // references, and any run of Gemini Omni, which takes no frame, while the start
        // took those runs.
        expect(refusedByTheServer(lastQuoteRequest())).toBeNull();
        await generate();

        expect(shown).toEqual(startQuote());
        // The run's own quote input is the request that was priced, so the price goes with it.
        expect(postedRun().expectedCostCredits).toBe(12);
      });
    });

    it('leaves the frames of another model free after a character id was added on Gemini Omni', async () => {
      // The id stays in the page when the model changes, and only Gemini Omni shows it.
      modelCatalogState.summaries = videoModelSummaries;
      const view = render(<CreateVideoClient prefill={{ model: 'gemini-omni-video' }} />);
      const field = await screen.findByLabelText('Gemini Omni character ID');
      fireEvent.change(field, { target: { value: 'character-0001' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(await screen.findByText('character-0001')).toBeInTheDocument();

      chooseModel(view.container, 'Seedance 1.5 Pro');
      await screen.findByText('Frames or references');

      expect(screen.queryByText('character-0001')).toBeNull();
      expect(frameGroupLocked(view.container)).toBe(false);
      expect(screen.getByText(/takes either frames or references in a single run/)).toBeInTheDocument();
      expect(lastQuoteRequest().settings.referenceMode).toBe('frames');
    });
  });

  /**
   * What the page does around a start. A start keeps one key until an answer says
   * whether it started (each press used to mint a new one, so a lost answer was paid
   * for twice); a status check rides out a blip; a newer deploy is watched for while
   * the page is idle; the prompt and settings outlive a reload; a file is uploaded once
   * for many presses; and each refusal leads to what the creator can do about it.
   */
  describe('the start, the run and the draft', () => {
    const PROMPT = 'A harbour at dusk, a slow push in over the water as the lamps come on along the quay.';
    const clipInput = 'input[type="file"][accept="video/*"]';

    function promptBox() {
      return screen.getByPlaceholderText(/^Describe the .+ scene in rich cinematic detail/);
    }

    /** The price Generate names, or why it waits ("Calculating...", "Unavailable"). */
    /** Every start the page sent, as its key and its body. */
    function postedStarts(): Array<{ key: string | null; body: { inputs: Array<Record<string, unknown>>; settings: Record<string, unknown>; shots: unknown[]; expectedCostCredits?: unknown } }> {
      return fetchMock.mock.calls
        .filter(([input, init]) => String(input).includes('/api/generations') && init?.method === 'POST')
        .map(([, init]) => ({
          key: new Headers(init?.headers).get('Idempotency-Key'),
          body: JSON.parse(String(init?.body)),
        }));
    }

    function statusChecks() {
      return fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/generate-video?id='));
    }

    /** Each start the page sends takes the next answer; anything else gets the page's own. */
    function answerStarts(...answers: Array<() => Promise<Response>>) {
      const queue = [...answers];
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
        String(input).includes('/api/generations') && init?.method === 'POST' && queue.length > 0
          ? queue.shift()!()
          : defaultResponse(input, init)
      ));
    }

    const refusal = (status: number, body: Record<string, unknown>) => async () => (
      { ok: false, status, json: async () => body } as Response
    );

    /** The `credits_updated` events that ask for the balance to be read again (they carry no balance). */
    function watchBalanceRereads() {
      const rereads: Event[] = [];
      const listener = (event: Event) => {
        if (!(event instanceof CustomEvent && event.detail)) rereads.push(event);
      };
      window.addEventListener('credits_updated', listener);
      return { rereads, stop: () => window.removeEventListener('credits_updated', listener) };
    }

    async function attachClip(container: HTMLElement, file: File) {
      fireEvent.change(container.querySelector<HTMLInputElement>(clipInput)!, { target: { files: [file] } });
      expect(await screen.findByText('Video reference 1')).toBeInTheDocument();
    }

    it('keeps the key of a start that got no answer, and Check again sends that key and body once more', async () => {
      answerStarts(async () => {
        throw new TypeError('Failed to fetch');
      });
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      expect(await screen.findByText('We couldn’t confirm your generation started. Check again — that can’t start a second run.')).toBeInTheDocument();
      const [first] = postedStarts();
      expect(first.body.expectedCostCredits).toBe(12);
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toMatchObject({ idempotencyKey: first.key, body: { prompt: PROMPT, expectedCostCredits: 12 } });
      // Nothing on the page can start a second run while this one is unanswered.
      expect(queryGenerateButton()).toBeNull();

      // The price moves meanwhile. Checking again is the same attempt, so it goes with the
      // price it was sent with: another body under the same key is refused as a reused key.
      quoteStandIn.answers = [15];
      fireEvent.change(promptBox(), { target: { value: `${PROMPT} The water stays calm.` } });
      expect(screen.getByRole('button', { name: 'Start a new run · 15 credits' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      const starts = postedStarts();
      expect(starts).toHaveLength(2);
      expect(starts[1].key).toBe(first.key);
      expect(starts[1].body).toEqual(first.body);
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();
      expect(screen.queryByText(/couldn’t confirm/)).toBeNull();
    });

    it('stops watching for a newer build while a start is out, so no reload can cut it off', async () => {
      let answer: (response: Response) => void = () => undefined;
      answerStarts(() => new Promise<Response>((resolve) => {
        answer = resolve;
      }));
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(deployState.enabled.at(-1)).toBe(true));
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      await waitFor(() => expect(postedStarts()).toHaveLength(1));
      await waitFor(() => expect(deployState.enabled.at(-1)).toBe(false));

      answer({ ok: true, status: 200, json: async () => startedRunBody() } as Response);
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      await waitFor(() => expect(deployState.enabled.at(-1)).toBe(true));
    });

    it('lets the creator give up on an unanswered start and start a new run under a new key', async () => {
      answerStarts(refusal(504, {}));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());
      await screen.findByRole('button', { name: 'Check again' });

      // Priced on its button: the unanswered start may yet have started.
      fireEvent.click(screen.getByRole('button', { name: 'Start a new run · 12 credits' }));

      await waitFor(() => expect(postedStarts()).toHaveLength(2));
      expect(postedStarts()[1].key).not.toBe(postedStarts()[0].key);
      expect(postedStarts()[1].body.expectedCostCredits).toBe(12);
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();
    });

    it('drops the key of a refused start, and puts the cursor back in the prompt the server refused', async () => {
      answerStarts(refusal(422, { code: 'INVALID_GENERATION_REQUEST', error: 'Shot 1 is too long.' }));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      expect(await screen.findByText('Shot 1 is too long.')).toBeInTheDocument();
      expect(promptBox()).toHaveFocus();
      expect(screen.queryByText(/couldn’t confirm/)).toBeNull();
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();

      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(2));
      expect(postedStarts()[1].key).not.toBe(postedStarts()[0].key);
    });

    it('puts the cursor back in the prompt when the server blocks it', async () => {
      answerStarts(refusal(422, { code: 'prompt_blocked', error: 'This prompt can’t be used. Edit it and try again.' }));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      expect(await screen.findByText('This prompt can’t be used. Edit it and try again.')).toBeInTheDocument();
      expect(promptBox()).toHaveFocus();
    });

    // The body is sent as it was saved, whatever the price shows now: with the price it was
    // sent with, or with none from a page before prices were sent.
    it.each([
      ['with no price', {}],
      ['with the price it was sent with', { expectedCostCredits: 9 }],
    ])('replays a start this tab never heard back from when the page opens, %s, before looking for a running one', async (_case, price) => {
      const body = {
        kind: 'video',
        modelId: 'kling-3.0-video',
        catalogRevision: 'test-catalog-rev',
        prompt: PROMPT,
        shots: [],
        settings: { duration: 5 },
        inputs: [],
        ...price,
      };
      catalogClient.savePendingWebStart({
        version: 1,
        tool: 'video',
        idempotencyKey: 'video:kept-key',
        body,
        catalogRevision: 'test-catalog-rev',
        createdAt: new Date().toISOString(),
        userId: 'user-1',
      });

      render(<CreateVideoClient prefill={{}} />);

      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      expect(postedStarts()).toEqual([{ key: 'video:kept-key', body: { schemaVersion: 3, ...body } }]);
      expect(maybeSingleMock).not.toHaveBeenCalled();
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();
    });

    it('does not replay a start another account left in this tab', async () => {
      catalogClient.savePendingWebStart({
        version: 1,
        tool: 'video',
        idempotencyKey: 'video:their-key',
        body: { kind: 'video', modelId: 'kling-3.0-video', catalogRevision: 'test-catalog-rev', prompt: PROMPT, settings: {} },
        catalogRevision: 'test-catalog-rev',
        createdAt: new Date().toISOString(),
        userId: 'user-2',
      });

      render(<CreateVideoClient prefill={{}} />);

      await waitFor(() => expect(maybeSingleMock).toHaveBeenCalled());
      expect(postedStarts()).toEqual([]);
    });

    it('hands a run whose status checks keep failing to the background view, after trying again', async () => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
        String(input).includes('/api/generate-video?id=')
          ? { ok: false, status: 500, json: async () => ({ error: 'Failed to fetch generation status' }) } as Response
          : defaultResponse(input, init)
      ));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      const getSession = vi.mocked(supabase.auth.getSession);
      await waitFor(() => expect(maybeSingleMock).toHaveBeenCalled());

      vi.useFakeTimers();
      try {
        fireEvent.click(generateButton());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        const sessionReadsAtStart = getSession.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(statusChecks()).toHaveLength(4);
        // The token is read again for every check: a run can outlive the one it started with.
        expect(getSession.mock.calls.length - sessionReadsAtStart).toBeGreaterThanOrEqual(3);
        expect(screen.queryByText('Failed to fetch generation status')).toBeNull();
        expect(screen.getAllByText('Video still processing').length).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rides out one failed status check and shows the result', async () => {
      let checks = 0;
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/api/generate-video?id=')) {
          checks += 1;
          if (checks === 1) return { ok: false, status: 503, json: async () => ({}) } as Response;
        }
        return defaultResponse(input, init);
      });
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      await waitFor(() => expect(maybeSingleMock).toHaveBeenCalled());

      vi.useFakeTimers();
      try {
        fireEvent.click(generateButton());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
        expect(checks).toBe(2);
        expect(screen.getByRole('link', { name: 'Download video' })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says a failed run returned its credits, and reads the balance again', async () => {
      const balance = watchBalanceRereads();
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
        String(input).includes('/api/generate-video?id=')
          ? { ok: true, status: 200, json: async () => ({ status: 'failed', error: 'The provider could not render this prompt.' }) } as Response
          : defaultResponse(input, init)
      ));
      try {
        render(<CreateVideoClient prefill={{}} />);
        fireEvent.change(promptBox(), { target: { value: PROMPT } });
        fireEvent.click(generateButton());

        expect(await screen.findByText('The provider could not render this prompt. Your 12 credits were returned.')).toBeInTheDocument();
        expect(balance.rereads.length).toBeGreaterThan(0);
      } finally {
        balance.stop();
      }
    });

    it('offers a top-up when the server says the credits are short, and reads the balance again', async () => {
      const balance = watchBalanceRereads();
      answerStarts(refusal(402, { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 12 credits.' }));
      try {
        render(<CreateVideoClient prefill={{}} />);
        fireEvent.change(promptBox(), { target: { value: PROMPT } });
        fireEvent.click(generateButton());

        expect(await screen.findByText('Insufficient credits. This action costs 12 credits.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Top Up Credits/ })).toHaveAttribute('href', '/pricing');
        expect(queryGenerateButton()).toBeNull();
        expect(balance.rereads.length).toBeGreaterThan(0);
        expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();
      } finally {
        balance.stop();
      }
    });

    it('watches for a newer build while idle, and at the press saves the draft and reloads instead of sending', async () => {
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(deployState.enabled.at(-1)).toBe(true));
      await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalled());

      deployState.newBuildAvailable = true;
      // The change draws the page again, which reads the new answer.
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      // jsdom does not navigate: it reports each navigation it was asked for, a reload
      // included, as not implemented.
      const { virtualConsole } = (globalThis as unknown as {
        jsdom: { virtualConsole: { on: (event: string, listener: (error: Error) => void) => void; off: (event: string, listener: (error: Error) => void) => void } };
      }).jsdom;
      const navigations: string[] = [];
      const onJsdomError = (jsdomError: Error) => {
        if (/navigation/i.test(jsdomError.message)) navigations.push(jsdomError.message);
      };
      virtualConsole.on('jsdomError', onJsdomError);
      try {
        fireEvent.click(generateButton());

        // Saved at the press, ahead of the half-second wait of an ordinary save.
        await waitFor(
          () => expect(saveCreatorDraftMock).toHaveBeenCalledWith('video', 'user-1', expect.objectContaining({ prompt: PROMPT })),
          { timeout: 300 },
        );
        await waitFor(() => expect(navigations).toHaveLength(1));
        expect(postedStarts()).toEqual([]);
        expect(temporaryUploadMock).not.toHaveBeenCalled();
      } finally {
        virtualConsole.off('jsdomError', onJsdomError);
      }
    });

    it('sends a lapsed session to sign in on this page’s own link, with the draft saved under the account', async () => {
      window.history.replaceState({}, '', '/create-video?model=seedance-1.5-pro&prompt=harbour');
      try {
        render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
        await waitFor(() => expect(maybeSingleMock).toHaveBeenCalled());
        await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalled());
        vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({ data: { session: null }, error: null } as never);
        fireEvent.change(promptBox(), { target: { value: PROMPT } });
        fireEvent.click(generateButton());

        // Not the visitor's sheet: its hand-over would move the visitor slot over this
        // account's draft.
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith(
          `/login?returnUrl=${encodeURIComponent('/create-video?model=seedance-1.5-pro&prompt=harbour')}`,
        ));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(saveCreatorDraftMock).toHaveBeenCalledWith('video', 'user-1', expect.objectContaining({ prompt: PROMPT }));
        expect(postedStarts()).toEqual([]);
      } finally {
        window.history.replaceState({}, '', '/');
      }
    });

    it('lets a signed-out visitor set up a run, and asks for an account at Generate with the draft kept for them', async () => {
      authState.signedIn = false;
      const view = render(<CreateVideoClient prefill={{}} visitorWelcomeCredits={25} />);
      // The visitor's own draft is read back, as an account's is.
      await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('video', 'visitor'));

      expect(screen.getByText('Try it before you sign up')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Studio/ })).not.toBeInTheDocument();
      expect(view.container.querySelector('[data-creator-bar-note]')).toHaveTextContent('New accounts get 25 free credits');

      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign up to generate' }));

      expect(await screen.findByRole('dialog', { name: 'Continue to generate' })).toBeInTheDocument();
      expect(saveCreatorDraftMock).toHaveBeenCalledWith('video', 'visitor', expect.objectContaining({ prompt: PROMPT }));
      expect(postedStarts()).toEqual([]);
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('never saves an account’s form into the browser’s visitor slot once its session ends on the page', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const view = render(<CreateVideoClient prefill={{}} />);
        await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('video', 'user-1'));
        fireEvent.change(promptBox(), { target: { value: PROMPT } });

        // Signed out from the account menu, or in another tab: the page stays open.
        authState.signedIn = false;
        view.rerender(<CreateVideoClient prefill={{}} />);
        // Not a visitor's page: no sheet that would promise a form nothing saves any more.
        expect(screen.queryByRole('button', { name: 'Sign up to generate' })).not.toBeInTheDocument();
        fireEvent.change(promptBox(), { target: { value: `${PROMPT} Edited after signing out.` } });
        await act(async () => {
          vi.advanceTimersByTime(2000);
        });
        view.unmount();

        expect(saveCreatorDraftMock.mock.calls.some(([, owner]) => owner === 'visitor')).toBe(false);
        expect(loadCreatorDraftMock).not.toHaveBeenCalledWith('video', 'visitor');
      } finally {
        vi.useRealTimers();
      }
    });

    it('checks a visitor’s form as Generate does before asking for an account', async () => {
      authState.signedIn = false;
      render(<CreateVideoClient prefill={{}} visitorWelcomeCredits={25} />);
      await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('video', 'visitor'));

      fireEvent.click(screen.getByRole('button', { name: 'Sign up to generate' }));

      expect(await screen.findByText('Please enter a prompt')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('asks a visitor for an account at Enhance, which spends credits', async () => {
      authState.signedIn = false;
      render(<CreateVideoClient prefill={{}} visitorWelcomeCredits={25} />);
      await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('video', 'visitor'));

      const props = enhanceButtonPropsMock.mock.calls.at(-1)?.[0] as { onRequireAccount?: () => void };
      expect(props.onRequireAccount).toBeInstanceOf(Function);
      act(() => props.onRequireAccount?.());

      expect(await screen.findByRole('dialog', { name: 'Continue to enhance your prompt' })).toBeInTheDocument();
    });

    it('greets an account back from the sign-up it opened here', async () => {
      render(<CreateVideoClient prefill={{}} welcome={{ referral: null }} />);
      // The card asks the welcome credits route for this account's status.
      await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/credits/welcome')).toBe(true));
      // A signed-in Generate keeps its own face and price.
      expect(screen.queryByRole('button', { name: 'Sign up to generate' })).not.toBeInTheDocument();
      expect(enhanceButtonPropsMock.mock.calls.at(-1)?.[0]).toMatchObject({ onRequireAccount: undefined });
    });

    it('saves the prompt and settings for the account, and brings them back before the catalog picks a model', async () => {
      const first = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      chooseAspectRatio('9:16');
      await waitFor(() => expect(saveCreatorDraftMock).toHaveBeenCalledWith('video', 'user-1', expect.objectContaining({
        prompt: PROMPT,
        modelId: 'seedance-1.5-pro',
        aspectRatio: '9:16',
      })));
      const saved = saveCreatorDraftMock.mock.calls.at(-1)?.[2];
      first.unmount();

      // The next visit, on a link that names no model: the catalog's default is Kling 3.0.
      loadCreatorDraftMock.mockResolvedValue(saved);
      render(<CreateVideoClient prefill={{}} />);

      await waitFor(() => expect(promptBox()).toHaveValue(PROMPT));
      expect(screen.getByPlaceholderText('Describe the Seedance 1.5 Pro scene in rich cinematic detail...')).toBeInTheDocument();
      await waitFor(() => expect(quoteStandIn.lastRequest()).toMatchObject({
        modelId: 'seedance-1.5-pro',
        settings: { aspectRatio: '9:16' },
      }));
    });

    it('lets a link’s own prompt win over the saved one, and keeps the rest of the draft', async () => {
      loadCreatorDraftMock.mockResolvedValue({
        prompt: 'The saved prompt',
        modelId: 'seedance-1.5-pro',
        aspectRatio: '9:16',
        isMultiShot: false,
        shots: [{ id: '1', prompt: '', duration: 5 }],
        duration: 5,
      });
      render(<CreateVideoClient prefill={{ prompt: 'The prompt of the link' }} />);

      await waitFor(() => expect(screen.getByPlaceholderText('Describe the Seedance 1.5 Pro scene in rich cinematic detail...')).toHaveValue('The prompt of the link'));
      await waitFor(() => expect(quoteStandIn.lastRequest()?.settings).toMatchObject({ aspectRatio: '9:16' }));
    });

    it('keeps no draft of a remix, which restores its source', async () => {
      stubRemix({
        generation: { id: 'gen-1', title: 'Harbour', prompt: PROMPT, category: 'video', model: 'kling-3.0-video' },
        result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
        inputs: {},
        workflowSettings: { model: 'kling-3.0-video' },
        restoreIssues: [],
      } as RemixSourceBundle);
      const view = render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      await waitFor(() => expect(promptBox()).toHaveValue(PROMPT));
      fireEvent.change(promptBox(), { target: { value: `${PROMPT} Again.` } });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      view.unmount();

      expect(loadCreatorDraftMock).not.toHaveBeenCalled();
      expect(saveCreatorDraftMock).not.toHaveBeenCalled();
    });

    it('reads and writes staged files under the account, and drops the unscoped ones once', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(getPersistedFileMock).toHaveBeenCalledWith('create-video:start-image:user-1'));
      expect(getPersistedImageElementRecordsMock).toHaveBeenCalledWith('create-video:elements:user-1');
      expect(getPersistedValueMock).toHaveBeenCalledWith('create-video:seedance-assets:user-1');
      expect(getPersistedFileMock).not.toHaveBeenCalledWith('create-video:start-image');
      expect(purgeLegacyPersistedMediaMock).toHaveBeenCalledTimes(1);

      const frame = new File(['image'], 'start.png', { type: 'image/png' });
      fireEvent.change(view.container.querySelector<HTMLInputElement>('#video-start-frame-input')!, { target: { files: [frame] } });
      await waitFor(() => expect(setPersistedFileMock).toHaveBeenCalledWith('create-video:start-image:user-1', frame));
    });

    it('uploads a clip once for two presses, and sends its staged copy the second time', async () => {
      const view = render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);
      await screen.findByRole('heading', { name: 'Video and audio references' });
      await attachClip(view.container, new File(['video-bytes'], 'walk.mp4', { type: 'video/mp4' }));
      fireEvent.change(promptBox(), { target: { value: PROMPT } });

      fireEvent.click(generateButton());
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(2));

      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      expect(refreshTemporaryMediaUrlMock).toHaveBeenCalledWith('uploads/user-1/walk.mp4');
      const clipOf = (index: number) => postedStarts()[index].body.inputs.find((input) => input.slot === 'videoReferences');
      expect(clipOf(0)).toMatchObject({ url: 'https://signed.example.com/uploads/user-1/walk.mp4', storagePath: 'uploads/user-1/walk.mp4' });
      expect(clipOf(1)).toMatchObject({ url: 'https://signed.example.com/refreshed/uploads/user-1/walk.mp4', storagePath: 'uploads/user-1/walk.mp4' });
    });

    it('uploads a frame once for two presses', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(view.container.querySelector<HTMLInputElement>('#video-start-frame-input')!, {
        target: { files: [new File(['image'], 'start.png', { type: 'image/png' })] },
      });
      await waitFor(() => expect(setPersistedFileMock).toHaveBeenCalled());
      fireEvent.change(promptBox(), { target: { value: PROMPT } });

      fireEvent.click(generateButton());
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(2));

      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      const frameOf = (index: number) => postedStarts()[index].body.inputs.find((input) => input.slot === 'startFrame');
      expect(frameOf(1)).toMatchObject({ url: 'https://signed.example.com/refreshed/uploads/user-1/start.png', storagePath: 'uploads/user-1/start.png' });
    });

    it('sends the copy a Seedance preparation uploaded, instead of uploading the image again', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'hero-1', displayName: 'Hero', file: new File(['image'], 'hero.png', { type: 'image/png' }) },
      ]);
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
        String(input).includes('/api/seedance-assets')
          ? { ok: true, status: 200, json: async () => ({ success: true, assetId: 'asset-hero', status: 'processing' }) } as Response
          : defaultResponse(input, init)
      ));
      render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);
      fireEvent.click(await screen.findByRole('button', { name: /Prepare asset/ }));
      await waitFor(() => expect(screen.getByText('Asset ID: asset-hero')).toBeInTheDocument());
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);

      fireEvent.change(promptBox(), { target: { value: '@hero walks along the harbour at dusk, slow push in.' } });
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(1));

      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      expect(refreshTemporaryMediaUrlMock).toHaveBeenCalledWith('uploads/user-1/hero.png');
      expect(postedStarts()[0].body.inputs.find((input) => input.slot === 'imageReferences')).toMatchObject({
        url: 'https://signed.example.com/refreshed/uploads/user-1/hero.png',
        storagePath: 'uploads/user-1/hero.png',
        assetId: null,
      });
    });

    it('uploads a clip again when its staged copy is gone', async () => {
      refreshTemporaryMediaUrlMock.mockRejectedValue(new TemporaryMediaReadUrlError('That upload is no longer available.', 404, 'MEDIA_OBJECT_NOT_FOUND'));
      const view = render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);
      await screen.findByRole('heading', { name: 'Video and audio references' });
      await attachClip(view.container, new File(['video-bytes'], 'walk.mp4', { type: 'video/mp4' }));
      fireEvent.change(promptBox(), { target: { value: PROMPT } });

      fireEvent.click(generateButton());
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(2));

      expect(refreshTemporaryMediaUrlMock).toHaveBeenCalledTimes(1);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    });

    it('names a picked file the upload step would refuse, and leaves it out', async () => {
      const view = render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);
      await screen.findByRole('heading', { name: 'Video and audio references' });
      const huge = new File(['video-bytes'], 'huge.mp4', { type: 'video/mp4' });
      Object.defineProperty(huge, 'size', { value: 300 * 1024 * 1024 });

      fireEvent.change(view.container.querySelector<HTMLInputElement>(clipInput)!, {
        target: { files: [new File(['x'], 'scene.mkv', { type: 'video/x-matroska' }), huge] },
      });

      expect(await screen.findByText(
        'scene.mkv can’t be used: add an MP4, MOV, WebM or M4V video. huge.mp4 is over the 250 MB limit for a video.',
      )).toBeInTheDocument();
      expect(screen.queryByText('Video reference 1')).toBeNull();
      expect(setPersistedMediaRecordsMock).not.toHaveBeenCalled();
    });

    it('says how many picks it added when the model takes fewer', async () => {
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      const input = await waitFor(() => {
        const found = view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"][multiple]');
        expect(found).not.toBeNull();
        return found!;
      });

      fireEvent.change(input, {
        target: { files: ['one', 'two', 'three'].map((name) => new File(['image'], `${name}.png`, { type: 'image/png' })) },
      });

      expect(await screen.findByText('Added 2 of 3: this model takes up to 2 image references.')).toBeInTheDocument();
      expect(screen.getAllByPlaceholderText('Rename element')).toHaveLength(2);
    });

    it('sends a prepared Seedance asset by its id beside the file’s own link, and only once it is active', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'hero-1', displayName: 'Hero', file: new File(['image'], 'hero.png', { type: 'image/png' }) },
      ]);
      getPersistedMediaRecordsMock.mockImplementation(async (key: string) => (
        key === 'create-video:reference-videos:user-1'
          ? [{ id: 'clip-1', displayName: 'Dance clip', durationSeconds: 4, file: new File(['clip'], 'dance.mp4', { type: 'video/mp4' }) }]
          : []
      ));
      const asset = (assetId: string, status: 'active' | 'processing') => ({
        assetId,
        assetType: null,
        status,
        sourceUrl: null,
        error: null,
        lastCheckedAt: null,
      });
      getPersistedValueMock.mockImplementation(async (key: string) => (
        key === 'create-video:seedance-assets:user-1'
          ? { images: [asset('asset-hero', 'processing')], videos: [asset('asset-clip', 'active')] }
          : null
      ));
      render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);
      expect((await screen.findAllByText('Dance clip')).length).toBeGreaterThan(0);
      fireEvent.change(promptBox(), { target: { value: '@hero dances like the reference clip in a bright studio, slow push in.' } });

      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(1));

      const inputs = postedStarts()[0].body.inputs;
      // The link is what the server measures; the id is what the provider is given.
      expect(inputs.find((input) => input.slot === 'videoReferences')).toMatchObject({
        url: 'https://signed.example.com/uploads/user-1/dance.mp4',
        assetId: 'asset-clip',
      });
      // A preparation still processing would fail at the provider after the hold.
      expect(inputs.find((input) => input.slot === 'imageReferences')).toMatchObject({
        url: 'https://signed.example.com/uploads/user-1/hero.png',
        assetId: null,
      });
    });

    it('keeps a remixed Seedance clip’s link and its prepared id, and sends both', async () => {
      const link = 'https://signed.example.com/generation_inputs/owner-1/gen-1/00-reference_video.mp4';
      stubRemix({
        generation: { id: 'gen-1', title: 'Dance', prompt: 'Swap the dancer for the reference', category: 'video', model: 'seedance-2-5' },
        result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
        inputs: {
          video: {
            referenceMode: 'elements',
            startFrame: null,
            endFrame: null,
            elements: [],
            referenceVideos: [{
              kind: 'video',
              label: 'Video reference 1',
              storagePath: 'generation_inputs/owner-1/gen-1/00-reference_video.mp4',
              sourceGenerationId: 'gen-1',
              url: link,
              durationSeconds: 6,
            }],
            referenceAudios: [],
          },
        },
        workflowSettings: {
          model: 'seedance-2-5',
          seedanceAssets: { videos: [{ assetId: 'asset-clip-9', assetType: 'Video', status: 'active', sourceUrl: null, error: null, lastCheckedAt: null }] },
        },
        restoreIssues: [],
      });
      render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      await waitFor(() => expect(promptBox()).toHaveValue('Swap the dancer for the reference'));
      expect((await screen.findAllByText('Video reference 1')).length).toBeGreaterThan(0);

      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(1));

      expect(postedStarts()[0].body.inputs.find((input) => input.slot === 'videoReferences')).toMatchObject({
        url: link,
        assetId: 'asset-clip-9',
        durationSeconds: 6,
      });
      expect(temporaryUploadMock).not.toHaveBeenCalled();
    });

    it('restores an older run’s prepared clip by the link it was prepared from, not by its id', async () => {
      const link = 'https://signed.example.com/uploads/owner-1/dance.mp4';
      stubRemix({
        generation: { id: 'gen-1', title: 'Dance', prompt: 'Swap the dancer for the reference', category: 'video', model: 'seedance-2-5' },
        result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
        inputs: { video: { referenceMode: 'elements', startFrame: null, endFrame: null, elements: [], referenceVideos: [], referenceAudios: [] } },
        workflowSettings: {
          model: 'seedance-2-5',
          referenceVideoUrls: ['asset-clip-9', 'asset-without-link'],
          seedanceAssets: {
            videos: [
              { assetId: 'asset-clip-9', assetType: 'Video', status: 'active', sourceUrl: link, error: null, lastCheckedAt: null },
              { assetId: 'asset-without-link', assetType: 'Video', status: 'active', sourceUrl: null, error: null, lastCheckedAt: null },
            ],
          },
        },
        restoreIssues: [],
      });
      render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      expect(await screen.findByText(/Some source media could not be restored automatically/)).toBeInTheDocument();

      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(1));

      const clips = postedStarts()[0].body.inputs.filter((input) => input.slot === 'videoReferences');
      expect(clips).toEqual([expect.objectContaining({ url: link, assetId: 'asset-clip-9' })]);
    });

    // The start charges its own price up to the one the creator was shown, and refuses a
    // run it prices above it (`cost_changed`) before any credits are held.
    it('sends the price it shows with the run, as the most the start may charge', async () => {
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      expect(costShown()).toBe('12 credits');

      fireEvent.click(generateButton());

      await waitFor(() => expect(postedStarts()).toHaveLength(1));
      expect(postedStarts()[0].body.expectedCostCredits).toBe(12);
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
    });

    it.each([
      ['answers another request than the run’s', { forAnotherRequest: true }],
      ['is not a whole number of credits', { answers: [12.5] }],
    ])('sends the run without a price when the quote %s', async (_case, answer) => {
      Object.assign(quoteStandIn, answer);
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });

      fireEvent.click(generateButton());

      // The run goes, and the start charges its own price, as it did before a price was sent.
      await waitFor(() => expect(postedStarts()).toHaveLength(1));
      expect(postedStarts()[0].body).not.toHaveProperty('expectedCostCredits');
    });

    it('sends nothing while the price is not ready, and the run with its price once it is', async () => {
      quoteStandIn.answers = ['pending'];
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      expect(costShown()).toBe('Calculating...');

      fireEvent.click(generateButton());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(generateButton()).toBeDisabled();
      expect(postedStarts()).toHaveLength(0);

      quoteStandIn.answers = [12];
      fireEvent.change(promptBox(), { target: { value: `${PROMPT} The water stays calm.` } });
      expect(costShown()).toBe('12 credits');
      fireEvent.click(generateButton());

      await waitFor(() => expect(postedStarts()).toHaveLength(1));
      expect(postedStarts()[0].body.expectedCostCredits).toBe(12);
    });

    it('asks for the price again when the server says it changed, and sends the next run at the new price under a new key', async () => {
      quoteStandIn.answers = [12, 15];
      answerStarts(refusal(409, {
        code: 'cost_changed',
        error: 'The price of this run changed. Check the updated cost and generate again.',
      }));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      expect(quoteStandIn.lastAttempt()).toBe(0);
      expect(costShown()).toBe('12 credits');
      fireEvent.click(generateButton());

      expect(await screen.findByText('The price of this run changed. Check the updated cost and generate again.')).toBeInTheDocument();
      expect(quoteStandIn.lastAttempt()).toBe(1);
      expect(costShown()).toBe('15 credits');
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();

      fireEvent.click(generateButton());

      await waitFor(() => expect(postedStarts()).toHaveLength(2));
      const [refused, next] = postedStarts();
      expect(refused.body.expectedCostCredits).toBe(12);
      expect(next.body.expectedCostCredits).toBe(15);
      expect(next.key).not.toBe(refused.key);
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
    });

    it('keeps Retry quote in reach when the price cannot be read again after it changed', async () => {
      quoteStandIn.answers = [12, 'error', 15];
      answerStarts(refusal(409, {
        code: 'cost_changed',
        error: 'The price of this run changed. Check the updated cost and generate again.',
      }));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      expect(await screen.findByText('The price of this run changed. Check the updated cost and generate again.')).toBeInTheDocument();
      expect(costShown()).toBe('Unavailable');
      expect(generateButton()).toBeDisabled();

      // Generate waits for a price, and asking again is the only way to one.
      fireEvent.click(screen.getByRole('button', { name: 'Retry quote' }));

      expect(costShown()).toBe('15 credits');
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(2));
      expect(postedStarts()[1].body.expectedCostCredits).toBe(15);
    });

    // A run that goes is forgotten as a refusal: a later quote back at the refused price
    // (a rollback) held Generate and said the page was out of date, though the start would
    // take it.
    it('forgets a refusal once that run goes, after the page was found out of date and the price then moved', async () => {
      answerStarts(refusal(409, {
        code: 'cost_changed',
        error: 'The price of this run changed. Check the updated cost and generate again.',
      }));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('This page is out of date');

      // The price moves (a deploy that fixed this run's quote, say), and the run goes at it.
      quoteStandIn.answers = [12, 15];
      fireEvent.change(promptBox(), { target: { value: `${PROMPT} The water stays calm.` } });
      expect(costShown()).toBe('15 credits');
      expect(screen.queryByText(/This page is out of date/)).toBeNull();
      fireEvent.click(generateButton());
      expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
      expect(postedStarts().map((start) => start.body.expectedCostCredits)).toEqual([12, 15]);

      // The old price back (a rollback): the run went, so the page holds nothing.
      quoteStandIn.answers = [12, 12];
      fireEvent.change(promptBox(), { target: { value: `${PROMPT} The water stays still.` } });
      expect(costShown()).toBe('12 credits');
      expect(screen.queryByText(/This page is out of date/)).toBeNull();
      expect(generateButton()).toBeEnabled();
    });

    it('says the page is out of date and holds Generate for a reload when asking again leaves the run at the refused price', async () => {
      // A page sends from its own build until it hears of a newer one, and a page served
      // stale never does. When that build prices a run apart from the start, asking again
      // gave the same price, and each press was refused the same way until a reload.
      const costChanged = refusal(409, {
        code: 'cost_changed',
        error: 'The price of this run changed. Check the updated cost and generate again.',
      });
      answerStarts(costChanged, costChanged, costChanged);
      document.documentElement.dataset.buildId = 'build-7';
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalled());
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      const notice = await screen.findByRole('alert');
      expect(notice).toHaveTextContent('This page is out of date, so it cannot show what this run costs.');
      expect(notice).toHaveTextContent('Your draft is kept.');
      // Asked again once, and the start's refusal stood: the same run at the same price.
      expect(quoteStandIn.lastAttempt()).toBe(1);
      expect(costShown()).toBe('12 credits');
      expect(generateButton()).toBeDisabled();
      fireEvent.click(generateButton());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(postedStarts()).toHaveLength(1);

      // jsdom does not navigate: it reports the reload it was asked for as not implemented.
      const { virtualConsole } = (globalThis as unknown as {
        jsdom: { virtualConsole: { on: (event: string, listener: (error: Error) => void) => void; off: (event: string, listener: (error: Error) => void) => void } };
      }).jsdom;
      const navigations: string[] = [];
      const onJsdomError = (jsdomError: Error) => {
        if (/navigation/i.test(jsdomError.message)) navigations.push(jsdomError.message);
      };
      virtualConsole.on('jsdomError', onJsdomError);
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
        await waitFor(() => expect(navigations).toHaveLength(1));
        expect(saveCreatorDraftMock).toHaveBeenCalledWith('video', 'user-1', expect.objectContaining({ prompt: PROMPT }));
        // The build it left, so the page that loads next can tell if the same one came back.
        expect(window.sessionStorage.getItem('magicbooklet:deployment-refresh:reloaded-from-build-id')).toBe('build-7');
      } finally {
        virtualConsole.off('jsdomError', onJsdomError);
        delete document.documentElement.dataset.buildId;
      }
    });

    it('promises a saved draft only where one is kept', async () => {
      modelCatalogState.missingIds = ['kling-3.0-video'];
      const page = render(<CreateVideoClient prefill={{}} />);
      expect(await screen.findByText('This model is no longer available. Your draft is saved; choose another model.')).toBeInTheDocument();
      page.unmount();

      stubRemix({
        generation: { id: 'gen-1', title: 'Harbour', prompt: PROMPT, category: 'video', model: 'kling-3.0-video' },
        result: { mediaType: 'video', url: 'https://example.com/result.mp4' },
        inputs: {},
        workflowSettings: { model: 'kling-3.0-video' },
        restoreIssues: [],
      } as RemixSourceBundle);
      render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);
      expect(await screen.findByText('This model is no longer available. Choose another model; your settings stay on this page.')).toBeInTheDocument();
    });

    it('takes the lengths the server measured, so the price is asked again, and says to check it', async () => {
      answerStarts(refusal(409, {
        code: 'REFERENCE_DURATION_CHANGED',
        error: 'Your reference media runs longer than the length this price was based on. Check the updated cost, then generate again.',
        costCredits: 30,
        quotedCostCredits: 12,
        inputs: [{ index: 0, slot: 'videoReferences', durationSeconds: 7.9 }],
      }));
      const view = render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);
      await screen.findByRole('heading', { name: 'Video and audio references' });
      await attachClip(view.container, new File(['video-bytes'], 'walk.mp4', { type: 'video/mp4' }));
      expect(screen.getByText('4.2s clip')).toBeInTheDocument();
      fireEvent.change(promptBox(), { target: { value: PROMPT } });

      fireEvent.click(generateButton());

      expect(await screen.findByText(/Check the updated cost, then generate again\./)).toBeInTheDocument();
      expect(screen.getByText('7.9s clip')).toBeInTheDocument();
      await waitFor(() => expect(quoteStandIn.lastRequest()?.inputMetadata?.slots?.videoReferences)
        .toEqual({ count: 1, durationsSeconds: [7.9] }));
      expect(catalogClient.loadPendingWebStart('video', 'user-1')).toBeNull();
      // The measured length is kept with the clip for the next visit.
      expect(setPersistedMediaRecordsMock.mock.calls.filter(([key]) => key === 'create-video:reference-videos:user-1').at(-1)?.[1])
        .toEqual([expect.objectContaining({ durationSeconds: 7.9 })]);
    });

    // The boxes keep the route's shared 10,000, so a paste or a model switch never cuts a
    // word; Kling 3.0's own limits (2,500 for the prompt, 500 for each shot) are what the
    // counters read and what holds Generate.
    it('holds the prompt and each shot to the model’s own limits, keeping every word', async () => {
      render(<CreateVideoClient prefill={{}} />);
      const counter = () => promptBox().nextElementSibling?.firstElementChild;
      expect(promptBox()).toHaveAttribute('maxlength', '10000');

      fireEvent.change(promptBox(), { target: { value: 'x'.repeat(2400) } });
      expect(counter()?.textContent).toBe('2,400 / 2,500');
      expect(counter()).toHaveAttribute('data-state', 'near');
      expect(generateButton()).toBeEnabled();

      fireEvent.change(promptBox(), { target: { value: 'x'.repeat(3000) } });
      expect(promptBox()).toHaveValue('x'.repeat(3000));
      expect(counter()?.textContent).toBe('3,000 / 2,500');
      expect(counter()).toHaveAttribute('data-state', 'over');
      expect(promptBox()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Kling 3.0 Cinematic prompts support up to 2,500 characters.')).toBeInTheDocument();
      expect(generateButton()).toBeDisabled();
      fireEvent.click(generateButton());
      expect(postedStarts()).toHaveLength(0);

      // A multi-shot Kling 3.0 run sends its shots and no prompt of its own: the shots are held.
      chooseMultiShot();
      const shot = await screen.findByPlaceholderText('Describe shot 1...');
      expect(shot).toHaveAttribute('maxlength', '10000');
      expect(screen.queryByText(/prompts support up to/)).not.toBeInTheDocument();
      fireEvent.change(shot, { target: { value: 'y'.repeat(501) } });
      expect(shot).toHaveValue('y'.repeat(501));
      expect(screen.getByText('501 / 500')).toHaveAttribute('data-state', 'over');
      expect(shot).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Shot 1: Kling 3.0 Cinematic shot prompts support up to 500 characters.')).toBeInTheDocument();
      expect(generateButton()).toBeDisabled();

      fireEvent.change(shot, { target: { value: 'y'.repeat(500) } });
      expect(shot).not.toHaveAttribute('aria-invalid');
      expect(screen.getByText('500 / 500')).toHaveAttribute('data-state', 'near');
      expect(screen.queryByText(/shot prompts support up to/)).not.toBeInTheDocument();
      expect(postedStarts()).toHaveLength(0);
    });

    it('keeps the prompt when the creator switches to a model with a lower limit, and marks it over there', async () => {
      modelCatalogState.summaries = [
        { id: 'seedance-2-5', kind: 'video', displayName: 'Seedance 2.5', description: 'Test multimodal video model' },
        { id: 'kling-3.0-video', kind: 'video', displayName: 'Kling 3.0 Cinematic', description: 'Test video model' },
        { id: 'wan-2.7', kind: 'video', displayName: 'Wan 2.7', description: 'Test frame-and-reference combining model' },
      ];
      const view = render(<CreateVideoClient prefill={{ model: 'seedance-2-5' }} />);
      const counter = () => promptBox().nextElementSibling?.firstElementChild;
      const prompt = 'x'.repeat(4000);
      fireEvent.change(promptBox(), { target: { value: prompt } });
      // Seedance 2.5 sets no limit of its own: the route's 10,000 stands.
      expect(counter()?.textContent).toBe('4,000 / 10,000');

      chooseModel(view.container, 'Kling 3.0 Cinematic');
      await waitFor(() => expect(counter()?.textContent).toBe('4,000 / 2,500'));
      expect(promptBox()).toHaveValue(prompt);
      expect(counter()).toHaveAttribute('data-state', 'over');
      expect(screen.getByText('Kling 3.0 Cinematic prompts support up to 2,500 characters.')).toBeInTheDocument();
      expect(generateButton()).toBeDisabled();

      chooseModel(view.container, 'Wan 2.7');
      await waitFor(() => expect(counter()?.textContent).toBe('4,000 / 5,000'));
      expect(promptBox()).toHaveValue(prompt);
      expect(counter()).toHaveAttribute('data-state', 'within');
      expect(screen.queryByText(/prompts support up to/)).not.toBeInTheDocument();
      expect(generateButton()).toBeEnabled();
    });

    it('prices a multi-shot run by its shots, and stops adding shots at the model’s length and shot limits', async () => {
      render(<CreateVideoClient prefill={{}} />);
      chooseMultiShot();
      const addShot = await screen.findByRole('button', { name: /Add New Shot/ });
      const setShotLength = (shot: number, seconds: number) => fireEvent.change(screen.getAllByRole('slider')[shot], { target: { value: String(seconds) } });

      fireEvent.click(addShot);
      expect(await screen.findByText('2 of 5 shots · 10s in total, up to 15s')).toBeInTheDocument();
      await waitFor(() => expect(quoteStandIn.lastRequest()?.settings).toMatchObject({ isMultiShot: true, duration: 10 }));

      // Kling 3.0 runs at most 15 seconds.
      fireEvent.click(addShot);
      expect(await screen.findByText('3 of 5 shots · 15s in total, up to 15s')).toBeInTheDocument();
      expect(addShot).toBeDisabled();

      // Shorter shots leave room for more, up to five.
      [0, 1, 2].forEach((shot) => setShotLength(shot, 1));
      expect(addShot).toBeEnabled();
      fireEvent.click(addShot);
      setShotLength(3, 1);
      fireEvent.click(addShot);
      expect(await screen.findByText('5 of 5 shots · 9s in total, up to 15s')).toBeInTheDocument();
      expect(addShot).toBeDisabled();

      for (let shot = 1; shot <= 5; shot += 1) {
        fireEvent.change(screen.getByPlaceholderText(`Describe shot ${shot}...`), { target: { value: `Shot ${shot}: the camera holds on the water as the light fades.` } });
      }
      fireEvent.click(generateButton());
      await waitFor(() => expect(postedStarts()).toHaveLength(1));
      const run = postedStarts()[0].body;
      expect(run.settings).toMatchObject({ isMultiShot: true, duration: 9 });
      expect(run.expectedCostCredits).toBe(12);
      expect((run.shots as Array<{ duration: number }>).map((shot) => shot.duration)).toEqual([1, 1, 1, 1, 5]);
    });

    it.each([
      ['Kling 3.0 Cinematic', 'kling-3.0-video'],
      ['Kling O3', 'kling-o3'],
    ] as const)('lets %s add as many shots as the prompt check accepts, and no more', async (_name, modelId) => {
      render(<CreateVideoClient prefill={{ model: modelId }} />);
      chooseMultiShot();
      const addShot = await screen.findByRole('button', { name: /Add New Shot/ });
      // One-second shots, so the length cap is never what stops the next one.
      let shots = 1;
      fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '1' } });
      while (!(addShot as HTMLButtonElement).disabled && shots < 20) {
        fireEvent.click(addShot);
        shots += 1;
        fireEvent.change(screen.getAllByRole('slider')[shots - 1], { target: { value: '1' } });
      }

      const blocks = (shotCount: number) => inspectPromptQuality({
        medium: 'video',
        selectedModel: modelId,
        prompt: 'The camera holds on the water as the light fades.',
        context: { isMultiShot: true, shotCount },
      }).warnings.some((warning) => warning.severity === 'blocking');
      expect(blocks(shots)).toBe(false);
      expect(blocks(shots + 1)).toBe(true);
    });

    it('lets a saved image the model cannot take be removed from the standby card', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([
        { id: 'saved-1', displayName: 'Hero', file: new File(['image'], 'hero.png', { type: 'image/png' }) },
        { id: 'saved-2', displayName: 'Scarf', file: new File(['image'], 'scarf.png', { type: 'image/png' }) },
      ]);
      render(<CreateVideoClient prefill={{}} />);
      await screen.findByText('Saved references are on standby');

      fireEvent.click(screen.getByRole('button', { name: 'Remove Hero' }));

      await waitFor(() => expect(setPersistedImageElementRecordsMock).toHaveBeenLastCalledWith(
        'create-video:elements:user-1',
        [expect.objectContaining({ id: 'saved-2' })],
      ));
      expect(screen.queryByRole('button', { name: 'Remove Hero' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Remove Scarf' })).toBeInTheDocument();
    });

    it('lets a saved track the model cannot take be removed from the standby card', async () => {
      getPersistedMediaRecordsMock.mockImplementation(async (key: string) => (
        key === 'create-video:reference-audios:user-1'
          ? [{ id: 'track-1', displayName: 'Voice line', durationSeconds: 6, file: new File(['audio'], 'voice.mp3', { type: 'audio/mpeg' }) }]
          : []
      ));
      render(<CreateVideoClient prefill={{ model: 'gemini-omni-video' }} />);
      await screen.findByText('Saved references are on standby');

      fireEvent.click(screen.getByRole('button', { name: 'Remove Voice line' }));

      await waitFor(() => expect(setPersistedMediaRecordsMock).toHaveBeenLastCalledWith('create-video:reference-audios:user-1', []));
      await waitFor(() => expect(screen.queryByText('Saved references are on standby')).toBeNull());
    });

    it('opens Publish & share with the creation’s own title and recipe', async () => {
      const recipe: GenerationPaywallPrefill = {
        resourceKinds: ['prompt'],
        promptText: PROMPT,
        notesMarkdown: null,
        allowRemix: false,
      };
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // The library entry, read in full; the result player reads a summary of its own.
        if (url.startsWith('/api/generations?') && !url.includes('detail=')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ generations: [{ id: 'gen-run-1', title: 'Harbour at dusk', paywallPrefill: recipe }] }),
          } as Response;
        }
        return defaultResponse(input, init);
      });
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());

      fireEvent.click(await screen.findByRole('button', { name: /Publish & share/ }));

      await waitFor(() => expect(publishModalPropsMock.mock.calls.at(-1)?.[0]).toMatchObject({
        isOpen: true,
        defaultTitle: 'Harbour at dusk',
        paywallPrefill: recipe,
      }));
    });

    // The video creator on the app's column (2026-10-26): the run's settings fold into
    // one chip on the bar, read back as the app reads them.
    it('reads the run\'s settings back on the bar\'s chip, and follows a change made in them', async () => {
      render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      const chip = await screen.findByRole('button', { name: /^Generation settings: / });
      expect(chip).toHaveAccessibleName(/^Generation settings: (\d{3,4}P · )?\d+:\d+ · \d+s · Sound (on|off)$/);

      chooseAspectRatio('9:16');

      expect(screen.getByRole('button', { name: /^Generation settings: / })).toHaveAccessibleName(/ · 9:16 · \d+s · Sound (on|off)$/);
    });

    it('keeps the prompt the run was sent with under its clip while the next one is written', async () => {
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());
      await screen.findByRole('link', { name: 'Download video' });

      fireEvent.change(promptBox(), { target: { value: 'A forest at dawn, mist between the trees, a slow crane up.' } });

      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(within(canvas).getByText(PROMPT)).toBeInTheDocument();
      expect(within(canvas).queryByText(/A forest at dawn/)).toBeNull();
    });

    it('plays the finished clip once: beside the column it never leaves the window to be paused', async () => {
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(promptBox(), { target: { value: PROMPT } });
      fireEvent.click(generateButton());
      await screen.findByRole('link', { name: 'Download video' });

      expect(resultVideoPropsMock.mock.calls.at(-1)?.[0]).toMatchObject({ loop: false });
    });

    it('draws a model the catalog has listed but not described yet, which has no ratio', async () => {
      // Until its details load, a model is drawn from its summary, with no ratios to offer.
      const registry = VIDEO_MODELS as unknown as Record<string, Record<string, unknown>>;
      const described = registry['kling-3.0-video'];
      registry['kling-3.0-video'] = { ...described, aspectRatios: [] };
      try {
        render(<CreateVideoClient prefill={{}} />);
        const chip = await screen.findByRole('button', { name: /^Generation settings: / });
        expect(chip.getAttribute('aria-label')).not.toContain('undefined');
        expect(Number(screen.getByTestId('creator-canvas-frame').style.getPropertyValue('--creator-frame-ratio'))).toBe(1);
      } finally {
        registry['kling-3.0-video'] = described;
      }
    });

    it('names the mode control as the model\'s catalog entry does', async () => {
      const published = serverCatalog.buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
      modelCatalogState.extraModels = published.models
        .filter((model) => model.id === 'grok-imagine-video') as unknown as Array<Record<string, unknown>>;
      render(<CreateVideoClient prefill={{ model: 'grok-imagine-video' }} />);

      fireEvent.click(await screen.findByRole('button', { name: /^Generation settings/ }));

      expect(screen.getByRole('radiogroup', { name: 'Grok mode' })).toBeInTheDocument();
    });

    it('says in the column, not only in the settings, that a model always makes sound', async () => {
      render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);

      expect(await screen.findByText(/This model always generates audio/)).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Generation settings' })).toBeNull();
    });

    it('offers single shot and multi-shot as a radio group, as the app\'s segmented control', async () => {
      render(<CreateVideoClient prefill={{}} />);
      const single = await screen.findByRole('radio', { name: 'Single shot' });
      expect(single).toHaveAttribute('aria-checked', 'true');
      expect(promptBox()).toBeInTheDocument();

      chooseMultiShot();

      expect(screen.getByRole('radio', { name: 'Multi-shot' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByPlaceholderText('Describe shot 1...')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/^Describe the .+ scene in rich cinematic detail/)).toBeNull();
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
        render(<CreateVideoClient prefill={{}} />);
        fireEvent.change(promptBox(), { target: { value: PROMPT } });
        fireEvent.click(generateButton());

        await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
        expect(scrollIntoView.mock.contexts[0]).toHaveAttribute('aria-label', 'Result');
      });

      it('stays put when the start is refused, so the reason in the bar stays in view', async () => {
        placeCanvas(1500);
        answerStarts(refusal(422, { code: 'INVALID_GENERATION_REQUEST', error: 'Shot 1 is too long.' }));
        render(<CreateVideoClient prefill={{}} />);
        fireEvent.change(promptBox(), { target: { value: PROMPT } });
        fireEvent.click(generateButton());

        expect(await screen.findByText('Shot 1 is too long.')).toBeInTheDocument();
        expect(scrollIntoView).not.toHaveBeenCalled();
      });

      it('stays put when an unanswered start is checked again on load, so the page opens at its top', async () => {
        placeCanvas(1500);
        catalogClient.savePendingWebStart({
          version: 1,
          tool: 'video',
          idempotencyKey: 'video:kept-key',
          body: { kind: 'video', modelId: 'kling-3.0-video', catalogRevision: 'test-catalog-rev', prompt: PROMPT, shots: [], settings: { duration: 5 }, inputs: [] },
          catalogRevision: 'test-catalog-rev',
          createdAt: new Date().toISOString(),
          userId: 'user-1',
        });
        render(<CreateVideoClient prefill={{}} />);

        expect(await screen.findByRole('link', { name: 'Download video' })).toBeInTheDocument();
        expect(scrollIntoView).not.toHaveBeenCalled();
      });
    });

    it('marks the Studio link with a gallery icon, not a download one', async () => {
      render(<CreateVideoClient prefill={{}} />);

      for (const link of [screen.getByRole('link', { name: /^Studio/ })]) {
        const icon = link.querySelector('svg')?.getAttribute('class') ?? '';
        expect(icon).toContain('lucide-images');
        expect(icon).not.toContain('lucide-download');
      }
    });
  });

  // PR 2 of the creator redesign (owner, 2026-10-28): every model and every option priced, the
  // balance read under the bar, a remix fitted to the balance and an image offered first when
  // the balance is short of every video. Prices come from the price lists' stand-in.
  describe('prices and affordability', () => {
    const MINI = { id: 'seedance-2-mini', kind: 'video', displayName: 'Seedance 2 Mini', description: 'Lower cost' };
    const summaries = [
      MINI,
      { id: 'seedance-1.5-pro', kind: 'video', displayName: 'Seedance 1.5 Pro', description: 'Resolution, duration and audio controls' },
      { id: 'kling-3.0-video', kind: 'video', displayName: 'Kling 3.0 Cinematic', description: 'Test video model' },
      { id: 'seedance-2-5', kind: 'video', displayName: 'Seedance 2.5', description: 'Runs up to 30s' },
    ];
    // Production's prices for these runs (release mini-default-video-20261028).
    const MINI_PER_LENGTH: Record<number, number> = { 4: 16, 5: 19, 6: 23, 7: 27, 8: 31, 9: 35, 10: 38, 11: 42, 12: 46, 13: 50, 14: 54, 15: 57 };
    function videoPrice(request: GenerationModelQuoteInput): number {
      const duration = Number(request.settings?.duration);
      if (request.modelId === 'seedance-2-mini') return request.settings?.resolution === '720p' ? 41 : MINI_PER_LENGTH[duration];
      if (request.modelId === 'seedance-1.5-pro') return 7;
      if (request.modelId === 'seedance-2-5') return 28 * duration;
      return 14 * duration;
    }

    beforeEach(() => {
      modelCatalogState.summaries = summaries;
      modelCatalogState.extraModels = [{ ...MINI, controls: [], capabilities: {}, inputs: {} }];
      modelCatalogState.videoDefault = 'seedance-2-mini';
      quoteStandIn.priceFor = videoPrice;
      priceListStandIn.price = pricedBy(videoPrice);
    });

    function openModelList() {
      fireEvent.click(document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!);
    }

    function rowNames(group: HTMLElement) {
      return within(group).getAllByRole('option').map((option) => option.querySelector('span span')?.textContent?.trim());
    }

    it('prices each model at this run\'s settings, and splits the list by the balance', async () => {
      authState.credits = 22;
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(costShown()).toBe('19 credits'));

      openModelList();

      const fits = screen.getByRole('group', { name: 'Fits your 22 credits' });
      expect(rowNames(fits)).toEqual(['Seedance 2 Mini', 'Seedance 1.5 Pro']);
      expect(within(fits).getByRole('option', { name: /Seedance 1\.5 Pro/ })).toHaveTextContent('7 credits480P · 4s');
      expect(within(fits).getByRole('option', { name: /Seedance 2 Mini/ })).toHaveTextContent('19 credits480P · 5s');
      const needsMore = screen.getByRole('group', { name: 'Needs more credits' });
      expect(rowNames(needsMore)).toEqual(['Kling 3.0 Cinematic', 'Seedance 2.5']);
      expect(within(needsMore).getByRole('option', { name: /Seedance 2\.5/ })).toHaveTextContent('140 credits480P · 5s');
      // Each run is this one moved to its model: Seedance 1.5 Pro makes 4, 8 or 12 seconds.
      expect(priceListStandIn.askedRuns().find((run) => run.modelId === 'seedance-1.5-pro')?.settings)
        .toMatchObject({ duration: 4, resolution: '480p', aspectRatio: '16:9' });
    });

    it('opens a picked model on this run\'s settings where it offers them', async () => {
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(costShown()).toBe('19 credits'));
      chooseAspectRatio('9:16');

      chooseModel(document.body, 'Seedance 1.5 Pro');

      // It opened on its first ratio (1:1) and its first length before.
      await waitFor(() => expect(screen.getByRole('button', { name: /^Generation settings: / }))
        .toHaveAccessibleName('Generation settings: 480P · 9:16 · 4s · Sound off'));
    });

    it('prices every option of the settings, past the balance too, and says what the run leaves', async () => {
      authState.credits = 22;
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(costShown()).toBe('19 credits'));

      fireEvent.click(screen.getByRole('button', { name: /^Generation settings/ }));

      const settings = screen.getByRole('dialog', { name: 'Generation settings' });
      expect(within(settings).getByRole('radio', { name: '4s, 16 credits' })).toBeInTheDocument();
      expect(within(settings).getByRole('radio', { name: '5s, 19 credits' })).toBeChecked();
      expect(within(settings).getByRole('radio', { name: '6s, 23 credits, 1 more than your balance' })).toHaveTextContent('6s23 · +1');
      expect(within(settings).getByRole('radio', { name: '720p, 41 credits, 19 more than your balance' })).toBeInTheDocument();
      expect(within(settings).getByRole('radiogroup', { name: 'Aspect ratio' }).parentElement).toHaveTextContent('Same price for each');
      expect(within(settings).getByRole('switch', { name: /Generated sound/ })).toHaveTextContent('No extra cost on Seedance 2 Mini');
      expect(settings).toHaveTextContent('“+1” means 1 credit more than your balance of 22.');
      expect(settings).toHaveTextContent('This run 19 credits · leaves 3');

      // Past the balance, an option is still chosen, and Top up stands in Generate's place.
      fireEvent.click(within(settings).getByRole('radio', { name: /^6s/ }));
      await waitFor(() => expect(screen.getByRole('link', { name: /Top Up Credits/ })).toBeInTheDocument());
      expect(settings).toHaveTextContent('This run 23 credits · 1 more than your balance');
    });

    it('reads the balance under the bar, and what the run leaves of it', async () => {
      authState.credits = 22;
      render(<CreateVideoClient prefill={{}} />);
      await waitFor(() => expect(costShown()).toBe('19 credits'));

      const note = document.querySelector('[data-creator-bar-note]');
      expect(note).toHaveTextContent('Balance 22');
      expect(note).toHaveTextContent('Leaves 3');
    });

    it('offers an image first, with the prompt, when the balance is short of every video', async () => {
      authState.credits = 3;
      priceListStandIn.price = pricedBy((request) => (
        request.kind === 'image' ? (request.modelId === 'z-image' ? 1 : 8) : videoPrice(request)
      ));
      render(<CreateVideoClient prefill={{}} />);
      fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'A paper boat on a sunlit pond' } });

      const offer = await screen.findByRole('link', { name: 'Make an image instead · from 1 credit' });
      expect(offer).toHaveAttribute('href', '/create-image?model=z-image&prompt=A+paper+boat+on+a+sunlit+pond');
      expect(queryGenerateButton()).toBeNull();
      expect(document.querySelector('[data-creator-bar-note]')).toHaveTextContent('Balance 3 · videos from 7');
      expect(screen.getByRole('link', { name: 'Top up: 500 for ₹415' })).toHaveAttribute('href', '/pricing');
      expect(screen.getByText('3 credits: enough for images')).toBeInTheDocument();
      expect(screen.getByText(/Videos start at 7 credits\. Z-Image makes a picture for 1/)).toBeInTheDocument();
    });

    it('keeps Generate\'s place for a top-up while some video still fits the balance', async () => {
      authState.credits = 10;
      priceListStandIn.price = pricedBy((request) => (request.kind === 'image' ? 1 : videoPrice(request)));
      render(<CreateVideoClient prefill={{}} />);

      expect(await screen.findByRole('link', { name: /Top Up Credits/ })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Make an image instead/ })).toBeNull();
    });

    describe('a remix', () => {
      function remixOf(settings: Record<string, unknown>): RemixSourceBundle {
        return {
          generation: { id: 'gen-1', title: 'intense', prompt: 'Two figures face off in a dim hall.', category: 'video', model: 'seedance-2-5' },
          result: { mediaType: 'video', url: 'https://example.com/intense.mp4' },
          inputs: { video: { referenceMode: 'frames', startFrame: null, endFrame: null, elements: [], referenceVideos: [], referenceAudios: [] } },
          workflowSettings: { model: 'seedance-2-5', aspectRatio: '9:16', resolution: '480p', sound: false, ...settings },
          restoreIssues: [],
        } as unknown as RemixSourceBundle;
      }

      it('opens on the cheapest model that takes its inputs at the same length when the balance is short of the original', async () => {
        authState.credits = 22;
        stubRemix(remixOf({ duration: 5 }));
        render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);

        expect(await screen.findByText(/Fitted to your 22 credits: Seedance 2 Mini instead of Seedance 2\.5, at the same 5s\./)).toBeInTheDocument();
        await waitFor(() => expect(costShown()).toBe('19 credits'));
        expect(screen.getByRole('button', { name: /^Generation settings: / })).toHaveAccessibleName('Generation settings: 480P · 9:16 · 5s · Sound off');

        // The original is one press away; short of it, the bar offers the fitted run back.
        fireEvent.click(screen.getByRole('button', { name: 'Use the original · 140 credits' }));
        expect(await screen.findByText('On the original settings: Seedance 2.5 at 5s.')).toBeInTheDocument();
        await waitFor(() => expect(document.querySelector('[data-creator-bar-status]'))
          .toHaveTextContent('Seedance 2.5 needs 140 credits; you have 22. Seedance 2 Mini runs the same prompt and 5s for 19.'));
        expect(screen.getByRole('link', { name: 'Top up · 500 credits for ₹415' })).toHaveAttribute('href', '/pricing');

        fireEvent.click(screen.getByRole('button', { name: 'Switch back to Seedance 2 Mini' }));
        await waitFor(() => expect(costShown()).toBe('19 credits'));
      });

      it('opens on its original while the balance covers it', async () => {
        stubRemix(remixOf({ duration: 5 }));
        render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);

        expect(await screen.findByText(/Settings pre-filled from "intense"/)).toBeInTheDocument();
        await waitFor(() => expect(costShown()).toBe('140 credits'));
        expect(screen.queryByText(/Fitted to your/)).toBeNull();
      });

      it('shortens the cheapest model when nothing fits at the original\'s length', async () => {
        authState.credits = 22;
        stubRemix(remixOf({ duration: 10 }));
        render(<CreateVideoClient prefill={{ remixId: 'gen-1', remixPostId: 'post-1' }} />);

        expect(await screen.findByText(/Fitted to your 22 credits: Seedance 2 Mini instead of Seedance 2\.5, at 5s instead of 10s\./)).toBeInTheDocument();
        await waitFor(() => expect(costShown()).toBe('19 credits'));
      });
    });
  });
});
