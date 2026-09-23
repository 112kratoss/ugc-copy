import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateMotionClient from '@/app/create-motion/CreateMotionClient';

const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
}));
const quoteState = vi.hoisted(() => ({ errorCode: null as string | null }));
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());

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
    createMotionCharacterImage: 'create-motion:character-image',
    createMotionReferenceVideo: 'create-motion:reference-video',
  },
  getPersistedFile: vi.fn(async () => null),
  removePersistedMedia: vi.fn(async () => undefined),
  setPersistedFile: vi.fn(async () => undefined),
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
            id: 'kling-3.0',
            kind: 'motion',
            displayName: 'Kling 3.0 Motion',
            description: 'Test motion model',
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
    useWebGenerationModelQuote: () => (quoteState.errorCode
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
      }),
  };
});

const motionModelSummaries = [
  { id: 'kling-3.0', kind: 'motion', displayName: 'Kling 3.0 Motion', description: 'Test motion model' },
  { id: 'kling-2.6', kind: 'motion', displayName: 'Kling 2.6', description: 'Test stable motion model' },
];

function chooseModel(container: HTMLElement, displayName: string) {
  const picker = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  expect(picker).not.toBeNull();
  fireEvent.click(picker!);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(displayName) }));
}

describe('CreateMotionClient model notices', () => {
  beforeEach(() => {
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
    quoteState.errorCode = null;
    generationCatalogRefetchMock.mockClear();
    maybeSingleMock.mockClear();
    window.scrollTo = vi.fn();
  });

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
    render(<CreateMotionClient prefill={{}} />);
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
    expect(await screen.findByText(/Review the refreshed options/)).toBeInTheDocument();

    chooseModel(view.container, 'Kling 2.6');

    await waitFor(() => {
      expect(screen.queryByText(/Review the refreshed options/)).not.toBeInTheDocument();
    });
  });
});
