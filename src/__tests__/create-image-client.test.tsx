import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImageClient from '@/app/create-image/CreateImageClient';
import { GenerationStatusRequestError } from '@/lib/generation-status-client';
import type { PersistedImageElementRecord } from '@/lib/persisted-media';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { TemporaryMediaReadUrlError } from '@/lib/temporary-media-upload';
// What the server quotes when it starts a run: for "the price of the run the page sends".
import { buildUnifiedGenerationQuoteInput, parseUnifiedGenerationRequest } from '@/lib/unified-generation-start-service';
import { quoteStandIn } from './fixtures/web-quote-stand-in';

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
const purgeLegacyPersistedMediaMock = vi.hoisted(() => vi.fn(async () => undefined));
const generationCatalogRefetchMock = vi.hoisted(() => vi.fn());
const testDescriptors = vi.hoisted(() => ({
  nanoBanana: {
    id: 'nano-banana-2',
    kind: 'image',
    displayName: 'Nano Banana 2.0',
    description: 'Test image model',
    controls: [] as unknown[],
    capabilities: {},
    inputs: {},
  },
  imagen: {
    id: 'imagen-4',
    kind: 'image',
    displayName: 'Imagen 4',
    description: 'Test prompt-only image model',
    controls: [] as unknown[],
    capabilities: {},
    inputs: {},
  },
}));
const modelCatalogState = vi.hoisted(() => ({
  missingIds: [] as string[],
  error: null as Error | null,
  summaries: [] as Array<{ id: string; kind: string; displayName: string; description: string }>,
  /** The models whose details have loaded; null is Nano Banana 2 alone. */
  models: null as Array<Record<string, unknown>> | null,
  /** False while the catalog has not arrived. */
  catalogReady: true,
}));
// Text drafts as the page saves and reads them, per tool and account.
const creatorDraftStore = vi.hoisted(() => new Map<string, unknown>());
const loadCreatorDraftMock = vi.hoisted(() => vi.fn(
  async (tool: string, userId: string): Promise<unknown> => creatorDraftStore.get(`${tool}:${userId}`) ?? null
));
const saveCreatorDraftMock = vi.hoisted(() => vi.fn(async (tool: string, userId: string, draft: unknown) => {
  creatorDraftStore.set(`${tool}:${userId}`, draft);
}));
const uploadMediaToTemporaryStorageMock = vi.hoisted(() => vi.fn(async (file: File) => ({
  signedUrl: `https://signed.example.com/uploads/${file.name}`,
  storagePath: `uploads/user-1/${file.name}`,
})));
const refreshTemporaryMediaUrlMock = vi.hoisted(() => vi.fn(
  async (storagePath: string) => `https://signed.example.com/refreshed/${storagePath}`
));
const fetchGenerationStatusWithRetryMock = vi.hoisted(() => vi.fn());
const deploymentRefreshState = vi.hoisted(() => ({ newBuildAvailable: false }));
const useDeploymentRefreshMock = vi.hoisted(() => vi.fn((enabled: boolean) => {
  void enabled;
  return { newBuildAvailable: deploymentRefreshState.newBuildAvailable };
}));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const authState = vi.hoisted(() => ({
  credits: 10_000 as number | null,
  session: { access_token: 'test-token', user: { id: 'user-1' } },
  updateCredits: vi.fn(),
}));
const getSessionMock = vi.hoisted(() => vi.fn());
const publishModalProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
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
  useRouter: () => routerMock,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    credits: authState.credits,
    isLoading: false,
    session: authState.session,
    updateCredits: authState.updateCredits,
  }),
}));

vi.mock('@/components/EnhancePromptButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
}));

vi.mock('@/components/PublishToShowcaseModal', () => ({
  default: (props: Record<string, unknown>) => {
    publishModalProps.current = props;
    return null;
  },
}));

vi.mock('@/lib/persisted-media', () => ({
  PERSISTED_MEDIA_KEYS: {
    createImageReferences: 'create-image:references',
    createImageElementDrafts: 'create-image:element-drafts',
    createImageElements: 'create-image:elements',
  },
  getPersistedImageElementRecords: getPersistedImageElementRecordsMock,
  purgeLegacyPersistedMedia: purgeLegacyPersistedMediaMock,
  removePersistedMedia: removePersistedMediaMock,
  scopedPersistedMediaKey: (key: string, userId: string) => `${key}:${userId}`,
  setPersistedImageElementRecords: setPersistedImageElementRecordsMock,
}));

vi.mock('@/lib/persisted-creator-draft', () => ({
  loadCreatorDraft: loadCreatorDraftMock,
  saveCreatorDraft: saveCreatorDraftMock,
}));

vi.mock('@/lib/temporary-media-upload', async () => {
  const actual = await vi.importActual<typeof import('@/lib/temporary-media-upload')>('@/lib/temporary-media-upload');
  return {
    ...actual,
    refreshTemporaryMediaUrl: refreshTemporaryMediaUrlMock,
    uploadMediaToTemporaryStorage: uploadMediaToTemporaryStorageMock,
  };
});

vi.mock('@/lib/generation-status-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-status-client')>('@/lib/generation-status-client');
  return { ...actual, fetchGenerationStatusWithRetry: fetchGenerationStatusWithRetryMock };
});

vi.mock('@/lib/use-deployment-refresh', () => ({
  useDeploymentRefresh: useDeploymentRefreshMock,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
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
      summaries: modelCatalogState.summaries,
      missingIds: modelCatalogState.missingIds,
      detailsReady: modelCatalogState.catalogReady,
      isLoadingModels: false,
      catalog: modelCatalogState.catalogReady ? {
        revision: 'test-catalog-rev',
        schemaVersion: 1,
        defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-3.0' },
        models: modelCatalogState.models ?? [testDescriptors.nanoBanana],
      } : null,
      error: modelCatalogState.error,
      isLoading: !modelCatalogState.catalogReady,
      revision: 'test-catalog-rev',
      refetch: generationCatalogRefetchMock,
    }),
    // Unless a test says otherwise, 8 credits, ready, and the price of the very request the page asked.
    useWebGenerationModelQuote: quoteHookStandIn(actual.WebCatalogRequestError),
  };
});

const SIGNED_IN_SESSION = { data: { session: { access_token: 'test-token', user: { id: 'user-1' } } } };

beforeEach(() => {
  creatorDraftStore.clear();
  quoteStandIn.reset(8);
  loadCreatorDraftMock.mockClear();
  saveCreatorDraftMock.mockClear();
  purgeLegacyPersistedMediaMock.mockClear();
  uploadMediaToTemporaryStorageMock.mockClear();
  refreshTemporaryMediaUrlMock.mockReset();
  refreshTemporaryMediaUrlMock.mockImplementation(async (storagePath: string) => `https://signed.example.com/refreshed/${storagePath}`);
  fetchGenerationStatusWithRetryMock.mockReset();
  deploymentRefreshState.newBuildAvailable = false;
  useDeploymentRefreshMock.mockClear();
  routerMock.push.mockClear();
  authState.credits = 10_000;
  authState.updateCredits.mockClear();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(SIGNED_IN_SESSION);
  modelCatalogState.models = null;
  modelCatalogState.catalogReady = true;
  publishModalProps.current = null;
  window.sessionStorage.clear();
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
    });
    // The stores from before media was kept per account are purged once on load, not at each write.
    expect(removePersistedMediaMock).not.toHaveBeenCalled();
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

  // Nano Banana 2, the default model, takes 10 references since the 2026-10-20 re-check
  // (14 before), so eleven restored pictures are one over.
  it('preserves restored media exceeding the model limit and explains how to resolve it', async () => {
    const restoredRecords = Array.from({ length: 11 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    }));
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(restoredRecords);

    render(<CreateImageClient prefill={{}} />);

    await waitFor(() => {
      expect(screen.getAllByText('11/10')).not.toHaveLength(0);
    });
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();
    expect(setPersistedImageElementRecordsMock).not.toHaveBeenCalled();
  });

  it('prices the ten pictures a run would send while eleven are on the grid', async () => {
    // The run sends the pictures the model takes (the first ten); the quote counted
    // every picture on the grid, so its price was not the price of any run the page sends.
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(Array.from({ length: 11 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    })));

    render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();

    const request = quoteStandIn.lastRequest();
    expect(request?.inputCounts).toMatchObject({ images: 10, videos: 0, audios: 0 });
    expect(request?.inputMetadata?.slots).toEqual({ imageReferences: { count: 10 } });
  });

  it('clears the over-limit explanation once the extra reference is removed', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(Array.from({ length: 11 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    })));

    render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();

    const extraImage = await screen.findByAltText('Restored 11');
    const removeButton = extraImage.closest('div.relative')?.querySelectorAll('button')[1];
    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton!);

    await waitFor(() => {
      expect(screen.getAllByText('10/10')).not.toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Your references are preserved/)).not.toBeInTheDocument();
    });
  });
});

/**
 * An element's @handle follows its name. Renaming used to leave the old handle on
 * the card (2026-10-02): the name read "Red jacket", the handle stayed
 * "@restored_product", typing "@red_jacket" was refused as unknown, and the next
 * page load swapped the two, because a saved element carried no handle and got
 * one from its name.
 */
describe('CreateImageClient element handles', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const promptPlaceholder = 'Describe the image you want to create...';

  beforeEach(() => {
    setPersistedImageElementRecordsMock.mockClear();
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([{
      id: 'restored-element-1',
      displayName: 'Restored product',
      file: restoredFile,
    }]);
    removePersistedMediaMock.mockClear();
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
    URL.createObjectURL = vi.fn(() => 'blob:restored-element') as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renameCard(container: HTMLElement, index: number, nextName: string) {
    const field = container.querySelectorAll<HTMLInputElement>('input[placeholder="Rename element"]')[index];
    fireEvent.change(field, { target: { value: nextName } });
    fireEvent.keyDown(field, { key: 'Enter' });
  }

  /**
   * Types a name into a card's field and presses Escape, as a creator who thinks
   * better of a rename does. The field holds the focus, as it does on the page:
   * Escape leaves the field, and jsdom tells only the focused element that it
   * was left.
   */
  async function typeNameThenEscape(container: HTMLElement, index: number, typedName: string) {
    const field = container.querySelectorAll<HTMLInputElement>('input[placeholder="Rename element"]')[index];
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

  /** The @handle each element card shows, in card order. */
  function cardHandles(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[placeholder="Rename element"]')).map((field) => {
      // The card body is the name field's nearest ancestor that holds the Insert button.
      let card = field.parentElement;
      while (card && !Array.from(card.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Insert')) {
        card = card.parentElement;
      }
      return Array.from(card?.querySelectorAll('span') ?? [])
        .find((span) => /^@\w+$/.test(span.textContent ?? ''))?.textContent ?? null;
    });
  }

  function lastPersistedRecords() {
    return setPersistedImageElementRecordsMock.mock.calls.at(-1)?.[1] ?? [];
  }

  it('gives a renamed element the handle of its new name, and the prompt follows', async () => {
    const view = render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(cardHandles(view.container)).toEqual(['@restored_product']));

    const promptBox = screen.getByPlaceholderText(promptPlaceholder);
    fireEvent.change(promptBox, { target: { value: 'A portrait of @restored_product, and @restored_product again.' } });

    renameCard(view.container, 0, 'Red jacket');

    await waitFor(() => expect(cardHandles(view.container)).toEqual(['@red_jacket']));
    expect(promptBox).toHaveValue('A portrait of @red_jacket, and @red_jacket again.');
    // Nothing on the page still offers the old handle, and the prompt has no stale mention.
    expect(screen.queryByText('@restored_product')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
  });

  it('accepts the new handle typed by hand straight after a rename', async () => {
    const view = render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(cardHandles(view.container)).toEqual(['@restored_product']));

    renameCard(view.container, 0, 'Red jacket');
    await waitFor(() => expect(screen.getByDisplayValue('Red jacket')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(promptPlaceholder), {
      target: { value: 'A portrait of @red_jacket in the rain' },
    });

    expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    expect(cardHandles(view.container)).toEqual(['@red_jacket']);
  });

  // Escape in the name field renamed the element to what had been typed (2026-10-03).
  it('puts the old name back when Escape is pressed in the name field', async () => {
    const view = render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(cardHandles(view.container)).toEqual(['@restored_product']));
    const promptBox = screen.getByPlaceholderText(promptPlaceholder);
    fireEvent.change(promptBox, { target: { value: 'A portrait of @restored_product in the rain' } });

    const field = await typeNameThenEscape(view.container, 0, 'Red jacket');

    // Escape left the field, and nothing took the name that was typed.
    expect(field).not.toHaveFocus();
    expect(field).toHaveValue('Restored product');
    expect(cardHandles(view.container)).toEqual(['@restored_product']);
    expect(promptBox).toHaveValue('A portrait of @restored_product in the rain');
    const savedNames = setPersistedImageElementRecordsMock.mock.calls
      .flatMap(([, records]) => records.map((record) => record.displayName));
    expect(savedNames).not.toContain('Red jacket');
  });

  it('keeps the "@" panel open at a capital letter, and inserts the handle from it', async () => {
    const view = render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(cardHandles(view.container)).toEqual(['@restored_product']));

    // The element is called "Restored product", so this is how a creator starts to
    // look for it. The panel shut at the capital (2026-10-03).
    const promptBox = screen.getByPlaceholderText(promptPlaceholder);
    fireEvent.change(promptBox, { target: { value: 'A portrait of @R' } });

    const title = await screen.findByText('Insert element');
    // The panel is the title's nearest ancestor that holds an element to pick.
    let panel = title.parentElement;
    while (panel && !panel.querySelector('button')) {
      panel = panel.parentElement;
    }
    const suggestion = Array.from(panel?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.includes('@restored_product'));
    expect(suggestion).toBeDefined();

    fireEvent.click(suggestion!);

    // What was typed is replaced by the handle as it is written.
    expect(promptBox).toHaveValue('A portrait of @restored_product');
    expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
  });

  it('shows the same handles after a reload as before it', async () => {
    const first = render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(cardHandles(first.container)).toEqual(['@restored_product']));

    // A second element with the same name takes a numbered handle.
    const input = first.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    fireEvent.change(input!, { target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] } });
    await waitFor(() => expect(cardHandles(first.container)).toHaveLength(2));
    renameCard(first.container, 1, 'Restored product');
    await waitFor(() => expect(cardHandles(first.container)).toEqual(['@restored_product', '@restored_product_2']));

    // Renaming the first one frees "@restored_product". The second keeps the handle
    // the prompt already uses for it.
    renameCard(first.container, 0, 'Red jacket');
    await waitFor(() => expect(cardHandles(first.container)).toEqual(['@red_jacket', '@restored_product_2']));
    const beforeReload = cardHandles(first.container);

    // The reload: the page goes away, and the next one starts from what was saved.
    await waitFor(() => expect(lastPersistedRecords()).toHaveLength(2));
    const saved = lastPersistedRecords();
    first.unmount();
    getPersistedImageElementRecordsMock.mockResolvedValue(saved);

    const second = render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(cardHandles(second.container)).toEqual(beforeReload));
    expect(screen.getByDisplayValue('Red jacket')).toBeInTheDocument();
  });

  describe('on a remix', () => {
    // The handles the original prompt was written with. Neither is the handle its
    // element's name would give ("@hero_shot", "@umbrella").
    const bundle: RemixSourceBundle = {
      generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead walks past @prop at dusk', category: 'image', model: 'nano-banana-2' },
      result: { mediaType: 'image', url: 'https://example.com/result.png' },
      inputs: {
        image: {
          elements: [
            { id: 'remix-1', displayName: 'Hero shot', handle: '@lead', url: 'https://signed.example.com/lead.png', storagePath: 'generation_inputs/owner-1/gen-1/00.png', sourceGenerationId: 'gen-1' },
            { id: 'remix-2', displayName: 'Umbrella', handle: '@prop', url: 'https://signed.example.com/prop.png', storagePath: 'generation_inputs/owner-1/gen-1/01.png', sourceGenerationId: 'gen-1' },
          ],
        },
      },
      workflowSettings: { model: 'nano-banana-2' },
      restoreIssues: [],
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => bundle } as Response)));
    });

    it('keeps a restored handle until its own element is renamed', async () => {
      const view = render(<CreateImageClient prefill={{ remixId: 'gen-1' }} />);
      await waitFor(() => expect(cardHandles(view.container)).toEqual(['@lead', '@prop']));
      const promptBox = screen.getByPlaceholderText(promptPlaceholder);
      expect(promptBox).toHaveValue('@lead walks past @prop at dusk');

      // Renaming the other element, and adding one, leave "@lead" alone.
      renameCard(view.container, 1, 'Red umbrella');
      await waitFor(() => expect(cardHandles(view.container)).toEqual(['@lead', '@red_umbrella']));
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
      fireEvent.change(input!, { target: { files: [new File(['third'], 'third.png', { type: 'image/png' })] } });
      await waitFor(() => expect(cardHandles(view.container)).toEqual(['@lead', '@red_umbrella', '@element_3']));
      expect(promptBox).toHaveValue('@lead walks past @red_umbrella at dusk');

      renameCard(view.container, 0, 'Captain');
      await waitFor(() => expect(cardHandles(view.container)).toEqual(['@captain', '@red_umbrella', '@element_3']));
      expect(promptBox).toHaveValue('@captain walks past @red_umbrella at dusk');
      expect(screen.queryByText(/Unknown element mention/)).not.toBeInTheDocument();
    });

    it('says so when the model now takes fewer references than the run used', async () => {
      // Nano Banana 2 takes 10 since 2026-10-20; a run from before could hold 14.
      const twelve = Array.from({ length: 12 }, (_, index) => ({
        id: `remix-${index + 1}`,
        displayName: `Ref ${index + 1}`,
        handle: `@ref_${index + 1}`,
        url: `https://signed.example.com/${index + 1}.png`,
        storagePath: `generation_inputs/owner-1/gen-1/${String(index).padStart(2, '0')}.png`,
        sourceGenerationId: 'gen-1',
      }));
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...bundle, inputs: { image: { elements: twelve } } }),
      } as Response)));

      const view = render(<CreateImageClient prefill={{ remixId: 'gen-1' }} />);

      await waitFor(() => expect(cardHandles(view.container)).toHaveLength(10));
      expect(await screen.findByText(/takes up to 10 reference images, so 10 of this run's 12 came back\./)).toBeInTheDocument();
    });

    it('does not hand a restored handle to another element that is renamed to match it', async () => {
      const view = render(<CreateImageClient prefill={{ remixId: 'gen-1' }} />);
      await waitFor(() => expect(cardHandles(view.container)).toEqual(['@lead', '@prop']));

      // "Prop" would give "@prop", which the second element still holds.
      renameCard(view.container, 0, 'Prop');

      await waitFor(() => expect(cardHandles(view.container)).toEqual(['@prop_2', '@prop']));
      expect(screen.getByPlaceholderText(promptPlaceholder)).toHaveValue('@prop_2 walks past @prop at dusk');
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

const PENDING_START_KEY = 'magicbooklet:pending-generation-start:v1:image';
const OUTPUT_URL = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/run-1.png?token=signed';
const PROMPT_PLACEHOLDER = 'Describe the image you want to create...';
const HARBOUR_REMIX: RemixSourceBundle = {
  generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead walks past @prop at dusk', category: 'image', model: 'nano-banana-2' },
  result: { mediaType: 'image', url: 'https://example.com/result.png' },
  inputs: {
    image: {
      elements: [
        { id: 'remix-1', displayName: 'Hero shot', handle: '@lead', url: 'https://signed.example.com/lead.png', storagePath: 'generation_inputs/owner-1/gen-1/00.png', sourceGenerationId: 'gen-1' },
        { id: 'remix-2', displayName: 'Umbrella', handle: '@prop', url: 'https://signed.example.com/prop.png', storagePath: 'generation_inputs/owner-1/gen-1/01.png', sourceGenerationId: 'gen-1' },
      ],
    },
  },
  workflowSettings: { model: 'nano-banana-2' },
  restoreIssues: [],
};

type StartReply = { status: number; body: unknown } | Error | 'hang';

function startedReply(overrides: Record<string, unknown> = {}): StartReply {
  return {
    status: 200,
    body: {
      success: true,
      predictionId: 'pred-1',
      generationId: 'gen-new',
      status: 'processing',
      remainingCredits: 9_992,
      cost: 8,
      catalogRevision: 'test-catalog-rev',
      modelId: 'nano-banana-2',
      ...overrides,
    },
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Answers the start POSTs in order, and the creation read the publish modal makes. */
function installFetch({ starts = [], publishDetails = null, remixBundle = null }: {
  starts?: StartReply[];
  publishDetails?: unknown;
  remixBundle?: RemixSourceBundle | null;
} = {}) {
  const replies = [...starts];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/generations' && init?.method === 'POST') {
      const reply = replies.shift();
      if (!reply) throw new Error('No start reply left');
      if (reply === 'hang') return new Promise<Response>(() => undefined);
      if (reply instanceof Error) throw reply;
      return jsonResponse(reply.status, reply.body);
    }
    if (url.startsWith('/api/generations?')) return jsonResponse(200, publishDetails ?? { generations: [] });
    if (url.startsWith('/api/remix-source?') && remixBundle) return jsonResponse(200, remixBundle);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function startCalls(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/generations' && init?.method === 'POST');
}

function startKey(call: unknown[]) {
  return ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];
}

function startBody(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body)) as {
    prompt: string;
    settings: Record<string, unknown>;
    inputs: Array<Record<string, unknown>>;
    expectedCostCredits?: unknown;
  };
}

function typePrompt(value: string) {
  fireEvent.change(screen.getByPlaceholderText(PROMPT_PLACEHOLDER), { target: { value } });
}

function pressGenerate() {
  fireEvent.click(screen.getByRole('button', { name: /Generate Image/ }));
}

function frameShown() {
  return screen.getByText('Frame').nextElementSibling?.textContent;
}

/** The price on the run panel. */
function costShown() {
  return screen.getByText('Cost').nextElementSibling?.textContent;
}

async function findResult() {
  return screen.findByRole('button', { name: 'Preview generated image 1' });
}

/** Lets the mount read of the saved draft finish: until it has, a press does not save over it. */
async function settleDraftRead() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('CreateImageClient generation pipeline', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([]);
    setPersistedImageElementRecordsMock.mockClear();
    removePersistedMediaMock.mockClear();
    maybeSingleMock.mockClear();
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = [];
    fetchGenerationStatusWithRetryMock.mockResolvedValue({ status: 'succeeded', output: OUTPUT_URL, outputs: [OUTPUT_URL] });
    URL.createObjectURL = vi.fn(() => 'blob:element') as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('a start the server never answered', () => {
    it('keeps its key and replays the same request when Check again is pressed', async () => {
      const fetchMock = installFetch({ starts: [new TypeError('Failed to fetch'), startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByText('We couldn’t confirm your generation started. Check again — that can’t start a second run.')).toBeInTheDocument();
      const [first] = startCalls(fetchMock);
      expect(JSON.parse(window.sessionStorage.getItem(PENDING_START_KEY) ?? 'null')).toMatchObject({
        idempotencyKey: startKey(first),
        userId: 'user-1',
        body: { prompt: 'A lighthouse at dawn', expectedCostCredits: 8 },
      });

      // The price moves meanwhile. Checking again is the same attempt, so it goes with the
      // price it was sent with: another body under the same key is refused as a reused key.
      quoteStandIn.answers = [10];
      typePrompt('A lighthouse at dawn, in fog');
      expect(screen.getByRole('button', { name: 'Start a new run · 10 credits' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));
      const [, second] = startCalls(fetchMock);
      expect(startKey(second)).toBe(startKey(first));
      expect((second[1] as RequestInit).body).toBe((first[1] as RequestInit).body);
      expect(await findResult()).toBeInTheDocument();
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
    });

    it('drops the key after a refusal, so the next press is a new request', async () => {
      const fetchMock = installFetch({
        starts: [
          { status: 422, body: { code: 'INVALID_GENERATION_REQUEST', error: 'Prompts support up to 10000 characters.' } },
          startedReply(),
        ],
      });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByText('Prompts support up to 10000 characters.')).toBeInTheDocument();
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
      // The refusal is about the prompt, so the prompt is where the creator lands.
      expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveFocus();

      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));
      const [first, second] = startCalls(fetchMock);
      expect(startKey(second)).not.toBe(startKey(first));
    });

    it('offers a new run instead, priced, under a key of its own', async () => {
      const fetchMock = installFetch({ starts: [new TypeError('Failed to fetch'), startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      fireEvent.click(await screen.findByRole('button', { name: 'Start a new run · 8 credits' }));

      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));
      const [first, second] = startCalls(fetchMock);
      expect(startKey(second)).not.toBe(startKey(first));
      expect(await findResult()).toBeInTheDocument();
    });

    // The body is sent as it was saved, whatever the price shows now: with the price it was
    // sent with, or with none from a page before prices were sent.
    it.each([
      ['with no price', {}],
      ['with the price it was sent with', { expectedCostCredits: 6 }],
    ])('is replayed on load %s, before the lookup for a running one', async (_case, price) => {
      const body = { kind: 'image', modelId: 'nano-banana-2', prompt: 'A kept prompt', settings: {}, inputs: [], catalogRevision: 'test-catalog-rev', ...price };
      window.sessionStorage.setItem(PENDING_START_KEY, JSON.stringify({
        version: 1,
        tool: 'image',
        idempotencyKey: 'image:kept-key',
        body,
        catalogRevision: 'test-catalog-rev',
        createdAt: new Date().toISOString(),
        userId: 'user-1',
      }));
      const fetchMock = installFetch({ starts: [startedReply()] });

      render(<CreateImageClient prefill={{}} />);

      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
      expect(startKey(startCalls(fetchMock)[0])).toBe('image:kept-key');
      expect(startBody(startCalls(fetchMock)[0])).toEqual({ schemaVersion: 3, ...body });
      expect(await findResult()).toBeInTheDocument();
      expect(maybeSingleMock).not.toHaveBeenCalled();
    });
  });

  it('hands a run whose status checks keep failing to Studio instead of ending it', async () => {
    fetchGenerationStatusWithRetryMock.mockRejectedValue(new GenerationStatusRequestError('Failed to fetch generation status', 500));
    installFetch({ starts: [startedReply()] });
    render(<CreateImageClient prefill={{}} />);
    typePrompt('A lighthouse at dawn');
    pressGenerate();

    expect((await screen.findAllByText('Image still processing')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Failed to fetch generation status')).not.toBeInTheDocument();

    const [{ url, getAccessToken }] = fetchGenerationStatusWithRetryMock.mock.calls[0] as [{
      url: string;
      getAccessToken: () => Promise<string | null>;
    }];
    expect(url).toBe('/api/generate-image?id=pred-1');
    // Each check reads the session again rather than reusing the token of the press.
    getSessionMock.mockResolvedValueOnce({ data: { session: { access_token: 'refreshed-token', user: { id: 'user-1' } } } });
    await expect(getAccessToken()).resolves.toBe('refreshed-token');
  });

  it('prices exactly the run it sends', async () => {
    // The server quotes a run again from the inputs it posts when it starts it, and
    // charges or refuses that quote, so the page asks for its price with that quote.
    getPersistedImageElementRecordsMock.mockResolvedValue([{ id: 'restored-1', displayName: 'Restored product', file: restoredFile }]);
    const fetchMock = installFetch({ starts: [startedReply()] });
    render(<CreateImageClient prefill={{}} />);
    expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
    const shown = quoteStandIn.lastRequest();
    expect(shown?.inputCounts).toMatchObject({ images: 1 });

    typePrompt('A portrait of @restored_product');
    pressGenerate();
    await findResult();

    const started = buildUnifiedGenerationQuoteInput(
      parseUnifiedGenerationRequest(startBody(startCalls(fetchMock)[0]) as unknown as Record<string, unknown>),
    );
    // This file's catalog hook makes up a revision of its own; the question is the rest.
    expect({ ...shown, catalogRevision: undefined }).toEqual({ ...started, catalogRevision: undefined });
    // The run's own quote input is the request that was priced, so the price goes with it.
    expect(startBody(startCalls(fetchMock)[0]).expectedCostCredits).toBe(8);
  });

  // The start charges its own price up to the one the creator was shown, and refuses a run
  // it prices above it (`cost_changed`) before any credits are held.
  describe('the price it shows', () => {
    it('goes with the run, as the most the start may charge', async () => {
      getPersistedImageElementRecordsMock.mockResolvedValue([{ id: 'restored-1', displayName: 'Restored product', file: restoredFile }]);
      const fetchMock = installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
      typePrompt('A portrait of @restored_product');
      expect(costShown()).toBe('8 credits');

      pressGenerate();
      await findResult();

      expect(startBody(startCalls(fetchMock)[0]).expectedCostCredits).toBe(8);
    });

    it.each([
      ['answers another request than the run’s', { forAnotherRequest: true }],
      ['is not a whole number of credits', { answers: [8.5] }],
    ])('stays off the run when the quote %s', async (_case, answer) => {
      Object.assign(quoteStandIn, answer);
      const fetchMock = installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');

      pressGenerate();
      await findResult();

      // The run goes, and the start charges its own price, as it did before a price was sent.
      expect(startCalls(fetchMock)).toHaveLength(1);
      expect(startBody(startCalls(fetchMock)[0])).not.toHaveProperty('expectedCostCredits');
    });

    it('holds the run while it is not ready, and goes with it once it is', async () => {
      quoteStandIn.answers = ['pending'];
      const fetchMock = installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      expect(costShown()).toBe('Calculating...');

      pressGenerate();
      await settleDraftRead();
      expect(screen.getByRole('button', { name: /Generate Image/ })).toBeDisabled();
      expect(startCalls(fetchMock)).toHaveLength(0);

      quoteStandIn.answers = [8];
      typePrompt('A lighthouse at dawn, in fog');
      expect(costShown()).toBe('8 credits');
      pressGenerate();
      await findResult();

      expect(startBody(startCalls(fetchMock)[0]).expectedCostCredits).toBe(8);
    });

    it('is asked for again when the server says it changed, and the next run goes at the new price under a new key', async () => {
      quoteStandIn.answers = [8, 10];
      const fetchMock = installFetch({
        starts: [
          { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } },
          startedReply({ cost: 10 }),
        ],
      });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      expect(quoteStandIn.lastAttempt()).toBe(0);
      expect(costShown()).toBe('8 credits');
      pressGenerate();

      expect(await screen.findByText('The price of this run changed. Check the updated cost and generate again.')).toBeInTheDocument();
      expect(quoteStandIn.lastAttempt()).toBe(1);
      expect(costShown()).toBe('10 credits');
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();

      pressGenerate();
      await findResult();

      const [refused, next] = startCalls(fetchMock);
      expect(startBody(refused).expectedCostCredits).toBe(8);
      expect(startBody(next).expectedCostCredits).toBe(10);
      expect(startKey(next)).not.toBe(startKey(refused));
    });

    it('keeps Retry quote in reach when it cannot be read again after it changed', async () => {
      quoteStandIn.answers = [8, 'error', 10];
      const fetchMock = installFetch({
        starts: [
          { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } },
          startedReply({ cost: 10 }),
        ],
      });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByText('The price of this run changed. Check the updated cost and generate again.')).toBeInTheDocument();
      expect(costShown()).toBe('Unavailable');
      expect(screen.getByRole('button', { name: /Generate Image/ })).toBeDisabled();

      // Generate waits for a price, and asking again is the only way to one.
      fireEvent.click(screen.getByRole('button', { name: 'Retry quote' }));

      expect(costShown()).toBe('10 credits');
      pressGenerate();
      await findResult();
      expect(startBody(startCalls(fetchMock)[1]).expectedCostCredits).toBe(10);
    });

    it('says the page is out of date and holds Generate for a reload when asking again leaves a remix at the refused price', async () => {
      // A remix sends from the page it is on, past a deploy too. When that deploy changed how
      // its run is priced, the page's quote of the run and the start's disagree: asked again,
      // the price did not move, and each press was refused the same way until a reload.
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });
      const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
      const fetchMock = installFetch({ starts: [costChanged, costChanged, costChanged], remixBundle: HARBOUR_REMIX });
      render(<CreateImageClient prefill={{ remixId: 'gen-1' }} />);
      await waitFor(() => expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('@lead walks past @prop at dusk'));
      expect(costShown()).toBe('8 credits');

      pressGenerate();

      const notice = await screen.findByRole('alert');
      expect(notice).toHaveTextContent('This page is out of date, so it cannot show what this run costs.');
      expect(notice).toHaveTextContent('The remix starts again from the original.');
      // Asked again once, and the start's refusal stood: the same run at the same price.
      expect(quoteStandIn.lastAttempt()).toBe(1);
      expect(costShown()).toBe('8 credits');
      expect(screen.getByRole('button', { name: /Generate Image/ })).toBeDisabled();
      pressGenerate();
      await settleDraftRead();
      expect(startCalls(fetchMock)).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      // A remix keeps no draft, and this one is not saved over the creator's own.
      expect(saveCreatorDraftMock).not.toHaveBeenCalled();
    });

    it('keeps the draft through the reload it offers on a page of its own', async () => {
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });
      const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
      installFetch({ starts: [costChanged] });
      render(<CreateImageClient prefill={{}} />);
      await settleDraftRead();
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is kept.');
      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(saveCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1', expect.objectContaining({ prompt: 'A lighthouse at dawn' }));
    });

    it('lets the creator go on with another run, which the refusal does not hold', async () => {
      const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
      const fetchMock = installFetch({ starts: [costChanged, startedReply()] });
      const view = render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      expect(await screen.findByRole('alert')).toHaveTextContent('This page is out of date');

      // Another run is priced on its own: nothing has refused it.
      fireEvent.click(screen.getByRole('button', { name: '1:1' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Generate Image/ })).toBeEnabled();
      pressGenerate();
      await findResult();
      expect(startCalls(fetchMock)).toHaveLength(2);
      expect(startBody(startCalls(fetchMock)[1]).settings).toMatchObject({ aspectRatio: '1:1' });
      view.unmount();
    });
  });

  describe('a newer deploy', () => {
    it('is watched for only while the page is idle', async () => {
      installFetch({ starts: ['hang'] });
      render(<CreateImageClient prefill={{}} />);
      expect(useDeploymentRefreshMock).toHaveBeenLastCalledWith(true);

      typePrompt('A lighthouse at dawn');
      pressGenerate();

      await waitFor(() => expect(useDeploymentRefreshMock).toHaveBeenLastCalledWith(false));
    });

    it('is reloaded onto at the press, after the draft is saved, instead of sending', async () => {
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });
      const fetchMock = installFetch();
      render(<CreateImageClient prefill={{}} />);
      await settleDraftRead();

      deploymentRefreshState.newBuildAvailable = true;
      typePrompt('An idea worth keeping');
      pressGenerate();

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(saveCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1', expect.objectContaining({ prompt: 'An idea worth keeping' }));
      expect(startCalls(fetchMock)).toHaveLength(0);
    });
  });

  describe('the text draft', () => {
    it('is saved per account and comes back after a remount', async () => {
      installFetch();
      const first = render(<CreateImageClient prefill={{}} />);
      typePrompt('A red bicycle in fog');
      fireEvent.click(screen.getByRole('button', { name: '1:1' }));

      await waitFor(() => expect(saveCreatorDraftMock).toHaveBeenLastCalledWith('image', 'user-1', expect.objectContaining({
        prompt: 'A red bicycle in fog',
        modelId: 'nano-banana-2',
        aspectRatio: '1:1',
      })), { timeout: 2_000 });
      first.unmount();

      render(<CreateImageClient prefill={{}} />);

      await waitFor(() => expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('A red bicycle in fog'));
      expect(frameShown()).toBe('1:1');
    });

    it('brings its model back before the catalog would put its default in', async () => {
      creatorDraftStore.set('image:user-1', {
        prompt: 'A poster with bold type',
        modelId: 'imagen-4',
        aspectRatio: '16:9',
        resolution: '1K',
        qualityMode: 'standard',
        googleSearch: false,
        additionalSettings: {},
      });
      modelCatalogState.models = [testDescriptors.nanoBanana, testDescriptors.imagen];
      modelCatalogState.catalogReady = false;
      installFetch();
      const view = render(<CreateImageClient prefill={{}} />);
      await waitFor(() => expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('A poster with bold type'));

      // The catalog arrives after the draft, as it does over a network.
      modelCatalogState.catalogReady = true;
      view.rerender(<CreateImageClient prefill={{}} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const picker = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
      expect(picker).toHaveTextContent('Imagen 4');
      expect(frameShown()).toBe('16:9');
      expect(screen.queryByText(/Your previous image model is no longer available/)).not.toBeInTheDocument();
    });
  });

  it('keeps staged media under the signed-in account and purges the unscoped stores once', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValue([{ id: 'restored-1', displayName: 'Restored product', file: restoredFile }]);
    const view = render(<CreateImageClient prefill={{}} />);

    expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
    expect(getPersistedImageElementRecordsMock).toHaveBeenCalledWith('create-image:elements:user-1');
    expect(purgeLegacyPersistedMediaMock).toHaveBeenCalledTimes(1);

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    fireEvent.change(input!, { target: { files: [new File(['next'], 'next.png', { type: 'image/png' })] } });

    await waitFor(() => expect(setPersistedImageElementRecordsMock).toHaveBeenLastCalledWith(
      'create-image:elements:user-1',
      expect.arrayContaining([expect.objectContaining({ displayName: 'Restored product' })]),
    ));
    expect(removePersistedMediaMock).not.toHaveBeenCalled();
  });

  describe('a reference staged by an earlier press', () => {
    beforeEach(() => {
      getPersistedImageElementRecordsMock.mockResolvedValue([{ id: 'restored-1', displayName: 'Restored product', file: restoredFile }]);
    });

    async function generateTwice() {
      const fetchMock = installFetch({ starts: [startedReply(), startedReply({ predictionId: 'pred-2', generationId: 'gen-2' })] });
      render(<CreateImageClient prefill={{}} />);
      expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
      typePrompt('A portrait of @restored_product');
      pressGenerate();
      await findResult();
      return fetchMock;
    }

    it('is sent again as its staged copy, so two presses upload it once', async () => {
      const fetchMock = await generateTwice();
      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));

      expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalledTimes(1);
      expect(refreshTemporaryMediaUrlMock).toHaveBeenCalledWith('uploads/user-1/restored-element.png');
      const [first, second] = startCalls(fetchMock).map(startBody);
      expect(first.inputs[0]).toMatchObject({
        url: 'https://signed.example.com/uploads/restored-element.png',
        storagePath: 'uploads/user-1/restored-element.png',
        handle: '@restored_product',
      });
      expect(second.inputs[0]).toMatchObject({
        url: 'https://signed.example.com/refreshed/uploads/user-1/restored-element.png',
        storagePath: 'uploads/user-1/restored-element.png',
        handle: '@restored_product',
      });
    });

    it('is saved with its element, since a reload runs no cleanup', async () => {
      await generateTwice();
      await waitFor(() => expect(setPersistedImageElementRecordsMock).toHaveBeenCalledWith(expect.any(String), [
        expect.objectContaining({ staged: expect.objectContaining({ storagePath: 'uploads/user-1/restored-element.png' }) }),
      ]));
    });

    it('is sent again when a reload restores it with its element', async () => {
      const staged = { storagePath: 'uploads/user-1/restored-element.png', uploadedAt: Date.now() - 60 * 60 * 1000 };
      getPersistedImageElementRecordsMock.mockResolvedValue([{ id: 'restored-1', displayName: 'Restored product', file: restoredFile, staged }]);
      const fetchMock = installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
      typePrompt('A portrait of @restored_product');
      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));

      expect(uploadMediaToTemporaryStorageMock).not.toHaveBeenCalled();
      expect(startBody(startCalls(fetchMock)[0]).inputs[0]).toMatchObject({
        url: 'https://signed.example.com/refreshed/uploads/user-1/restored-element.png',
        storagePath: staged.storagePath,
      });
    });

    it('is uploaded again once storage no longer has it', async () => {
      const fetchMock = await generateTwice();
      refreshTemporaryMediaUrlMock.mockRejectedValueOnce(
        new TemporaryMediaReadUrlError('That upload is no longer available.', 404, 'MEDIA_OBJECT_NOT_FOUND'),
      );
      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));

      expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalledTimes(2);
    });

    it('is uploaded again after the server refuses it as expired', async () => {
      const fetchMock = installFetch({
        starts: [
          startedReply(),
          { status: 400, body: { code: 'invalid_input_media', error: 'This reference upload has expired. Add it again.' } },
          startedReply({ predictionId: 'pred-3', generationId: 'gen-3' }),
        ],
      });
      render(<CreateImageClient prefill={{}} />);
      expect((await screen.findAllByText('@restored_product')).length).toBeGreaterThan(0);
      typePrompt('A portrait of @restored_product');
      pressGenerate();
      await findResult();

      pressGenerate();
      expect(await screen.findByText('This reference upload has expired. Add it again.')).toBeInTheDocument();
      expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalledTimes(1);

      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(3));
      expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalledTimes(2);
    });

    it('is uploaded again once the sweep may have taken it', async () => {
      const fetchMock = await generateTwice();
      // The sweep deletes a used staged object 48 h after it was signed.
      const later = Date.now() + 41 * 60 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));

      expect(refreshTemporaryMediaUrlMock).not.toHaveBeenCalled();
      expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps elements on the grid, with their remove buttons, when a prompt-only model is chosen', async () => {
    modelCatalogState.summaries = imageModelSummaries;
    getPersistedImageElementRecordsMock.mockResolvedValue([{ id: 'restored-1', displayName: 'Restored product', file: restoredFile }]);
    const view = render(<CreateImageClient prefill={{}} />);
    await screen.findByAltText('Restored product');
    typePrompt('A portrait of @restored_product');

    chooseModel(view.container, 'Imagen 4');

    expect(await screen.findByText(/does not take reference images\. Your references are preserved/)).toBeInTheDocument();
    expect(screen.getByAltText('Restored product')).toBeInTheDocument();
    expect(screen.queryByText('Prompt-only model')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate Image/ })).toBeDisabled();
    // Nothing is sent to a prompt-only model, so the server would not know the mention either.
    expect(screen.getByText(/^Unknown element mention/)).toBeInTheDocument();

    const removeButton = screen.getByAltText('Restored product').closest('div.relative')?.querySelectorAll('button')[1];
    fireEvent.click(removeButton!);

    await waitFor(() => expect(screen.queryByAltText('Restored product')).not.toBeInTheDocument());
    expect(screen.getByText('Prompt-only model')).toBeInTheDocument();
    expect(screen.queryByText(/Your references are preserved/)).not.toBeInTheDocument();
  });

  it('starts with the settings it quoted, the chosen output format among them, and names the download after the output', async () => {
    modelCatalogState.models = [{
      ...testDescriptors.nanoBanana,
      controls: [{
        key: 'outputFormat',
        label: 'Output format',
        type: 'choice',
        presentation: 'select',
        defaultValue: 'jpg',
        options: [{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }],
      }],
    }];
    const fetchMock = installFetch({ starts: [startedReply()] });
    render(<CreateImageClient prefill={{}} />);

    fireEvent.change(screen.getByLabelText('Output format'), { target: { value: 'png' } });
    typePrompt('A lighthouse at dawn');
    pressGenerate();
    await findResult();

    expect(startBody(startCalls(fetchMock)[0]).settings).toEqual({
      aspectRatio: 'auto',
      resolution: '1K',
      qualityMode: 'standard',
      googleSearch: false,
      outputFormat: 'png',
    });
    const download = screen.getByRole('link', { name: /Download image/ });
    expect(download).toHaveAttribute('download', 'generated-image.png');
    expect(download.getAttribute('href')).toContain('filename=generated-image.png');
  });

  describe('a refusal or a failed run', () => {
    it('re-reads the balance and offers a top-up when the server says credits are short', async () => {
      const creditsUpdated = vi.fn();
      window.addEventListener('credits_updated', creditsUpdated);
      installFetch({ starts: [{ status: 402, body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 8 credits.' } }] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByText('Insufficient credits. This action costs 8 credits.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Top Up Credits/ })).toHaveAttribute('href', '/pricing');
      expect(screen.queryByRole('button', { name: /Generate Image/ })).not.toBeInTheDocument();
      expect(creditsUpdated).toHaveBeenCalled();
      window.removeEventListener('credits_updated', creditsUpdated);
    });

    it('puts the creator back in the prompt when the prompt is refused', async () => {
      installFetch({ starts: [{ status: 422, body: { code: 'prompt_blocked', error: 'Magicbooklet can’t create this. No credits were used.' } }] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByText('Magicbooklet can’t create this. No credits were used.')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveFocus();
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
    });

    it('says the credits came back when the run fails, and re-reads the balance', async () => {
      const creditsUpdated = vi.fn();
      window.addEventListener('credits_updated', creditsUpdated);
      fetchGenerationStatusWithRetryMock.mockResolvedValue({ status: 'failed', error: 'The provider could not render this' });
      installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByText('The provider could not render this. Your 8 credits were returned.')).toBeInTheDocument();
      expect(creditsUpdated).toHaveBeenCalled();
      window.removeEventListener('credits_updated', creditsUpdated);
    });
  });

  it('refuses a file the upload would refuse, by name, and says when picks pass the model’s limit', async () => {
    // Ideogram V3 takes one reference image.
    const view = render(<CreateImageClient prefill={{ model: 'ideogram-v3' }} />);
    const huge = new File(['h'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 26 * 1024 * 1024 });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');

    fireEvent.change(input!, {
      target: {
        files: [
          new File(['b'], 'scan.bmp', { type: 'image/bmp' }),
          huge,
          new File(['1'], 'first.png', { type: 'image/png' }),
          new File(['2'], 'second.png', { type: 'image/png' }),
        ],
      },
    });

    const notice = await screen.findByText(/“scan\.bmp” isn’t a JPEG, PNG, WebP, GIF, AVIF or HEIC image\./);
    expect(notice).toHaveTextContent('“huge.png” is larger than 25 MB.');
    expect(notice).toHaveTextContent('Added 1 of 2 images to stay within this model’s 1-image limit.');
    expect(await screen.findByAltText('Element 1')).toBeInTheDocument();
    expect(setPersistedImageElementRecordsMock.mock.calls.at(-1)?.[1]).toHaveLength(1);
  });

  it('shows the source prompt as the original, and the submitted prompt with the result', async () => {
    const bundle: RemixSourceBundle = {
      generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead walks past @prop at dusk', category: 'image', model: 'nano-banana-2' },
      result: { mediaType: 'image', url: 'https://example.com/result.png' },
      inputs: {
        image: {
          elements: [
            { id: 'remix-1', displayName: 'Hero shot', handle: '@lead', url: 'https://signed.example.com/lead.png', storagePath: 'generation_inputs/owner-1/gen-1/00.png', sourceGenerationId: 'gen-1' },
            { id: 'remix-2', displayName: 'Umbrella', handle: '@prop', url: 'https://signed.example.com/prop.png', storagePath: 'generation_inputs/owner-1/gen-1/01.png', sourceGenerationId: 'gen-1' },
          ],
        },
      },
      workflowSettings: { model: 'nano-banana-2' },
      restoreIssues: [],
    };
    installFetch({ starts: [startedReply()], remixBundle: bundle });
    render(<CreateImageClient prefill={{ remixId: 'gen-1' }} />);
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('@lead walks past @prop at dusk'));

    typePrompt('@lead runs past @prop at noon');
    fireEvent.click(screen.getByRole('button', { name: /View original/ }));
    const original = screen.getByRole('heading', { name: 'Original Creation' }).parentElement!;
    expect(original).toHaveTextContent('@lead walks past @prop at dusk');
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    pressGenerate();
    await findResult();
    typePrompt('@lead sleeps under @prop');
    fireEvent.click(screen.getByRole('button', { name: /Preview primary/ }));
    const preview = screen.getByRole('heading', { name: 'Generated Image Preview' }).parentElement!;
    expect(preview).toHaveTextContent('@lead runs past @prop at noon');
    expect(preview).not.toHaveTextContent('@lead sleeps under @prop');
  });

  it('sends a lost session to sign-in with this page’s params, keeping the draft', async () => {
    window.history.replaceState({}, '', '/create-image?model=nano-banana-2&prompt=hi');
    const fetchMock = installFetch();
    render(<CreateImageClient prefill={{}} />);
    await settleDraftRead();
    typePrompt('A draft worth keeping');

    getSessionMock.mockResolvedValue({ data: { session: null } });
    pressGenerate();

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fcreate-image%3Fmodel%3Dnano-banana-2%26prompt%3Dhi',
    ));
    expect(saveCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1', expect.objectContaining({ prompt: 'A draft worth keeping' }));
    expect(uploadMediaToTemporaryStorageMock).not.toHaveBeenCalled();
    expect(startCalls(fetchMock)).toHaveLength(0);
    window.history.replaceState({}, '', '/');
  });

  it('sends a session the start refuses to sign-in, keeping the draft', async () => {
    window.history.replaceState({}, '', '/create-image?remix=gen-9');
    installFetch({ starts: [{ status: 401, body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate media.' } }] });
    render(<CreateImageClient prefill={{}} />);
    await settleDraftRead();
    typePrompt('A draft worth keeping');
    pressGenerate();

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/login?returnUrl=%2Fcreate-image%3Fremix%3Dgen-9'));
    expect(saveCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1', expect.objectContaining({ prompt: 'A draft worth keeping' }));
    expect(screen.queryByText(/Unauthorized/)).not.toBeInTheDocument();
    window.history.replaceState({}, '', '/');
  });

  it('opens quick publish with the creation’s title and recipe prefill', async () => {
    const paywallPrefill = { resourceKinds: ['prompt'], promptText: 'A lighthouse at dawn', notesMarkdown: null, allowRemix: false };
    const fetchMock = installFetch({
      starts: [startedReply()],
      publishDetails: { generations: [{ id: 'gen-new', title: 'Lighthouse study', paywallPrefill }] },
    });
    render(<CreateImageClient prefill={{}} />);
    typePrompt('A lighthouse at dawn');
    pressGenerate();
    await findResult();

    fireEvent.click(screen.getByRole('button', { name: /Publish & share/ }));

    await waitFor(() => expect(publishModalProps.current).toMatchObject({
      isOpen: true,
      generationId: 'gen-new',
      defaultTitle: 'Lighthouse study',
      paywallPrefill,
    }));
    const creationRead = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/generations?'));
    expect(String(creationRead?.[0])).toContain('id=gen-new');
    expect((creationRead?.[1] as RequestInit).headers).toEqual({ Authorization: 'Bearer test-token' });
  });

  it('marks the Studio links with a gallery icon rather than a download one', () => {
    installFetch();
    render(<CreateImageClient prefill={{}} />);

    const studioLinks = screen.getAllByRole('link', { name: /Studio/ });
    expect(studioLinks).toHaveLength(2);
    for (const link of studioLinks) {
      expect(link.querySelector('svg.lucide-images')).not.toBeNull();
      expect(link.querySelector('svg.lucide-download')).toBeNull();
    }
  });
});

/**
 * Each model's own prompt limit (provider-prompt-limits): Z-Image takes 1,000 characters
 * where the route takes 10,000, and Seedream 5 Lite wants at least 4. The counter reads
 * against the selected model's limit, and a prompt past it waits with the start's own
 * words, kept whole, instead of meeting the refusal at Generate.
 */
describe('CreateImageClient prompt limits', () => {
  const limitSummaries = [
    ...imageModelSummaries,
    { id: 'z-image', kind: 'image', displayName: 'Z-Image', description: 'Test model with a 1,000-character prompt' },
  ];

  beforeEach(() => {
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([]);
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = limitSummaries;
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function counter() {
    return screen.getByTestId('prompt-length');
  }

  function generateButton() {
    return screen.getByRole('button', { name: /Generate Image/ });
  }

  function promptBox() {
    return screen.getByPlaceholderText(PROMPT_PLACEHOLDER);
  }

  it('counts the prompt against the model’s own limit: quiet with room, amber in its last tenth', async () => {
    render(<CreateImageClient prefill={{ model: 'z-image' }} />);
    expect(await screen.findByText('0 / 1,000 characters')).toBeInTheDocument();

    typePrompt('x'.repeat(899));
    expect(counter()).toHaveTextContent('899 / 1,000 characters');
    expect(counter()).toHaveAttribute('data-state', 'within');

    typePrompt('x'.repeat(1000));
    expect(counter()).toHaveTextContent('1,000 / 1,000 characters');
    expect(counter()).toHaveAttribute('data-state', 'near');
    expect(generateButton()).toBeEnabled();
    expect(screen.queryByText(/prompts support up to/)).not.toBeInTheDocument();
  });

  it('keeps a prompt past the limit whole, marks it over, and holds Generate with the model’s words', async () => {
    const fetchMock = installFetch({ starts: [startedReply()] });
    render(<CreateImageClient prefill={{ model: 'z-image' }} />);
    await screen.findByText('0 / 1,000 characters');

    // A paste past the limit: the box keeps the route's own 10,000, so nothing is cut.
    expect(promptBox()).toHaveAttribute('maxlength', '10000');
    typePrompt('x'.repeat(1001));
    expect(promptBox()).toHaveValue('x'.repeat(1001));
    expect(counter()).toHaveTextContent('1,001 / 1,000 characters');
    expect(counter()).toHaveAttribute('data-state', 'over');
    expect(promptBox()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Z-Image prompts support up to 1,000 characters.')).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();
    pressGenerate();
    expect(startCalls(fetchMock)).toHaveLength(0);

    // Back within it, the run goes as written.
    typePrompt('A lighthouse at dawn');
    expect(promptBox()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Z-Image prompts support up to 1,000 characters.')).not.toBeInTheDocument();
    pressGenerate();
    await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
    expect(startBody(startCalls(fetchMock)[0]).prompt).toBe('A lighthouse at dawn');
  });

  it('keeps the prompt when the creator switches to a model with a lower limit, and marks it over there', async () => {
    const view = render(<CreateImageClient prefill={{}} />);
    const prompt = `A harbour at dusk. ${'Lamps along the quay. '.repeat(70)}`.trim();
    expect(prompt.length).toBeGreaterThan(1000);
    typePrompt(prompt);
    expect(counter()).toHaveTextContent(`${prompt.length.toLocaleString('en-US')} / 10,000 characters`);
    expect(counter()).toHaveAttribute('data-state', 'within');

    chooseModel(view.container, 'Z-Image');

    await waitFor(() => expect(counter()).toHaveTextContent(`${prompt.length.toLocaleString('en-US')} / 1,000 characters`));
    expect(promptBox()).toHaveValue(prompt);
    expect(counter()).toHaveAttribute('data-state', 'over');
    expect(screen.getByText('Z-Image prompts support up to 1,000 characters.')).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    chooseModel(view.container, 'Nano Banana 2.0');

    await waitFor(() => expect(counter()).toHaveAttribute('data-state', 'within'));
    expect(promptBox()).toHaveValue(prompt);
    expect(screen.queryByText(/prompts support up to/)).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  it('holds a prompt shorter than the provider takes, where it asks for more than one character', async () => {
    render(<CreateImageClient prefill={{ model: 'seedream-5-lite' }} />);
    expect(await screen.findByText('0 / 2,995 characters')).toBeInTheDocument();

    typePrompt('cat');
    expect(screen.getByText('Seedream 5 Lite prompts need at least 4 characters.')).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    typePrompt('cats');
    expect(screen.queryByText(/prompts need at least/)).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  // Both hold Generate. The prompt is the creator's to fix on the page, so its limit is
  // said first; the prompt is no part of the run's price, so once it is fixed the run is
  // still the one the start refused at that price, and the page is still out of date.
  it('says a prompt past its limit before an out-of-date page, and the page again once the prompt is fixed', async () => {
    const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
    const fetchMock = installFetch({ starts: [costChanged] });
    render(<CreateImageClient prefill={{ model: 'seedream-5-lite' }} />);
    await screen.findByText('0 / 2,995 characters');
    typePrompt('A lighthouse at dawn');
    pressGenerate();
    expect(await screen.findByRole('alert')).toHaveTextContent('This page is out of date');

    typePrompt('cat');
    expect(screen.getByText('Seedream 5 Lite prompts need at least 4 characters.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    typePrompt('A lighthouse at dawn');
    expect(screen.queryByText(/prompts need at least/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date');
    expect(generateButton()).toBeDisabled();
    expect(startCalls(fetchMock)).toHaveLength(1);
  });
});
