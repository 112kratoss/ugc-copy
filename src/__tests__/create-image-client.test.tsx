import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImageClient from '@/app/create-image/CreateImageClient';
import type { PersistedImageElementRecord } from '@/lib/persisted-media';

const setPersistedImageElementRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string, _elements: PersistedImageElementRecord[]): Promise<void> => {
    void _key;
    void _elements;
  }
));
const getPersistedImageElementRecordsMock = vi.hoisted(() => vi.fn(
  async (_key: string): Promise<PersistedImageElementRecord[]> => {
    void _key;
    return [];
  }
));
const removePersistedMediaMock = vi.hoisted(() => vi.fn(async () => undefined));
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
}));
const restoredFile = new File(['image-bytes'], 'restored-element.png', { type: 'image/png' });

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
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    credits: 10_000,
    isLoading: false,
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
    updateCredits: vi.fn(),
  }),
}));

vi.mock('@/components/EnhancePromptButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublishToShowcaseModal', () => ({
  default: () => null,
}));

vi.mock('@/lib/persisted-media', () => ({
  PERSISTED_MEDIA_KEYS: {
    createImageReferences: 'create-image:references',
    createImageElementDrafts: 'create-image:element-drafts',
    createImageElements: 'create-image:elements',
  },
  getPersistedFiles: vi.fn(async () => []),
  getPersistedImageElementRecords: getPersistedImageElementRecordsMock,
  getPersistedValue: vi.fn(async () => null),
  removePersistedMedia: removePersistedMediaMock,
  setPersistedImageElementRecords: setPersistedImageElementRecordsMock,
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
      catalog: {
        revision: 'test-catalog-rev',
        schemaVersion: 1,
        defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-3.0' },
        models: [
          {
            id: 'nano-banana-2',
            kind: 'image',
            displayName: 'Nano Banana 2.0',
            description: 'Test image model',
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
    useWebGenerationModelQuote: () => ({
      status: 'ready',
      quote: {
        modelId: 'nano-banana-2',
        catalogRevision: 'test-catalog-rev',
        normalizedSettings: {},
        costCredits: 8,
      },
      error: null,
    }),
  };
});

describe('CreateImageClient persisted elements', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    setPersistedImageElementRecordsMock.mockClear();
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([{
      id: 'restored-element-1',
      displayName: 'Restored product',
      file: restoredFile,
    }]);
    removePersistedMediaMock.mockClear();
    generationCatalogRefetchMock.mockClear();
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
    maybeSingleMock.mockClear();
    URL.createObjectURL = vi.fn(() => 'blob:restored-element') as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it('does not rewrite uploaded elements when unrelated prompt state rerenders', async () => {
    const view = render(<CreateImageClient prefill={{}} />);

    expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledWith(restoredFile);
    });
    setPersistedImageElementRecordsMock.mockClear();
    removePersistedMediaMock.mockClear();

    fireEvent.change(screen.getByPlaceholderText('Describe the image you want to create...'), {
      target: { value: 'A polished product photograph' },
    });

    expect(setPersistedImageElementRecordsMock).not.toHaveBeenCalled();
    expect(removePersistedMediaMock).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(1);
      expect(removePersistedMediaMock).toHaveBeenCalledTimes(2);
    });
  });

  it('persists element uploads and removals', async () => {
    const view = render(<CreateImageClient prefill={{}} />);

    expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
    setPersistedImageElementRecordsMock.mockClear();
    removePersistedMediaMock.mockClear();

    const file = new File(['new-image'], 'new-element.png', { type: 'image/png' });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(1);
    });
    expect(setPersistedImageElementRecordsMock.mock.calls[0]?.[1]).toHaveLength(2);

    const uploadedImage = await screen.findByAltText('Element 2');
    const uploadedMedia = uploadedImage.closest('div.relative');
    const removeButton = uploadedMedia?.querySelectorAll('button')[1];
    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton!);

    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(2);
    });
    expect(setPersistedImageElementRecordsMock.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ displayName: 'Restored product', file: restoredFile }),
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(expect.stringContaining('blob:'));
  });

  it('preserves restored media exceeding the model limit and explains how to resolve it', async () => {
    const restoredRecords = Array.from({ length: 15 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    }));
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(restoredRecords);

    render(<CreateImageClient prefill={{}} />);

    await waitFor(() => {
      expect(screen.getAllByText('15/14')).not.toHaveLength(0);
    });
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();
    expect(setPersistedImageElementRecordsMock).not.toHaveBeenCalled();
  });

  it('clears the over-limit explanation once the extra reference is removed', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(Array.from({ length: 15 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    })));

    render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();

    const extraImage = await screen.findByAltText('Restored 15');
    const removeButton = extraImage.closest('div.relative')?.querySelectorAll('button')[1];
    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton!);

    await waitFor(() => {
      expect(screen.getAllByText('14/14')).not.toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Your references are preserved/)).not.toBeInTheDocument();
    });
  });
});

const imageModelSummaries = [
  { id: 'nano-banana-2', kind: 'image', displayName: 'Nano Banana 2.0', description: 'Test image model' },
  { id: 'imagen-4', kind: 'image', displayName: 'Imagen 4', description: 'Test prompt-only image model' },
];

function chooseModel(container: HTMLElement, displayName: string) {
  const picker = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  expect(picker).not.toBeNull();
  fireEvent.click(picker!);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(displayName) }));
}

describe('CreateImageClient model notices', () => {
  beforeEach(() => {
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([]);
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
    window.scrollTo = vi.fn();
  });

  it('titles a model notice as model settings, not as a remix', async () => {
    modelCatalogState.missingIds = ['nano-banana-2'];

    render(<CreateImageClient prefill={{}} />);

    expect(await screen.findByText(/This model is no longer available/)).toBeInTheDocument();
    expect(screen.queryByText('Remixing Community Creation')).not.toBeInTheDocument();
    expect(screen.getByText('Model settings')).toBeInTheDocument();
  });

  it('clears the missing-model notice once another model is chosen', async () => {
    modelCatalogState.missingIds = ['nano-banana-2'];
    modelCatalogState.summaries = imageModelSummaries;
    const view = render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByText(/This model is no longer available/)).toBeInTheDocument();
    // It lasts as long as the problem, so there is nothing to dismiss.
    expect(screen.queryByRole('button', { name: 'Dismiss model notice' })).not.toBeInTheDocument();

    chooseModel(view.container, 'Imagen 4');

    await waitFor(() => {
      expect(screen.queryByText(/This model is no longer available/)).not.toBeInTheDocument();
    });
  });

  it('clears the load-error notice once the model list loads again', async () => {
    modelCatalogState.error = new Error('Could not load models.');
    const view = render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByText('Could not load models.')).toBeInTheDocument();

    modelCatalogState.error = null;
    view.rerender(<CreateImageClient prefill={{}} />);

    await waitFor(() => {
      expect(screen.queryByText('Could not load models.')).not.toBeInTheDocument();
    });
  });

  it('lets the creator dismiss a settings-reset notice', async () => {
    // Ideogram V3 has no "auto" aspect ratio, so opening it resets the default one.
    render(<CreateImageClient prefill={{ model: 'ideogram-v3' }} />);
    expect(await screen.findByText(/Unsupported choices were reset/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss model notice' }));

    await waitFor(() => {
      expect(screen.queryByText(/Unsupported choices were reset/)).not.toBeInTheDocument();
    });
  });

  it('clears a settings-reset notice when the creator picks another model', async () => {
    modelCatalogState.summaries = imageModelSummaries;
    const view = render(<CreateImageClient prefill={{ model: 'ideogram-v3' }} />);
    expect(await screen.findByText(/Unsupported choices were reset/)).toBeInTheDocument();

    chooseModel(view.container, 'Imagen 4');

    await waitFor(() => {
      expect(screen.queryByText(/Unsupported choices were reset/)).not.toBeInTheDocument();
    });
  });
});
