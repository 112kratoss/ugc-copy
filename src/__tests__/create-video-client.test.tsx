import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateVideoClient from '@/app/create-video/CreateVideoClient';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import type { PersistedImageElementRecord, PersistedMediaRecord, PersistedSubjectRecord } from '@/lib/persisted-media';
import type { EnhancerContext } from '@/lib/prompt-enhancer';
import type { RemixSourceBundle } from '@/lib/remix-source';

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

    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn((value: Blob) => {
      objectUrlSequence += 1;
      const label = value instanceof File ? value.name : 'media';
      return `blob:${label}:${objectUrlSequence}`;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'video') {
        const previewVideo = originalCreateElement('video') as HTMLVideoElement;
        Object.defineProperty(previewVideo, 'duration', {
          configurable: true,
          get: () => 4.2,
        });
        Object.defineProperty(previewVideo, 'src', {
          configurable: true,
          get: () => 'blob:kling-video',
          set: () => {
            setTimeout(() => {
              previewVideo.onloadedmetadata?.(new Event('loadedmetadata'));
            }, 0);
          },
        });
        previewVideo.load = vi.fn();
        return previewVideo;
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
    // A saved subject holds its name, not its handle, so the handle is built on load.
    expect(screen.getAllByText('@hero_creator').length).toBeGreaterThan(0);
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

    function stubRemix(bundle: RemixSourceBundle) {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => ({
        ok: true,
        json: async () => (String(input).includes('/api/remix-source')
          ? bundle
          : { status: 'succeeded', output: 'https://example.com/result.mp4', timing: null }),
      } as Response));
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
  });

  /**
   * A Kling O3 subject's @handle is written in lower case, as every other handle
   * is. It kept the capitals of the subject's name ("@Hero_creator", 2026-10-03),
   * and the code that reads handles out of a prompt reads lower case only. Typed
   * the way the card showed it, the handle was not read, and the "@" panel shut at
   * its first capital. Typed in lower case it was refused as an unknown element,
   * although that is the spelling the server gives the provider.
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

    async function renderWithSubjects(...names: string[]) {
      const view = render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);
      await screen.findByText('Named subjects');
      for (const name of names) {
        fireEvent.click(screen.getByText('Add subject'));
        fireEvent.change(subjectFields(view.container).at(-1)!, { target: { value: name } });
      }
      return view;
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
  });

  /**
   * A prompt that mentions a saved reference the selected model cannot take.
   *
   * A reference saved on one model stays in the browser, so a prompt on Kling 3.0
   * can still mention it. The row under the prompt answered "Switch to Reusable
   * references to use @hero", which named a mode switch the page lost when the
   * shape of a run became a reading of what is attached (#95). The line was left
   * showing only while the page had no catalog entry for the model, where
   * Generate is disabled (2026-10-03). The card that says the references are on
   * standby gives the model's reason, and Generate refuses the run with it.
   *
   * This file's catalog hook hands the page no descriptor, so the page reads its
   * built-in table here, which is the state the line showed in.
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

    it('says why on the standby card, and leaves the row under the prompt to the character count', async () => {
      await renderWithSavedReferenceMentioned();

      expect(screen.getByText(/Reusable image references are not available for Kling yet\./)).toBeInTheDocument();
      // The handle is one the page knows, so it is not an unknown mention either.
      const row = promptBox().nextElementSibling;
      expect(row?.textContent).toBe(`${prompt.length}/2500`);
      expect(row?.children).toHaveLength(1);
    });

    it('refuses the run with the reason the card gives', async () => {
      const view = await renderWithSavedReferenceMentioned();

      fireEvent.click(screen.getByRole('button', { name: /generate video/i }));

      expect(view.container.querySelector('p.text-red-400')?.textContent)
        .toBe('Reusable image references are not available for Kling yet.');
      expect(temporaryUploadMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalledWith('/api/generations', expect.objectContaining({ method: 'POST' }));
    });
  });
});
