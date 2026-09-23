import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateMotionClient from '@/app/create-motion/CreateMotionClient';

const modelCatalogState = vi.hoisted(() => ({ missingIds: [] as string[] }));

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
      summaries: [], missingIds: modelCatalogState.missingIds, detailsReady: true, isLoadingModels: false,
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
      error: null,
      isLoading: false,
      revision: 'test-catalog-rev',
      refetch: vi.fn(),
    }),
    useWebGenerationModelQuote: () => ({
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

describe('CreateMotionClient model notices', () => {
  beforeEach(() => {
    modelCatalogState.missingIds = [];
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
});
