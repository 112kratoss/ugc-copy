import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImageClient from '@/app/create-image/CreateImageClient';

const setPersistedImageElementRecordsMock = vi.hoisted(() => vi.fn(async () => undefined));
const getPersistedImageElementRecordsMock = vi.hoisted(() => vi.fn());
const removePersistedMediaMock = vi.hoisted(() => vi.fn(async () => undefined));
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
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

vi.mock('@/app/components/AuthProvider', () => ({
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
      error: null,
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

  it('persists the clamped element set when restored media exceeds the model limit', async () => {
    const restoredRecords = Array.from({ length: 15 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    }));
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(restoredRecords);

    render(<CreateImageClient prefill={{}} />);

    await waitFor(() => {
      expect(setPersistedImageElementRecordsMock).toHaveBeenCalledTimes(1);
    });
    expect(setPersistedImageElementRecordsMock.mock.calls[0]?.[1]).toHaveLength(14);
    expect(screen.getAllByText('14/14')).not.toHaveLength(0);
  });
});
