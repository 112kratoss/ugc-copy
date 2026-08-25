import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateVideoClient from '@/app/create-video/CreateVideoClient';
import type { PersistedImageElementRecord, PersistedSubjectRecord } from '@/lib/persisted-media';

const mockPush = vi.fn();
const mockUpdateCredits = vi.fn();
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
const temporaryUploadMock = vi.hoisted(() => vi.fn());
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

vi.mock('@/app/components/AuthProvider', () => ({
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

vi.mock('@/app/components/EnhancePromptButton', () => ({
  default: () => null,
}));

vi.mock('@/app/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/app/components/PublishToShowcaseModal', () => ({
  default: () => null,
}));

vi.mock('@/lib/persisted-media', () => ({
  PERSISTED_MEDIA_KEYS: {
    createVideoStartImage: 'create-video:start-image',
    createVideoEndImage: 'create-video:end-image',
    createVideoElements: 'create-video:elements',
    createVideoReferenceMode: 'create-video:reference-mode',
    createVideoReferenceVideos: 'create-video:reference-videos',
    createVideoReferenceAudios: 'create-video:reference-audios',
    createVideoKlingVideoElements: 'create-video:kling-video-elements',
    createVideoKlingSubjects: 'create-video:kling-subjects',
    createVideoSeedanceAssets: 'create-video:seedance-assets',
  },
  getPersistedFile: vi.fn(async () => null),
  getPersistedImageElementRecords: getPersistedImageElementRecordsMock,
  getPersistedMediaRecords: vi.fn(async () => []),
  // Hydration loads every persisted slot in one Promise.all, so a missing mock
  // here rejects the whole load and silently disables ALL draft restoration.
  getPersistedSubjectRecords: getPersistedSubjectRecordsMock,
  getPersistedValue: vi.fn(async () => null),
  removePersistedMedia: vi.fn(async () => undefined),
  setPersistedFile: vi.fn(async () => undefined),
  setPersistedImageElementRecords: setPersistedImageElementRecordsMock,
  setPersistedMediaRecords: vi.fn(async () => undefined),
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
        ],
      },
      error: null,
      isLoading: false,
      revision: 'test-catalog-rev',
      refetch: generationCatalogRefetchMock,
    }),
    useWebGenerationModelQuote: () => ({
      status: 'ready',
      quote: {
        modelId: 'kling-3.0-video',
        catalogRevision: 'test-catalog-rev',
        normalizedSettings: {},
        costCredits: 12,
      },
      error: null,
    }),
  };
});

describe('CreateVideoClient Kling video elements', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalCreateElement = document.createElement.bind(document);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPush.mockClear();
    mockUpdateCredits.mockClear();
    generationCatalogRefetchMock.mockClear();
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
    setPersistedImageElementRecordsMock.mockClear();

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

    await screen.findByText('Reference mode');
    fireEvent.click(screen.getByRole('button', { name: /Reusable references/i }));

    const file = new File(['image-bytes'], 'video-element.png', { type: 'image/png' });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"][multiple]');
    expect(input).not.toBeNull();
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

  it('persists the clamped video element set when model capacity decreases', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(
      Array.from({ length: 3 }, (_, index) => ({
        id: `saved-element-${index + 1}`,
        displayName: `Saved element ${index + 1}`,
        file: new File([`image-${index + 1}`], `saved-element-${index + 1}.png`, { type: 'image/png' }),
      }))
    );

    render(<CreateVideoClient prefill={{ model: 'seedance-1.5-pro' }} />);

    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(1);
    });
    expect(setPersistedImageElementRecordsMock.mock.calls[0]?.[1]).toHaveLength(2);
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
    expect(screen.getByText('@Hero_creator')).toBeInTheDocument();
  });

  it('shows the named-subjects editor only for Kling O3 and enforces the image range', async () => {
    render(<CreateVideoClient prefill={{ model: 'kling-o3' }} />);

    expect(await screen.findByText('Named subjects')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add subject'));
    expect(screen.getByPlaceholderText('Subject name')).toHaveValue('Subject 1');
    // One subject with zero images is below the 2-image floor.
    expect(screen.getByText(/add at least 2/i)).toBeInTheDocument();
    // The handle chip is derived from the display name for @mentions.
    expect(screen.getByText('@Subject_1')).toBeInTheDocument();
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
});
