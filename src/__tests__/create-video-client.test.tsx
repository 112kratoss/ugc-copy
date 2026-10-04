import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const mockPush = vi.fn();
const mockUpdateCredits = vi.fn();
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
const quoteRequestMock = vi.hoisted(() => vi.fn((_request: GenerationModelQuoteInput | null) => {
  void _request;
}));
const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
}));
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
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    credits: 10_000,
    isLoading: false,
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
    updateCredits: mockUpdateCredits,
  }),
}));

vi.mock('@/components/EnhancePromptButton', () => ({
  default: (props: { prompt: string; context?: EnhancerContext }) => {
    enhanceButtonPropsMock(props);
    return null;
  },
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublishToShowcaseModal', () => ({
  default: () => null,
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
  getPersistedValue: vi.fn(async () => null),
  removePersistedMedia: vi.fn(async () => undefined),
  setPersistedFile: vi.fn(async () => undefined),
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

vi.mock('@/lib/temporary-media-upload', () => ({
  uploadMediaToTemporaryStorage: temporaryUploadMock,
}));

vi.mock('@/lib/generation-model-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-model-client')>('@/lib/generation-model-client');
  return {
    ...actual,
    useWebGenerationModelCatalog: () => ({
      summaries: modelCatalogState.summaries, missingIds: modelCatalogState.missingIds, detailsReady: true, isLoadingModels: false,
      catalog: {
        revision: 'test-catalog-rev',
        schemaVersion: 1,
        defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-3.0' },
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
        ],
      },
      error: modelCatalogState.error,
      isLoading: false,
      revision: 'test-catalog-rev',
      refetch: generationCatalogRefetchMock,
    }),
    useWebGenerationModelQuote: (request: GenerationModelQuoteInput | null) => {
      quoteRequestMock(request);
      return {
        status: 'ready',
        quote: {
          modelId: 'kling-3.0-video',
          catalogRevision: 'test-catalog-rev',
          normalizedSettings: {},
          costCredits: 12,
        },
        error: null,
      };
    },
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

describe('CreateVideoClient Kling video elements', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalCreateElement = document.createElement.bind(document);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPush.mockClear();
    mockUpdateCredits.mockClear();
    generationCatalogRefetchMock.mockClear();
    quoteRequestMock.mockClear();
    enhanceButtonPropsMock.mockClear();
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
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
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      // jsdom loads no media, so the page would wait for a length that never comes.
      // Here a clip is 4.2 seconds long and a track 6.5.
      if (tagName === 'video' || tagName === 'audio') {
        const previewMedia = originalCreateElement(tagName) as HTMLMediaElement;
        Object.defineProperty(previewMedia, 'duration', {
          configurable: true,
          get: () => (tagName === 'video' ? 4.2 : 6.5),
        });
        Object.defineProperty(previewMedia, 'src', {
          configurable: true,
          get: () => 'blob:kling-video',
          set: () => {
            setTimeout(() => {
              previewMedia.onloadedmetadata?.(new Event('loadedmetadata'));
            }, 0);
          },
        });
        previewMedia.load = vi.fn();
        return previewMedia;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/generate-video') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            predictionId: 'pred-kling',
            generationId: 'gen-kling',
            remainingCredits: 900,
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({
          status: 'succeeded',
          output: 'https://example.com/result.mp4',
          timing: null,
        }),
      } as Response;
    });
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

  /** Answers the page's remix request with this bundle, and every other request as a finished run. */
  function stubRemix(bundle: RemixSourceBundle) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => (String(input).includes('/api/remix-source')
        ? bundle
        : { status: 'succeeded', output: 'https://example.com/result.mp4', timing: null }),
    } as Response));
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
      const request = quoteRequestMock.mock.calls.at(-1)?.[0];
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

    const uploadedImage = await screen.findByAltText('Element 1');
    const uploadedMedia = uploadedImage.closest('div.relative');
    const removeButton = uploadedMedia?.querySelectorAll('button')[1];
    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton!);

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

    const extraImage = screen.getByAltText('Saved element 3');
    const removeButton = extraImage.closest('div.relative')?.querySelectorAll('button')[1];
    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton!);

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

    fireEvent.click(screen.getByText('Multi-Shot'));

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
      key === 'create-video:start-image' ? startFrame : null
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
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));
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
        const request = quoteRequestMock.mock.calls.at(-1)?.[0];
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
        key === 'create-video:reference-videos'
          ? [{ id: 'saved-clip', displayName: 'Camera move', durationSeconds: 5, file: savedClip }]
          : []
      ));
      render(<CreateVideoClient prefill={{ model: 'minimax-h3' }} />);

      expect(await screen.findByText('Camera move')).toBeInTheDocument();
      expect(screen.getByText('5.0s clip')).toBeInTheDocument();
      await waitFor(() => {
        expect(quoteRequestMock.mock.calls.at(-1)?.[0]?.inputMetadata?.slots?.videoReferences)
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
        .toEqual(['gemini-omni-video']);
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
    fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

    expect(temporaryUploadMock).toHaveBeenCalledWith(file);

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

      fireEvent.click(screen.getByText('Multi-Shot'));
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

      fireEvent.click(screen.getByText('Multi-Shot'));
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

    it('stops a multi-shot run at a mention no Kling clip has, before the clip is uploaded', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      fireEvent.click(screen.getByText('Multi-Shot'));
      // One letter short.
      fireEvent.change(await screen.findByPlaceholderText('Describe shot 1...'), {
        target: { value: 'Open on @video_elemnt_1 in the rain, slow push in.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

      expect(await unknownMentionLine()).toBe('Unknown element mention: @video_elemnt_1');
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(postedRun()).toBeUndefined();
    });

    it('sends a multi-shot run whose shot mentions its Kling clip', async () => {
      const view = render(<CreateVideoClient prefill={{}} />);
      addKlingClip(view.container, 'clip.mp4');
      await waitFor(() => expect(cardHandles(view.container, KLING_RENAME)).toEqual(['@video_element_1']));

      fireEvent.click(screen.getByText('Multi-Shot'));
      fireEvent.change(await screen.findByPlaceholderText('Describe shot 1...'), {
        target: { value: 'Open on @video_element_1 in the rain, slow push in.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

      fireEvent.click(screen.getByText('Multi-Shot'));
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
        .filter(([key]) => key === 'create-video:kling-video-elements')
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
        .filter(([key]) => key === 'create-video:kling-video-elements')
        .at(-1)?.[1] ?? [];
      expect(saved).toHaveLength(2);
      first.unmount();
      getPersistedMediaRecordsMock.mockImplementation(async (key: string) => (
        key === 'create-video:kling-video-elements' ? saved : []
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
        return quoteRequestMock.mock.calls.at(-1)?.[0];
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

        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

      fireEvent.click(screen.getByText('Multi-Shot'));
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

      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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
        fireEvent.click(screen.getByText('Multi-Shot'));
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
        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

        // The words the server refuses the run with, said before anything is sent.
        expect(await unknownMentionLine()).toBe('Unknown element mention: @hero_creatr');
        expect(temporaryUploadMock).not.toHaveBeenCalled();
        expect(postedRun()).toBeUndefined();
      });

      it('sends a run whose shots mention its subjects', async () => {
        const view = await renderShotsWithSubjects('Hero creator');
        await attachSubjectImages(view.container);

        fireEvent.change(shotBox(), { target: { value: 'Open on @hero_creator in the rain, slow push in.' } });
        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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

        fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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
        `${prompt.length}/2500`,
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
        `${withUnknown.length}/2500`,
        'Unknown element mention: @ghost',
      ]);
    });

    it('says nothing in that row while the prompt mentions no saved reference', async () => {
      await renderWithSavedReferenceMentioned();
      fireEvent.change(promptBox(), { target: { value: 'A harbour at dusk' } });

      const row = promptBox().nextElementSibling;
      expect(row?.textContent).toBe('17/2500');
      expect(row?.children).toHaveLength(1);
    });

    it('refuses the run and names the mention', async () => {
      const view = await renderWithSavedReferenceMentioned();

      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

      expect(view.container.querySelector('p.text-red-400')?.textContent)
        .toBe('Kling 3.0 Cinematic cannot use @hero. Remove it from the prompt, or pick a model that takes reusable references.');
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalledWith('/api/generations', expect.objectContaining({ method: 'POST' }));
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
        if (key === 'create-video:reference-videos' && (saved.clip || saved.clips)) {
          return Array.from({ length: saved.clips ?? 1 }, (_, index) => ({
            id: `saved-clip-${index + 1}`,
            displayName: index === 0 ? 'Saved clip' : `Saved clip ${index + 1}`,
            file: new File(['clip'], `saved-clip-${index + 1}.mp4`, { type: 'video/mp4' }),
            durationSeconds: 4,
          }));
        }
        if (key === 'create-video:reference-audios' && saved.track) {
          return [{ id: 'saved-track', displayName: 'Saved track', file: new File(['track'], 'saved-track.mp3', { type: 'audio/mpeg' }), durationSeconds: 6 }];
        }
        if (key === 'create-video:kling-video-elements' && saved.klingClip) {
          return [{ id: 'saved-kling-clip', displayName: 'Saved Kling clip', handle: '@saved_kling_clip', file: new File(['clip'], 'saved-kling-clip.mp4', { type: 'video/mp4' }), durationSeconds: 4 }];
        }
        return [];
      });
      if (saved.startFrame) {
        getPersistedFileMock.mockImplementation(async (key: string) => (
          key === 'create-video:start-image' ? picture('start') : null
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
      const request = quoteRequestMock.mock.calls.at(-1)?.[0];
      expect(request).toBeTruthy();
      return request as GenerationModelQuoteInput & {
        settings: Record<string, unknown>;
        inputCounts: { images: number; videos: number; audios: number };
        inputMetadata: { slots: Record<string, { count: number }> };
      };
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

    /** One line of the run summary, by its label. */
    function runSummary(label: 'Reference' | 'Inputs') {
      return screen.getByText(label, { selector: 'div' }).nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
    }

    /** The group that holds the start frame, and whether the page has greyed it out. */
    function frameGroupLocked(container: HTMLElement) {
      const group = container.querySelector('#video-start-frame-input')?.closest('[aria-disabled]');
      expect(group).not.toBeNull();
      return group!.getAttribute('aria-disabled') === 'true';
    }

    function runInputs(slot: string) {
      return (postedRun()?.inputs ?? []).filter((input: { slot: string }) => input.slot === slot);
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
        imageReferences: request.inputMetadata.slots.imageReferences.count,
        videoReferences: request.inputMetadata.slots.videoReferences.count,
        audioReferences: request.inputMetadata.slots.audioReferences.count,
        videoElements: request.inputMetadata.slots.videoElements.count,
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
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images clips -')).toEqual(['gemini-omni-video']);
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
      expect(request.inputMetadata.slots.imageReferences.count).toBe(0);
      expect(request.inputMetadata.slots.startFrame.count).toBe(1);
      expect(refusedByTheServer(request)).toBeNull();

      // The page says the same of the run as its standby card does.
      expect(runSummary('Reference')).toBe('Start / end frames');
      expect(runSummary('Inputs')).toBe('1 frame + 0 video refs');
      expect(screen.getByText(/The latest render will take over this workspace\./).textContent)
        .toBe('Choose the shot structure, write the prompt, and set your frames. The latest render will take over this workspace.');
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
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));
      await waitFor(() => expect(postedRun()).toBeDefined());

      expect(postedRun().settings.referenceMode).toBe('frames');
      expect(runInputs('startFrame')).toHaveLength(1);
      expect(runInputs('imageReferences')).toHaveLength(0);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      expect(temporaryUploadMock.mock.calls[0][0]).toMatchObject({ name: 'start.png' });
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
      expect(runSummary('Reference')).toBe('Start / end frames');
      expect(runSummary('Inputs')).toBe('1 frame');
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
      expect(runSummary('Reference')).toBe('Start / end frames');
      expect(runSummary('Inputs')).toBe('0 frames');
      expect(lastQuoteRequest().settings.referenceMode).toBe('frames');

      // A frame attached now locks the references, as on a draft that holds no clip.
      fireEvent.change(view.container.querySelector<HTMLInputElement>('#video-start-frame-input')!, {
        target: { files: [picture('start')] },
      });
      expect(await screen.findByText(/cannot combine references with frames\. Clear your frames/)).toBeInTheDocument();
      expect(runSummary('Inputs')).toBe('1 frame');
    });

    it('counts the image and not the clip in a references run on Seedance 1.5 Pro', async () => {
      saveInTheBrowser({ images: 1, clip: true, track: true });
      render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);
      await screen.findByPlaceholderText('Rename element');
      await restored();

      expect(runSummary('Reference')).toBe('Reusable references');
      expect(runSummary('Inputs')).toBe('1 reference');
      const request = lastQuoteRequest();
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
      expect(screen.queryByText('Saved track')).toBeNull();
      expect(runSummary('Inputs')).toBe('2 references');
      expect(refusedByTheServer(lastQuoteRequest())).toBeNull();

      fireEvent.change(screen.getByPlaceholderText(/^Describe the Gemini Omni Video scene/), {
        target: { value: 'A dancer crosses a bright studio in the rhythm of the reference clip, slow push in, soft daylight.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));
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

      fireEvent.click(screen.getByRole('button', { name: 'Multi-Shot' }));
      await screen.findByText('Reusable references are paused in multi-shot');

      const request = lastQuoteRequest();
      expect(request.settings.referenceMode).toBe('frames');
      expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
      expect(request.inputMetadata.slots.imageReferences.count).toBe(0);
      expect(refusedByTheServer(request)).toBeNull();
      expect(frameGroupLocked(view.container)).toBe(false);

      fireEvent.change(screen.getByPlaceholderText('Describe shot 1...'), {
        target: { value: 'A lighthouse keeper climbs the stairs with a lamp, the camera rising with him, warm light on stone.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));
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
      expect(request.inputMetadata.slots.videoReferences.count).toBe(0);

      fireEvent.change(screen.getByPlaceholderText(/^Describe the Kling O3 scene/), {
        target: { value: '@hero_creator lifts the serum and smiles at the camera in a bright studio, slow push in.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));
      await waitFor(() => expect(postedRun()).toBeDefined());

      expect(postedRun().settings.referenceMode).toBe('subjects');
      expect(runInputs('subjectImages')).toHaveLength(2);
      expect(runInputs('videoReferences')).toHaveLength(0);
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
        `${prompt.length}/2500`,
        'On standby here: @saved_image_1, @saved_image_2',
      ]);

      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

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
});
