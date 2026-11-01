import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImageClient from '@/app/create-image/CreateImageClient';
import type { CreatorOpening } from '@/lib/creator-opening';
import { clearGenerationsOnPage, GenerationStatusRequestError, subscribeToGenerationOnPage } from '@/lib/generation-status-client';
import type { PersistedImageElementRecord } from '@/lib/persisted-media';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { TemporaryMediaReadUrlError } from '@/lib/temporary-media-upload';
// What the server quotes when it starts a run: for "the price of the run the page sends".
import { buildUnifiedGenerationQuoteInput, parseUnifiedGenerationRequest } from '@/lib/unified-generation-start-service';
import { quoteStandIn } from './fixtures/web-quote-stand-in';
import { priceListStandIn, pricedBy } from './fixtures/quote-prices-stand-in';
import { chooseSetting as chooseAspectRatio, costShown, generateButton, openSettings } from './fixtures/creator-column-bar';
import { outsideAct } from './fixtures/outside-act';

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
  /** The network has not yet confirmed the revision: the catalog is the browser's stored copy. */
  checkingRevision: false,
}));
// Text drafts as the page saves and reads them, per tool and account.
const creatorDraftStore = vi.hoisted(() => new Map<string, unknown>());
const loadCreatorDraftMock = vi.hoisted(() => vi.fn(
  async (tool: string, userId: string): Promise<unknown> => creatorDraftStore.get(`${tool}:${userId}`) ?? null
));
const saveCreatorDraftMock = vi.hoisted(() => vi.fn(async (tool: string, userId: string, draft: unknown) => {
  creatorDraftStore.set(`${tool}:${userId}`, draft);
}));
// Whose draft the page keeps, where a test moves it as `useCreatorDraftOwner` would: a sign-up's
// hand-over finishing, a session from another tab, another account. Null leaves the hook's own answer.
const draftOwnerOverride = vi.hoisted(() => ({ current: null as { owner: string | null; carriedDraft: boolean; keepsVisitorForm: boolean } | null }));
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
  session: { access_token: 'test-token', user: { id: 'user-1' } } as { access_token: string; user: { id: string } } | null,
  // Whether a sign-out made in this browser ended the session (AuthProvider's `signedOut`).
  signedOut: false,
  updateCredits: vi.fn(),
}));
const getSessionMock = vi.hoisted(() => vi.fn());
const restoredFile = new File(['image-bytes'], 'restored-element.png', { type: 'image/png' });

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    credits: authState.credits,
    isLoading: false,
    session: authState.session,
    signedOut: authState.signedOut,
    updateCredits: authState.updateCredits,
  }),
}));

// What the Enhance button was last given, which a button answering through what it had when pressed
// calls, and the newest callbacks of the mounted button, which one keeping them in a ref calls.
type EnhanceAnswerProps = { onEnhanced: (text: string) => void; onCreditsUpdate: (credits: number) => void };
const enhanceButton = vi.hoisted(() => ({
  props: null as EnhanceAnswerProps | null,
  mounted: null as { current: EnhanceAnswerProps } | null,
}));

vi.mock('@/components/EnhancePromptButton', async () => {
  const { useLayoutEffect, useRef } = await import('react');
  return {
    default: function EnhanceButtonStandIn(props: EnhanceAnswerProps) {
      const newest = useRef(props);
      useLayoutEffect(() => {
        newest.current = props;
        enhanceButton.mounted = newest;
      });
      enhanceButton.props = props;
      return null;
    },
  };
});

vi.mock('@/components/PublicShareButton', () => ({
  default: () => null,
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

// The creators' price lists answer from the stand-in: nothing is priced unless a test says so.
// The module's pure helpers stay its own.
vi.mock('@/lib/use-quote-prices', async (importOriginal) => {
  const { quotePricesHookStandIn } = await import('./fixtures/quote-prices-stand-in');
  return { ...await importOriginal<typeof import('@/lib/use-quote-prices')>(), useQuotePrices: quotePricesHookStandIn };
});

vi.mock('@/lib/persisted-creator-draft', () => ({
  loadCreatorDraft: loadCreatorDraftMock,
  saveCreatorDraft: saveCreatorDraftMock,
}));

vi.mock('@/lib/use-creator-draft-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/use-creator-draft-owner')>();
  return {
    ...actual,
    useCreatorDraftOwner: (...args: Parameters<typeof actual.useCreatorDraftOwner>) => {
      const answer = actual.useCreatorDraftOwner(...args);
      return draftOwnerOverride.current ?? answer;
    },
  };
});

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

vi.mock('@/lib/use-deployment-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-deployment-refresh')>()),
  useDeploymentRefresh: useDeploymentRefreshMock,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
    // Production refuses the browser a run's prompt, cost and model (42501): the page asks the API.
    from: vi.fn((table: string) => {
      throw new Error(`The page read ${table} from the browser.`);
    }),
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
      isCheckingRevision: modelCatalogState.checkingRevision,
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
  draftOwnerOverride.current = null;
  quoteStandIn.reset(8);
  priceListStandIn.reset();
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
  authState.session = { access_token: 'test-token', user: { id: 'user-1' } };
  authState.signedOut = false;
  authState.updateCredits.mockClear();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(SIGNED_IN_SESSION);
  modelCatalogState.models = null;
  modelCatalogState.catalogReady = true;
  modelCatalogState.checkingRevision = false;
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

    await screen.findByAltText('Element 2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Element 2' }));

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

    await screen.findByAltText('Restored 11');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Restored 11' }));

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
      // The card is the name field's nearest ancestor that holds the handle's Insert button.
      let card = field.parentElement;
      while (card && !Array.from(card.querySelectorAll('button')).some((button) => /^Insert @/.test(button.getAttribute('aria-label') ?? ''))) {
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
/** The build an out-of-date page's last Reload page left (use-deployment-refresh). */
const RELOADED_FROM_KEY = 'magicbooklet:deployment-refresh:reloaded-from-build-id';
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

type StartReply = { status: number; body: unknown } | Error | 'hang' | Promise<Response>;

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

/**
 * Answers the start POSTs in order, the creation read the publish form makes, and the look
 * for a run already at work as the page opens (`activeRun`, none by default).
 */
function installFetch({ starts = [], publishDetails = null, remixBundle = null, activeRun = null, activeRunAnswer = null }: {
  starts?: StartReply[];
  publishDetails?: unknown;
  /** The remix source, or what it answers each reader by their Authorization header. */
  remixBundle?: RemixSourceBundle | ((authorization: string | undefined) => RemixSourceBundle) | null;
  activeRun?: Record<string, unknown> | null;
  /** Answers the look in place of `activeRun`, when the test resolves it. */
  activeRunAnswer?: Promise<Response> | null;
} = {}) {
  const replies = [...starts];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/generations' && init?.method === 'POST') {
      const reply = replies.shift();
      if (!reply) throw new Error('No start reply left');
      if (reply === 'hang') return new Promise<Response>(() => undefined);
      if (reply instanceof Promise) return reply;
      if (reply instanceof Error) throw reply;
      return jsonResponse(reply.status, reply.body);
    }
    if (url.startsWith('/api/generations?')) return jsonResponse(200, publishDetails ?? { generations: [] });
    if (url === '/api/generations/active?tool=image') return activeRunAnswer ?? jsonResponse(200, { run: activeRun });
    if (url.startsWith('/api/remix-source?') && remixBundle) {
      return jsonResponse(200, typeof remixBundle === 'function' ? remixBundle(authorizationOf(init)) : remixBundle);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function startCalls(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/generations' && init?.method === 'POST');
}

function activeRunReads(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/generations/active'));
}

/** An answer the test gives when it chooses. */
function heldAnswer() {
  let answer: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => { answer = resolve; });
  return { promise, answer: (response: Response) => answer(response) };
}

/** A run of this page's tool at work in another tab, as the API describes it. */
function runAtWork(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gen-old',
    predictionId: 'pred-old',
    status: 'processing',
    createdAt: new Date().toISOString(),
    prompt: 'An earlier run',
    cost: 8,
    model: 'nano-banana-2',
    duration: null,
    ...overrides,
  };
}

function startKey(call: unknown[]) {
  return ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];
}

/** The session a request went under, as its Authorization header names it. */
function authorizationOf(init: RequestInit | undefined) {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
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
  fireEvent.click(generateButton());
}

/** The aspect ratio the bar's settings chip reads back ("1K · AUTO · JPG"). */
function frameShown() {
  const parts = (screen.getByTestId('creator-settings-summary').textContent ?? '').split(' · ');
  return parts.find((part) => /^(?:\d+:\d+|AUTO)$/.test(part))?.toLowerCase();
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
      expect(activeRunReads(fetchMock)).toHaveLength(0);
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
      expect(generateButton()).toBeDisabled();
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
      expect(generateButton()).toBeDisabled();

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
      document.documentElement.dataset.buildId = 'build-7';
      try {
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
        expect(generateButton()).toBeDisabled();
        pressGenerate();
        await settleDraftRead();
        expect(startCalls(fetchMock)).toHaveLength(1);

        fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
        await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        // A remix keeps no draft, and this one is not saved over the creator's own.
        expect(saveCreatorDraftMock).not.toHaveBeenCalled();
        // The build it left, so the page that loads next can tell if the same one came back.
        expect(window.sessionStorage.getItem(RELOADED_FROM_KEY)).toBe('build-7');
      } finally {
        delete document.documentElement.dataset.buildId;
      }
    });

    // A reload can bring the same build back (a page served stale): offered again, it would
    // only bring it back again, and the creator would loop through reloads instead of presses.
    it('says a reload brought the same version back, instead of offering the same reload again', async () => {
      document.documentElement.dataset.buildId = 'build-7';
      window.sessionStorage.setItem(RELOADED_FROM_KEY, 'build-7');
      try {
        const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
        const fetchMock = installFetch({ starts: [costChanged], remixBundle: HARBOUR_REMIX });
        render(<CreateImageClient prefill={{ remixId: 'gen-1' }} />);
        await waitFor(() => expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('@lead walks past @prop at dusk'));

        pressGenerate();

        const notice = await screen.findByRole('alert');
        expect(notice).toHaveTextContent('This page is out of date, so it cannot show what this run costs, and reloading it brought back the same version. Wait a few minutes, then reload the page.');
        expect(notice).toHaveTextContent('The remix starts again from the original.');
        expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument();
        expect(generateButton()).toBeDisabled();
        expect(startCalls(fetchMock)).toHaveLength(1);
      } finally {
        delete document.documentElement.dataset.buildId;
      }
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

    // Only the first price in since a refusal is read against it, and a run that goes is
    // forgotten: a later quote back at the refused price (a rollback) held Generate and said
    // the page was out of date, though the start would take it.
    it('goes on at a price that moved after a refusal, and holds nothing when the old price comes back later', async () => {
      quoteStandIn.answers = [8, 10];
      const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
      installFetch({ starts: [costChanged, startedReply({ cost: 10 })] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      expect(await screen.findByText('The price of this run changed. Check the updated cost and generate again.')).toBeInTheDocument();
      expect(costShown()).toBe('10 credits');
      pressGenerate();
      await findResult();

      quoteStandIn.answers = [8, 8];
      typePrompt('A lighthouse at dawn, in fog');

      expect(costShown()).toBe('8 credits');
      expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
      expect(generateButton()).toBeEnabled();
    });

    it('forgets a refusal once that run goes, after the page was found out of date and the price then moved', async () => {
      const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
      installFetch({ starts: [costChanged, startedReply({ cost: 10 })] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      expect(await screen.findByRole('alert')).toHaveTextContent('This page is out of date');

      // The price moves (a deploy that fixed this run's quote, say), and the run goes at it.
      quoteStandIn.answers = [8, 10];
      typePrompt('A lighthouse at dawn, in fog');
      expect(costShown()).toBe('10 credits');
      expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
      pressGenerate();
      await findResult();

      // The old price back (a rollback): the run went, so the page holds nothing.
      quoteStandIn.answers = [8, 8];
      typePrompt('A lighthouse at dawn, in rain');
      expect(costShown()).toBe('8 credits');
      expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
      expect(generateButton()).toBeEnabled();
    });

    it('lets the creator go on with another run, which the refusal does not hold', async () => {
      const costChanged = { status: 409, body: { code: 'cost_changed', error: 'The price of this run changed. Check the updated cost and generate again.' } };
      const fetchMock = installFetch({ starts: [costChanged, startedReply()] });
      const view = render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      expect(await screen.findByRole('alert')).toHaveTextContent('This page is out of date');

      // Another run is priced on its own: nothing has refused it.
      chooseAspectRatio('1:1');
      expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
      expect(generateButton()).toBeEnabled();
      pressGenerate();
      await findResult();
      expect(startCalls(fetchMock)).toHaveLength(2);
      expect(startBody(startCalls(fetchMock)[1]).settings).toMatchObject({ aspectRatio: '1:1' });
      view.unmount();
    });
  });

  // Under 1120px the result is drawn under the column, below the bar the creator presses.
  // The canvas comes into view once a run the creator started is under way, and only then:
  // a refusal is said in the bar, and a run resumed on load leaves the page at its top.
  describe('the result canvas', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    let scrollIntoView: ReturnType<typeof vi.fn>;

    /** Draws the canvas `top` pixels down the window: 1500 under the column, 88 beside it. */
    function placeCanvas(top: number) {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
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
    });

    it('is brought into view under the column once the run it started is under way', async () => {
      placeCanvas(1500);
      installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');

      pressGenerate();

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toHaveAttribute('aria-label', 'Result');
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    it('stays put when the start is refused, so the reason in the bar stays in view', async () => {
      placeCanvas(1500);
      installFetch({ starts: [{ status: 402, body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 8 credits.' } }] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');

      pressGenerate();

      expect(await screen.findByText('Insufficient credits. This action costs 8 credits.')).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('stays put when a run is picked up on load, so the page opens at its top', async () => {
      placeCanvas(1500);
      installFetch({ activeRun: runAtWork({ model: null }) });
      render(<CreateImageClient prefill={{}} />);

      // The earlier run was picked up and followed to its end.
      await findResult();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('stays put beside the column, where it is in view already', async () => {
      placeCanvas(88);
      installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');

      pressGenerate();

      await findResult();
      expect(scrollIntoView).not.toHaveBeenCalled();
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
      chooseAspectRatio('1:1');

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

    // The prompt box's rule when a draft is read back after the page opened (owner, 2026-11-01).
    describe('read back after the page opened', () => {
      const CARRIED = 'A corgi astronaut on the moon, cinematic';
      const page = () => <CreateImageClient prefill={{}} handoverNonce="nonce-1" />;
      const box = () => screen.getByPlaceholderText(PROMPT_PLACEHOLDER);
      // keepsVisitorForm: the sign-up sheet's hand-over led here and its move gave up or failed.
      function ownDraftAs(owner: string | null, carriedDraft = false, keepsVisitorForm = false) {
        draftOwnerOverride.current = { owner, carriedDraft, keepsVisitorForm };
      }
      const promptsSavedFor = (owner: string) => saveCreatorDraftMock.mock.calls
        .filter(([, savedFor]) => savedFor === owner)
        .map(([, , draft]) => (draft as { prompt: string }).prompt);

      it('brings the prompt carried from sign-up back over words typed while it was on its way, once', async () => {
        installFetch();
        // The visitor's draft, moved to the account by the hand-over.
        creatorDraftStore.set('image:user-1', { prompt: CARRIED, modelId: 'nano-banana-2' });
        ownDraftAs(null);
        const view = render(page());
        // Typed on the way back, before the move was done: as the visitor retypes into an empty box.
        typePrompt('A corgi astr');
        await settleDraftRead();
        expect(loadCreatorDraftMock).not.toHaveBeenCalled();

        ownDraftAs('user-1', true);
        view.rerender(page());
        await waitFor(() => expect(box()).toHaveValue(CARRIED));

        // A session that lapses and comes back reads the account's draft again: that is the
        // creator's own save now, and the newer words stay.
        typePrompt('A corgi astronaut on Mars');
        ownDraftAs(null);
        view.rerender(page());
        ownDraftAs('user-1', true);
        view.rerender(page());
        await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledTimes(2));
        await settleDraftRead();
        expect(box()).toHaveValue('A corgi astronaut on Mars');
      });

      it('keeps words typed on the way back when the move carried no draft', async () => {
        installFetch();
        creatorDraftStore.set('image:user-1', { prompt: 'An older prompt of the account', modelId: 'nano-banana-2' });
        ownDraftAs(null);
        const view = render(page());
        typePrompt('A corgi astronaut');

        ownDraftAs('user-1', false);
        view.rerender(page());
        await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1'));
        await settleDraftRead();
        expect(box()).toHaveValue('A corgi astronaut');
      });

      it('never keeps one account’s words for another, nor saves them under it', async () => {
        installFetch();
        ownDraftAs('user-1');
        const view = render(page());
        await settleDraftRead();
        typePrompt('Asha’s harbour at dusk');
        await waitFor(() => expect(promptsSavedFor('user-1')).toContain('Asha’s harbour at dusk'), { timeout: 2_000 });

        // Asha signs out in another tab and Ben, who has no draft, signs in.
        ownDraftAs(null);
        view.rerender(page());
        ownDraftAs('user-2');
        view.rerender(page());
        expect(box()).toHaveValue('');
        await waitFor(() => expect(promptsSavedFor('user-2')).toContain(''), { timeout: 2_000 });

        // Straight to Cleo, who has one, and back to Asha: each sees their own.
        creatorDraftStore.set('image:user-3', { prompt: 'Cleo’s lighthouse', modelId: 'nano-banana-2' });
        ownDraftAs('user-3');
        view.rerender(page());
        await waitFor(() => expect(box()).toHaveValue('Cleo’s lighthouse'));
        ownDraftAs('user-1');
        view.rerender(page());
        await waitFor(() => expect(box()).toHaveValue('Asha’s harbour at dusk'));
        expect(promptsSavedFor('user-2').every((prompt) => prompt === '')).toBe(true);
        expect(promptsSavedFor('user-3')).not.toContain('Asha’s harbour at dusk');
      });

      it('leaves a visitor’s words behind when an account signs in without the sign-up sheet', async () => {
        installFetch();
        ownDraftAs('visitor');
        const view = render(page());
        await settleDraftRead();
        typePrompt('Neon koi pond, top-down');
        await waitFor(() => expect(promptsSavedFor('visitor')).toContain('Neon koi pond, top-down'), { timeout: 2_000 });

        // Signed in from another tab: the account, which has no draft, opens on nothing.
        ownDraftAs('user-1');
        view.rerender(page());
        expect(box()).toHaveValue('');
        await waitFor(() => expect(promptsSavedFor('user-1')).toContain(''), { timeout: 2_000 });
        expect(promptsSavedFor('user-1')).not.toContain('Neon koi pond, top-down');
      });

      it('fills a box emptied before the saved draft came back', async () => {
        installFetch();
        let answer: (draft: unknown) => void = () => undefined;
        loadCreatorDraftMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        render(page());
        await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1'));
        typePrompt('A first thought');
        typePrompt('');

        await act(async () => answer({ prompt: 'The saved prompt', modelId: 'nano-banana-2' }));
        expect(box()).toHaveValue('The saved prompt');
      });

      it('goes back to the link’s prompt, not to nothing, when another account signs in', async () => {
        installFetch();
        const link = { prompt: 'A lighthouse in a storm' };
        ownDraftAs('user-1');
        const view = render(<CreateImageClient prefill={link} />);
        await settleDraftRead();
        typePrompt('A lighthouse in a storm, seen from the deck');

        ownDraftAs('user-2');
        view.rerender(<CreateImageClient prefill={link} />);
        await settleDraftRead();
        expect(box()).toHaveValue('A lighthouse in a storm');
      });

      it('takes the next account’s saved prompt though its read answers before the reset is drawn', async () => {
        installFetch();
        creatorDraftStore.set('image:user-2', { prompt: 'Ben’s glasshouse at dawn', modelId: 'nano-banana-2' });
        ownDraftAs('user-1');
        await outsideAct(async (draw) => {
          draw(page());
          await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1'));
          typePrompt('Asha’s harbour at dusk');

          ownDraftAs('user-2');
          draw(page());
          await waitFor(() => expect(box()).toHaveValue('Ben’s glasshouse at dawn'));
        });
      });

      it('drops an Enhance answer that comes back after another account signed in', async () => {
        installFetch();
        ownDraftAs('user-1');
        const view = render(page());
        await settleDraftRead();
        typePrompt('Asha’s harbour at dusk');
        const pressedForAsha = enhanceButton.props!;
        const buttonAshaPressed = enhanceButton.mounted!;

        ownDraftAs('user-2');
        view.rerender(page());
        await settleDraftRead();
        act(() => {
          pressedForAsha.onEnhanced('Asha’s harbour at dusk, golden hour, 35mm');
          pressedForAsha.onCreditsUpdate(41);
          // A button answering through its newest callbacks is drawn anew for Ben: the one Asha pressed has only hers.
          buttonAshaPressed.current.onEnhanced('Asha’s harbour at dusk, golden hour, 35mm');
          buttonAshaPressed.current.onCreditsUpdate(43);
        });
        expect(box()).toHaveValue('');
        expect(authState.updateCredits).not.toHaveBeenCalledWith(41);
        expect(authState.updateCredits).not.toHaveBeenCalledWith(43);
        await waitFor(() => expect(promptsSavedFor('user-2')).toContain(''), { timeout: 2_000 });
        expect(promptsSavedFor('user-2')).not.toContain('Asha’s harbour at dusk, golden hour, 35mm');

        // One pressed for the account on the page lands.
        act(() => {
          enhanceButton.props!.onEnhanced('Ben’s glasshouse at dawn');
          enhanceButton.props!.onCreditsUpdate(12);
        });
        expect(box()).toHaveValue('Ben’s glasshouse at dawn');
        expect(authState.updateCredits).toHaveBeenCalledWith(12);
      });

      // The pictures follow the same rule: one owner's are never shown to another, nor sent or
      // saved under them. Only the sheet's hand-over moves a visitor's into an account.
      const picture = (displayName: string, name: string): PersistedImageElementRecord => ({
        id: `saved-${name}`,
        displayName,
        file: new File([name], `${name}.png`, { type: 'image/png' }),
      });
      /** What the browser keeps for each owner. */
      function keepPictures(byOwner: Record<string, PersistedImageElementRecord[]>) {
        getPersistedImageElementRecordsMock.mockImplementation(async (key: string) => (
          byOwner[key.slice('create-image:elements:'.length)] ?? []
        ));
      }
      async function readPicturesOf(owner: string) {
        await waitFor(() => expect(getPersistedImageElementRecordsMock).toHaveBeenCalledWith(`create-image:elements:${owner}`));
        await settleDraftRead();
      }
      const picturesSavedFor = (owner: string) => setPersistedImageElementRecordsMock.mock.calls
        .filter(([key]) => key === `create-image:elements:${owner}`)
        .flatMap(([, records]) => records.map((record) => record.file.name));

      it('never keeps one account’s pictures for another, nor sends or saves them under it', async () => {
        const fetchMock = installFetch({ starts: [startedReply()] });
        keepPictures({ 'user-1': [picture('Asha’s harbour', 'harbour')] });
        ownDraftAs('user-1');
        const view = render(page());
        const pickPictures = (file: File) => fireEvent.change(
          view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!,
          { target: { files: [file] } },
        );
        expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
        // A file of hers the page refused, by its name.
        pickPictures(new File(['notes'], 'asha-notes.txt', { type: 'text/plain' }));
        expect(await screen.findByText(/asha-notes\.txt/)).toBeInTheDocument();

        // Asha signs out in another tab and Ben, who has no pictures saved, signs in.
        ownDraftAs(null);
        view.rerender(page());
        ownDraftAs('user-2');
        view.rerender(page());
        await readPicturesOf('user-2');
        expect(screen.queryByAltText('Asha’s harbour')).not.toBeInTheDocument();
        expect(screen.queryByText(/asha-notes\.txt/)).not.toBeInTheDocument();

        // What Ben adds is saved alone under him, and his run, under his session, sends only that.
        pickPictures(new File(['ben'], 'lighthouse.png', { type: 'image/png' }));
        await waitFor(() => expect(picturesSavedFor('user-2')).toContain('lighthouse.png'));
        getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-user-2', user: { id: 'user-2' } } } });
        typePrompt('A lighthouse at dawn');
        pressGenerate();
        await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
        expect(startBody(startCalls(fetchMock)[0]).inputs.map((sent) => String(sent.storagePath).split('/').at(-1)))
          .toEqual(['lighthouse.png']);

        // Back to Asha: her picture, and none of Ben's.
        ownDraftAs('user-1');
        view.rerender(page());
        expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
        expect(screen.queryByAltText('Element 1')).not.toBeInTheDocument();
        view.unmount();
        expect(picturesSavedFor('user-2')).not.toContain('harbour.png');
        expect(picturesSavedFor('user-1')).not.toContain('lighthouse.png');
      });

      it('drops the earlier owner’s pictures when their read answers after the owner changed', async () => {
        installFetch();
        let answerAsha: (records: PersistedImageElementRecord[]) => void = () => undefined;
        getPersistedImageElementRecordsMock.mockImplementation((key: string) => (
          key === 'create-image:elements:user-1'
            ? new Promise((resolve) => { answerAsha = resolve; })
            : Promise.resolve([])
        ));
        ownDraftAs('user-1');
        const view = render(page());
        await waitFor(() => expect(getPersistedImageElementRecordsMock).toHaveBeenCalledWith('create-image:elements:user-1'));

        // Ben signs in from another tab while Asha's pictures are still being read.
        ownDraftAs('user-2');
        view.rerender(page());
        await readPicturesOf('user-2');
        await act(async () => answerAsha([picture('Asha’s harbour', 'harbour')]));
        await settleDraftRead();
        expect(screen.queryByAltText('Asha’s harbour')).not.toBeInTheDocument();
      });

      it('leaves a visitor’s pictures behind when an account signs in without the sign-up sheet', async () => {
        installFetch();
        keepPictures({ visitor: [picture('Neon koi', 'koi')] });
        ownDraftAs('visitor');
        const view = render(page());
        expect(await screen.findByAltText('Neon koi')).toBeInTheDocument();

        // Signed in from another tab: the account, which has no pictures saved, opens on none.
        ownDraftAs('user-1');
        view.rerender(page());
        await readPicturesOf('user-1');
        expect(screen.queryByAltText('Neon koi')).not.toBeInTheDocument();
        view.unmount();
        expect(picturesSavedFor('user-1')).not.toContain('koi.png');
      });

      it('keeps the pictures the sign-up sheet’s hand-over carried', async () => {
        installFetch();
        // The page opened before its session came, on the visitor's pictures.
        keepPictures({ visitor: [picture('Corgi astronaut', 'corgi')] });
        ownDraftAs('visitor');
        const view = render(page());
        expect(await screen.findByAltText('Corgi astronaut')).toBeInTheDocument();

        // The hand-over moves them to the account the visitor signed up with.
        ownDraftAs(null);
        view.rerender(page());
        keepPictures({ 'user-1': [picture('Corgi astronaut', 'corgi')] });
        ownDraftAs('user-1', true);
        view.rerender(page());
        await readPicturesOf('user-1');
        expect(screen.getByAltText('Corgi astronaut')).toBeInTheDocument();
      });

      it('keeps the visitor’s pictures and words when the sign-up sheet’s hand-over gives up', async () => {
        installFetch();
        // The page opened before its session came, on the visitor's pictures and words. The account
        // the visitor signs up with has older pictures of its own saved.
        keepPictures({ visitor: [picture('Corgi astronaut', 'corgi')], 'user-1': [picture('Old mountain', 'mountain')] });
        ownDraftAs('visitor');
        const view = render(page());
        expect(await screen.findByAltText('Corgi astronaut')).toBeInTheDocument();
        typePrompt('A corgi astronaut on the moon, cinematic');

        // The move to that account does not answer in time, so the page goes on with the account.
        ownDraftAs(null);
        view.rerender(page());
        ownDraftAs('user-1', false, true);
        view.rerender(page());
        await waitFor(() => expect(loadCreatorDraftMock).toHaveBeenCalledWith('image', 'user-1'));
        await settleDraftRead();
        // The form stays as the visitor left it, with no older picture of the account's over it.
        expect(screen.getByAltText('Corgi astronaut')).toBeInTheDocument();
        expect(screen.queryByAltText('Old mountain')).not.toBeInTheDocument();
        expect(box()).toHaveValue('A corgi astronaut on the moon, cinematic');
      });

      it('writes nothing under the earlier owner when their run’s upload ends after the owner changed', async () => {
        installFetch({ starts: [startedReply()] });
        keepPictures({ 'user-1': [picture('Asha’s harbour', 'harbour')] });
        ownDraftAs('user-1');
        const view = render(page());
        expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
        // Asha's run uploads her picture.
        let finishUpload: () => void = () => undefined;
        uploadMediaToTemporaryStorageMock.mockImplementationOnce((file: File) => new Promise((resolve) => {
          finishUpload = () => resolve({
            signedUrl: `https://signed.example.com/uploads/${file.name}`,
            storagePath: `uploads/user-1/${file.name}`,
          });
        }));
        typePrompt('A harbour at dusk');
        pressGenerate();
        await waitFor(() => expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalled());

        // Ben, who has no pictures saved, signs in from another tab meanwhile.
        ownDraftAs('user-2');
        view.rerender(page());
        await readPicturesOf('user-2');
        const pictureWrites = setPersistedImageElementRecordsMock.mock.calls.length;
        await act(async () => finishUpload());
        await settleDraftRead();

        // An empty list written under Asha would have removed her saved pictures.
        expect(setPersistedImageElementRecordsMock.mock.calls.slice(pictureWrites).map(([key]) => key)).toEqual([]);
      });
    });
  });

  // The run follows the form: when another account takes the page (from another tab, or after a
  // sign-out), the earlier account's unanswered start, a press of theirs still under way, their
  // result and their remix's pictures go with their form, and nothing is sent under the next.
  describe('when another account takes the page', () => {
    const page = () => <CreateImageClient prefill={{}} />;
    const START_UNCONFIRMED = 'We couldn’t confirm your generation started. Check again — that can’t start a second run.';
    const sessionOf = (userId: string) => ({ access_token: `token-${userId}`, user: { id: userId } });
    /** Another account signs in from another tab: the browser's auth client has its session, then the page. */
    function signInAs(userId: string, redraw?: () => void) {
      authClientSignsInAs(userId);
      authState.session = sessionOf(userId);
      draftOwnerOverride.current = { owner: userId, carriedDraft: false, keepsVisitorForm: false };
      redraw?.();
    }
    /** The browser's auth client holds another account's session while the page still checks it. */
    function authClientSignsInAs(userId: string) {
      getSessionMock.mockResolvedValue({ data: { session: sessionOf(userId) } });
    }
    /** The account signs out in another tab: a page that opened signed in keeps its form, owned by no one. */
    function signOutHere(redraw: () => void) {
      getSessionMock.mockResolvedValue({ data: { session: null } });
      authState.session = null;
      draftOwnerOverride.current = { owner: null, carriedDraft: false, keepsVisitorForm: false };
      redraw();
    }
    function keepAshasPicture() {
      getPersistedImageElementRecordsMock.mockImplementation(async (key: string) => (key === 'create-image:elements:user-1'
        ? [{ id: 'asha-1', displayName: 'Asha’s harbour', file: new File(['harbour'], 'harbour.png', { type: 'image/png' }) }]
        : []));
    }
    /** Asha's press, held in its upload until the test lets it finish. */
    function holdUpload() {
      let finish: () => void = () => undefined;
      uploadMediaToTemporaryStorageMock.mockImplementationOnce((file: File) => new Promise((resolve) => {
        finish = () => resolve({ signedUrl: `https://signed.example.com/uploads/${file.name}`, storagePath: `uploads/user-1/${file.name}` });
      }));
      return async () => {
        await act(async () => finish());
        await settleDraftRead();
      };
    }

    // Each creator is drawn for one owner and stops what it started as it goes: development's
    // Strict Mode mounts it twice, and the second mount's presses go on.
    it('still sends a press on a page that development’s Strict Mode mounts twice', async () => {
      const fetchMock = installFetch({ starts: [startedReply()] });
      render(<StrictMode><CreateImageClient prefill={{}} /></StrictMode>);
      await settleDraftRead();
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      expect(await findResult()).toBeInTheDocument();
      expect(startCalls(fetchMock)).toHaveLength(1);
      expect(authState.updateCredits).toHaveBeenCalledWith(9_992);
    });

    it('reads the balance again for whoever holds the session when a start answers after the page was left', async () => {
      const answer = heldAnswer();
      const fetchMock = installFetch({ starts: [answer.promise] });
      const view = render(page());
      await settleDraftRead();
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
      const balanceEvents: Event[] = [];
      const listen = (event: Event) => balanceEvents.push(event);
      window.addEventListener('credits_updated', listen);

      view.unmount();
      const started = startedReply() as { status: number; body: unknown };
      await act(async () => answer.answer(jsonResponse(started.status, started.body)));
      window.removeEventListener('credits_updated', listen);

      // Not set to the balance this start answered with, which may not be the session's any more.
      expect(authState.updateCredits).not.toHaveBeenCalled();
      expect(balanceEvents.some((event) => !(event instanceof CustomEvent))).toBe(true);
      // Nothing on the page follows the run, and the next visit does not send its start again.
      expect(fetchGenerationStatusWithRetryMock).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
    });

    it('drops the earlier account’s unanswered start, and the next account’s press sends its own run', async () => {
      const fetchMock = installFetch({ starts: [new TypeError('Failed to fetch'), startedReply()] });
      signInAs('user-1');
      const view = render(page());
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      expect(await screen.findByText(START_UNCONFIRMED)).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(page()));
      await settleDraftRead();
      expect(screen.queryByText(START_UNCONFIRMED)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();

      typePrompt('Ben’s glasshouse at dawn');
      pressGenerate();
      expect(await findResult()).toBeInTheDocument();
      const [ashas, bens] = startCalls(fetchMock);
      expect(startBody(bens).prompt).toBe('Ben’s glasshouse at dawn');
      expect(startKey(bens)).not.toBe(startKey(ashas));
      expect(authorizationOf(bens[1] as RequestInit)).toBe('Bearer token-user-2');
    });

    it('checks no start again under a session another account has taken, while the page still checks it', async () => {
      const fetchMock = installFetch({ starts: [new TypeError('Failed to fetch')] });
      signInAs('user-1');
      render(page());
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      expect(await screen.findByText(START_UNCONFIRMED)).toBeInTheDocument();

      authClientSignsInAs('user-2');
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await settleDraftRead();

      expect(startCalls(fetchMock)).toHaveLength(1);
      // Still Asha's, to check under her session.
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    });

    it.each([
      ['once the page knows', true],
      ['while the page still checks the session', false],
    ])('sends nothing for a press still uploading when another account signs in, %s', async (_when, pageKnows) => {
      const fetchMock = installFetch({ starts: [startedReply()] });
      keepAshasPicture();
      signInAs('user-1');
      const view = render(page());
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      const finishUpload = holdUpload();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      await waitFor(() => expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalled());

      if (pageKnows) signInAs('user-2', () => view.rerender(page()));
      else authClientSignsInAs('user-2');
      await settleDraftRead();
      await finishUpload();

      expect(startCalls(fetchMock)).toEqual([]);
      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
      expect(authState.updateCredits).not.toHaveBeenCalled();
      // Uploaded for Asha alone: under another account's session the upload refuses to go.
      expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'harbour.png' }),
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('uploads and sends nothing for a press made after another account took the session, before the page heard', async () => {
      const fetchMock = installFetch({ starts: [startedReply()] });
      keepAshasPicture();
      signInAs('user-1');
      render(page());
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      typePrompt('Asha’s harbour at dusk');

      authClientSignsInAs('user-2');
      pressGenerate();
      await settleDraftRead();

      expect(uploadMediaToTemporaryStorageMock).not.toHaveBeenCalled();
      expect(startCalls(fetchMock)).toEqual([]);
    });

    it('takes the earlier account’s result, its caption and its Post form off the canvas', async () => {
      installFetch({
        starts: [startedReply()],
        publishDetails: { generations: [{ id: 'gen-new', title: 'Harbour study', paywallPrefill: null }] },
      });
      signInAs('user-1');
      const view = render(page());
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      expect(await findResult()).toBeInTheDocument();
      expect(screen.getByText('Asha’s harbour at dusk', { selector: 'p' })).toBeInTheDocument();
      expect(await screen.findByRole('form', { name: 'Post it to the feed' })).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(page()));
      await settleDraftRead();

      expect(screen.queryByRole('button', { name: 'Preview generated image 1' })).not.toBeInTheDocument();
      expect(screen.queryByText('Asha’s harbour at dusk')).not.toBeInTheDocument();
      expect(screen.queryByRole('form', { name: 'Post it to the feed' })).not.toBeInTheDocument();
    });

    it('takes the earlier account’s failed run off the canvas', async () => {
      fetchGenerationStatusWithRetryMock.mockResolvedValue({ status: 'failed', error: 'The provider could not render Asha’s harbour' });
      installFetch({ starts: [startedReply()] });
      signInAs('user-1');
      const view = render(page());
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      expect(await screen.findByRole('alert')).toHaveTextContent('The provider could not render Asha’s harbour');

      signInAs('user-2', () => view.rerender(page()));
      await settleDraftRead();

      expect(screen.queryByText(/could not render Asha’s harbour/)).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'It didn’t finish' })).not.toBeInTheDocument();
    });

    it('takes the server’s refusal of the earlier account’s start off the page', async () => {
      installFetch({ starts: [{ status: 402, body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 8 credits.' } }] });
      signInAs('user-1');
      const view = render(page());
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      expect(await screen.findByText('Insufficient credits. This action costs 8 credits.')).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(page()));
      await settleDraftRead();

      expect(screen.queryByText('Insufficient credits. This action costs 8 credits.')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Top Up Credits/ })).not.toBeInTheDocument();
    });

    it('uploads and sends nothing for a press on a page signed out in another tab, once another account took the session', async () => {
      const fetchMock = installFetch({ starts: [startedReply()] });
      keepAshasPicture();
      signInAs('user-1');
      const view = render(page());
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      typePrompt('Asha’s harbour at dusk');

      // Asha signs out in another tab: the page keeps her form, owned by no one. Ben then signs in
      // there, and the browser has his session before the page does.
      signOutHere(() => view.rerender(page()));
      authClientSignsInAs('user-2');
      pressGenerate();
      await settleDraftRead();

      expect(uploadMediaToTemporaryStorageMock).not.toHaveBeenCalled();
      expect(startCalls(fetchMock)).toEqual([]);
    });

    it('forgets a start refused after the page was left, so the next visit does not send it again', async () => {
      const answer = heldAnswer();
      const fetchMock = installFetch({ starts: [answer.promise] });
      const view = render(page());
      await settleDraftRead();
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));

      view.unmount();
      await act(async () => answer.answer(jsonResponse(402, { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 8 credits.' })));

      expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
    });

    it('still sends a press whose page was left while its pictures went up, under its own account', async () => {
      const fetchMock = installFetch({ starts: [startedReply()] });
      keepAshasPicture();
      signInAs('user-1');
      const view = render(page());
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      const finishUpload = holdUpload();
      typePrompt('Asha’s harbour at dusk');
      pressGenerate();
      await waitFor(() => expect(uploadMediaToTemporaryStorageMock).toHaveBeenCalled());

      view.unmount();
      await finishUpload();

      await waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
      expect(authorizationOf(startCalls(fetchMock)[0][1] as RequestInit)).toBe('Bearer token-user-1');
    });

    it('writes nothing back for the earlier account when its sign-out gives the page back to the visitor', async () => {
      installFetch();
      keepAshasPicture();
      // A visitor's page that Asha's session reaches in place.
      authState.session = null;
      getSessionMock.mockResolvedValue({ data: { session: null } });
      draftOwnerOverride.current = { owner: 'visitor', carriedDraft: false, keepsVisitorForm: false };
      const view = render(page());
      await settleDraftRead();
      signInAs('user-1', () => view.rerender(page()));
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');

      // She signs out from the shell, which clears what this browser keeps for her first.
      const picturesWritten = setPersistedImageElementRecordsMock.mock.calls.length;
      const draftsSaved = saveCreatorDraftMock.mock.calls.length;
      authState.session = null;
      getSessionMock.mockResolvedValue({ data: { session: null } });
      draftOwnerOverride.current = { owner: 'visitor', carriedDraft: false, keepsVisitorForm: false };
      view.rerender(page());
      await settleDraftRead();

      expect(setPersistedImageElementRecordsMock.mock.calls.slice(picturesWritten).map(([key]) => key)).not.toContain('create-image:elements:user-1');
      expect(saveCreatorDraftMock.mock.calls.slice(draftsSaved).map(([, owner]) => owner)).not.toContain('user-1');
    });

    // Owner, 2026-11-01, "Yes, clear it": a sign-out made in another tab clears an open creator page
    // that opened signed in, and the page is the visitor's after it; a session that lapses keeps it.
    it('clears the page when its account signs out in another tab, and leaves it the visitor’s', async () => {
      installFetch();
      keepAshasPicture();
      const view = render(page());
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');

      // Asha signs out in another tab of this browser, which marked it so.
      getSessionMock.mockResolvedValue({ data: { session: null } });
      authState.session = null;
      authState.signedOut = true;
      view.rerender(page());
      await settleDraftRead();

      expect(screen.queryByAltText('Asha’s harbour')).toBeNull();
      expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('');
      typePrompt('A lighthouse in fog');
      fireEvent.click(screen.getByRole('button', { name: 'Sign up to generate' }));
      expect(await screen.findByRole('dialog', { name: 'Continue to generate' })).toBeInTheDocument();
    });

    it('keeps the page through a session that lapses', async () => {
      installFetch();
      keepAshasPicture();
      const view = render(page());
      expect(await screen.findByAltText('Asha’s harbour')).toBeInTheDocument();
      await settleDraftRead();
      typePrompt('Asha’s harbour at dusk');

      getSessionMock.mockResolvedValue({ data: { session: null } });
      authState.session = null;
      view.rerender(page());
      await settleDraftRead();

      expect(screen.getByAltText('Asha’s harbour')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('Asha’s harbour at dusk');
      expect(screen.queryByRole('dialog', { name: 'Continue to generate' })).toBeNull();
    });

    it('reads the balance again when a paid Enhance answers after the page was left', async () => {
      installFetch();
      const view = render(page());
      await settleDraftRead();
      const pressed = enhanceButton.props!;
      const balanceEvents: Event[] = [];
      const listen = (event: Event) => balanceEvents.push(event);
      window.addEventListener('credits_updated', listen);

      view.unmount();
      act(() => pressed.onCreditsUpdate(41));
      window.removeEventListener('credits_updated', listen);

      // Not set to the balance the answer brings, which need not be the session's any more.
      expect(authState.updateCredits).not.toHaveBeenCalledWith(41);
      expect(balanceEvents.some((event) => !(event instanceof CustomEvent))).toBe(true);
    });

    it('drops the earlier account’s remix pictures and its own, and reads the remix again for the next', async () => {
      const remixPage = () => <CreateImageClient prefill={{ remixId: 'gen-1' }} />;
      // A remix gives a run's own pictures to the account that made it; another reads the post alone.
      const fetchMock = installFetch({
        remixBundle: (authorization) => (authorization === 'Bearer token-user-1' ? HARBOUR_REMIX : { ...HARBOUR_REMIX, inputs: {} }),
      });
      signInAs('user-1');
      const view = render(remixPage());
      expect(await screen.findByAltText('Hero shot')).toBeInTheDocument();
      fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!, {
        target: { files: [new File(['selfie'], 'selfie.png', { type: 'image/png' })] },
      });
      expect(await screen.findByAltText('Element 3')).toBeInTheDocument();

      signInAs('user-2', () => view.rerender(remixPage()));
      await waitFor(() => expect(fetchMock.mock.calls
        .filter(([url]) => String(url).startsWith('/api/remix-source?'))
        .map(([, init]) => authorizationOf(init as RequestInit))).toEqual(['Bearer token-user-1', 'Bearer token-user-2']));
      await settleDraftRead();

      expect(screen.queryByAltText('Hero shot')).not.toBeInTheDocument();
      expect(screen.queryByAltText('Umbrella')).not.toBeInTheDocument();
      expect(screen.queryByAltText('Element 3')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveValue('@lead walks past @prop at dusk');
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
      // Signed again for the account that pressed, as its upload would have gone up.
      expect(refreshTemporaryMediaUrlMock).toHaveBeenCalledWith('uploads/user-1/restored-element.png', expect.objectContaining({ userId: 'user-1' }));
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
    expect(generateButton()).toBeDisabled();
    // Nothing is sent to a prompt-only model, so the server would not know the mention either.
    expect(screen.getByText(/^Unknown element mention/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Restored product' }));

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

    openSettings();
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
      expect(screen.queryByRole('button', { name: /^Generate · / })).not.toBeInTheDocument();
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

    // The artboard Failed (owner, 2026-10-28): the canvas names the cause, says the
    // credits are back, and offers the run again or the prompt to change.
    it('says on the canvas why the run failed and that its credits came back, and re-reads the balance', async () => {
      const creditsUpdated = vi.fn();
      window.addEventListener('credits_updated', creditsUpdated);
      fetchGenerationStatusWithRetryMock.mockResolvedValue({ status: 'failed', error: 'The provider could not render this' });
      installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The provider could not render this');
      expect(alert).toHaveTextContent('Your 8 credits are back.');
      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(within(canvas).getByRole('heading', { name: 'It didn’t finish' })).toBeInTheDocument();
      expect(within(canvas).getByRole('button', { name: /^Try again/ })).toBeInTheDocument();
      expect(creditsUpdated).toHaveBeenCalled();
      window.removeEventListener('credits_updated', creditsUpdated);

      fireEvent.click(within(canvas).getByRole('button', { name: 'Change the prompt' }));
      expect(within(canvas).queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(PROMPT_PLACEHOLDER)).toHaveFocus();
    });

    it('says the model’s service stopped when a failed run gives no reason', async () => {
      fetchGenerationStatusWithRetryMock.mockResolvedValue({ status: 'failed', error: 'Unknown error' });
      installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      expect(await screen.findByRole('alert')).toHaveTextContent('The model’s service stopped before your image was done.');
    });

    it('names a run picked up on load and what it holds, as its failure does', async () => {
      fetchGenerationStatusWithRetryMock.mockImplementation(() => new Promise(() => undefined));
      const fetchMock = installFetch({ activeRun: runAtWork() });
      render(<CreateImageClient prefill={{}} />);

      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(await within(canvas).findByText('8 credits are held for this run. If it fails, they come back.')).toBeInTheDocument();
      expect(within(canvas).getByTestId('creator-canvas-chip')).toHaveTextContent(/ · 8 credits$/);
      // Asked of the API with the session's token, then followed by its prediction.
      expect(activeRunReads(fetchMock)).toEqual([
        ['/api/generations/active?tool=image', { headers: { Authorization: 'Bearer test-token' }, signal: expect.any(AbortSignal) }],
      ]);
      expect(fetchGenerationStatusWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/generate-image?id=pred-old' }));
    });

    // Development mounts the page twice (Strict Mode), and each mount looks. A second follower
    // aborted the first one's poll, whose ending then set the page idle under the live run.
    it('follows a run picked up on load once, though the page mounts twice', async () => {
      fetchGenerationStatusWithRetryMock.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('Generation status check cancelled.'), { name: 'AbortError' })));
      }));
      const fetchMock = installFetch({ activeRun: runAtWork() });
      render(<StrictMode><CreateImageClient prefill={{}} /></StrictMode>);

      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(await within(canvas).findByText('8 credits are held for this run. If it fails, they come back.')).toBeInTheDocument();
      await waitFor(() => expect(activeRunReads(fetchMock)).toHaveLength(2));
      // Both looks answered and every step after them ran.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetchGenerationStatusWithRetryMock).toHaveBeenCalledTimes(1);
      expect(within(canvas).getByText('8 credits are held for this run. If it fails, they come back.')).toBeInTheDocument();
    });

    // The page's unmount aborts only a poll that exists: a look still out then would start
    // one nothing stops.
    it('drops a look that answers after the page has gone', async () => {
      const look = heldAnswer();
      const fetchMock = installFetch({ activeRunAnswer: look.promise });
      const view = render(<CreateImageClient prefill={{}} />);
      await waitFor(() => expect(activeRunReads(fetchMock)).toHaveLength(1));

      view.unmount();
      await act(async () => {
        look.answer(jsonResponse(200, { run: runAtWork() }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetchGenerationStatusWithRetryMock).not.toHaveBeenCalled();
    });

    it('keeps the creator\'s own press, refusal and all, when the look answers after it', async () => {
      const look = heldAnswer();
      const fetchMock = installFetch({
        starts: [{ status: 402, body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 8 credits.' } }],
        activeRunAnswer: look.promise,
      });
      render(<CreateImageClient prefill={{}} />);
      await waitFor(() => expect(activeRunReads(fetchMock)).toHaveLength(1));
      typePrompt('A lighthouse at dawn');
      pressGenerate();
      expect(await screen.findByText('Insufficient credits. This action costs 8 credits.')).toBeInTheDocument();

      await act(async () => {
        look.answer(jsonResponse(200, { run: runAtWork() }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(screen.getByText('Insufficient credits. This action costs 8 credits.')).toBeInTheDocument();
      expect(fetchGenerationStatusWithRetryMock).not.toHaveBeenCalled();
    });

    // A look that fails says nothing: the run still reaches Studio and its alert.
    it('opens idle, with nothing held, when the look for a run at work fails', async () => {
      const fetchMock = installFetch();
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/generations/active')) return jsonResponse(500, { error: 'Could not check for a run in progress.' });
        throw new Error(`Unexpected fetch: ${String(input)}`);
      });
      render(<CreateImageClient prefill={{}} />);

      await waitFor(() => expect(activeRunReads(fetchMock)).toHaveLength(1));
      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(within(canvas).queryByText(/credits are held for this run/)).not.toBeInTheDocument();
      expect(fetchGenerationStatusWithRetryMock).not.toHaveBeenCalled();
    });

    // The shell's run toast would only say again what the canvas says, over Publish (2026-10-30):
    // the page follows the run it shows, and says how it ended once the canvas shows that.
    it('tells the shell\'s run toasts it follows its run, then how it ended once the canvas shows it', async () => {
      clearGenerationsOnPage();
      const heard = vi.fn();
      const unsubscribe = subscribeToGenerationOnPage(heard);
      try {
        let finish: (value: unknown) => void = () => {};
        fetchGenerationStatusWithRetryMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
        installFetch({ starts: [startedReply()] });
        render(<CreateImageClient prefill={{}} />);
        typePrompt('A lighthouse at dawn');
        pressGenerate();

        const canvas = screen.getByRole('region', { name: 'Result' });
        expect(await within(canvas).findByRole('heading', { name: 'Making your image' })).toBeInTheDocument();
        await waitFor(() => expect(heard).toHaveBeenCalledWith({ id: 'gen-new', state: 'following' }));
        expect(heard).toHaveBeenCalledTimes(1);

        await act(async () => {
          finish({ status: 'failed', error: 'Unknown error' });
        });
        expect(await within(canvas).findByRole('heading', { name: 'It didn’t finish' })).toBeInTheDocument();
        await waitFor(() => expect(heard).toHaveBeenCalledWith({ id: 'gen-new', state: 'failed' }));
        expect(heard).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
        clearGenerationsOnPage();
      }
    });

    // The artboards Generating and Result (owner, 2026-10-28), and the build notes' focus on "Done".
    it('says what a run at work holds, then Done with the run\'s line and the focus', async () => {
      let finish: (value: unknown) => void = () => {};
      fetchGenerationStatusWithRetryMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      installFetch({ starts: [startedReply()] });
      render(<CreateImageClient prefill={{}} />);
      typePrompt('A lighthouse at dawn');
      pressGenerate();

      const canvas = screen.getByRole('region', { name: 'Result' });
      expect(await within(canvas).findByRole('heading', { name: 'Making your image' })).toBeInTheDocument();
      expect(await within(canvas).findByText('8 credits are held for this run. If it fails, they come back.')).toBeInTheDocument();

      await act(async () => {
        finish({ status: 'succeeded', output: 'https://cdn.example/lighthouse.png', outputs: ['https://cdn.example/lighthouse.png'] });
      });
      const heading = await within(canvas).findByRole('heading', { name: 'Done' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(within(canvas).getByTestId('creator-canvas-chip')).toHaveTextContent(/ · 8 credits$/);
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
    fireEvent.click(screen.getByRole('button', { name: 'Preview generated image 1' }));
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

  // Publishing on the canvas (PR 3b, the artboard Result): the form starts from the creation's
  // own title and its recipe, read once the run is done, as the Publish window did.
  it('starts the canvas’s publish form from the creation’s title and recipe', async () => {
    const paywallPrefill = { resourceKinds: ['prompt'], promptText: 'A lighthouse at dawn', notesMarkdown: null, allowRemix: false };
    const fetchMock = installFetch({
      starts: [startedReply()],
      publishDetails: { generations: [{ id: 'gen-new', title: 'Lighthouse study', paywallPrefill }] },
    });
    render(<CreateImageClient prefill={{}} />);
    typePrompt('A lighthouse at dawn');
    pressGenerate();
    await findResult();

    const form = await screen.findByRole('form', { name: 'Post it to the feed' });
    await waitFor(() => expect(within(form).getByRole('textbox', { name: 'Title' })).toHaveValue('Lighthouse study'));
    // On by default where the creation has a recipe to share (owner, 2026-10-28).
    expect(within(form).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: /Publish & share/ })).toBeNull();
    const creationRead = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/generations?'));
    expect(String(creationRead?.[0])).toContain('id=gen-new');
    expect((creationRead?.[1] as RequestInit).headers).toEqual({ Authorization: 'Bearer test-token' });
  });

  it('marks the Studio link with a gallery icon rather than a download one', () => {
    installFetch();
    render(<CreateImageClient prefill={{}} />);

    // One, at the head of the result canvas.
    const studioLinks = screen.getAllByRole('link', { name: /Studio/ });
    expect(studioLinks).toHaveLength(1);
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
    expect(screen.queryByText(/This page is out of date/)).not.toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    typePrompt('A lighthouse at dawn');
    expect(screen.queryByText(/prompts need at least/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date');
    expect(generateButton()).toBeDisabled();
    expect(startCalls(fetchMock)).toHaveLength(1);
  });
});

// PR 2 of the creator redesign (owner, 2026-10-28): the model list and the settings priced,
// and the balance read under the bar. Prices come from the price lists' stand-in.
describe('CreateImageClient prices', () => {
  beforeEach(() => {
    getPersistedImageElementRecordsMock.mockReset();
    getPersistedImageElementRecordsMock.mockResolvedValue([]);
    modelCatalogState.missingIds = [];
    modelCatalogState.error = null;
    modelCatalogState.summaries = imageModelSummaries;
    modelCatalogState.models = [testDescriptors.nanoBanana, { ...testDescriptors.nanoBanana, id: 'imagen-4', displayName: 'Imagen 4' }];
    authState.credits = 6;
    priceListStandIn.price = pricedBy((request) => (request.modelId === 'imagen-4' ? 4 : request.settings?.resolution === '4K' ? 18 : 8));
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    modelCatalogState.models = null;
    authState.credits = 10_000;
  });

  it('prices each model at this run\'s settings and splits the list by the balance', async () => {
    const view = render(<CreateImageClient prefill={{}} />);
    // 8 credits is past the 6: Top up stands in Generate's place.
    expect(await screen.findByRole('link', { name: /Top Up Credits/ })).toBeInTheDocument();

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!);

    expect(within(screen.getByRole('group', { name: 'Fits your 6 credits' })).getByRole('option', { name: /Imagen 4/ }))
      .toHaveTextContent('4 credits');
    expect(within(screen.getByRole('group', { name: 'Needs more credits' })).getByRole('option', { name: /Nano Banana 2\.0/ }))
      .toHaveTextContent('8 credits');
  });

  it('says what each model keeps of every picture on the grid, the model in use too', async () => {
    getPersistedImageElementRecordsMock.mockResolvedValueOnce(Array.from({ length: 11 }, (_, index) => ({
      id: `restored-${index + 1}`,
      displayName: `Restored ${index + 1}`,
      file: new File([`image-${index + 1}`], `restored-${index + 1}.png`, { type: 'image/png' }),
    })));
    const view = render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByText(/Your references are preserved/)).toBeInTheDocument();

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!);

    // Nano Banana 2.0 takes ten of the eleven; Imagen 4 is prompt-only.
    expect(screen.getByRole('option', { name: /Nano Banana 2\.0/ })).toHaveTextContent('Keeps 10 of your 11 references');
    expect(screen.getByRole('option', { name: /Imagen 4/ })).toHaveTextContent('Drops your references');
  });

  it('splits the list once every price is in, a model whose details are missing among the unpriced', async () => {
    modelCatalogState.summaries = [
      ...imageModelSummaries,
      { id: 'ideogram-v3', kind: 'image', displayName: 'Ideogram V3', description: 'Test model without details' },
    ];
    modelCatalogState.missingIds = ['ideogram-v3'];
    const view = render(<CreateImageClient prefill={{}} />);
    expect(await screen.findByRole('link', { name: /Top Up Credits/ })).toBeInTheDocument();

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!);

    expect(screen.getByRole('group', { name: 'Fits your 6 credits' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Not priced' })).getByRole('option', { name: /Ideogram V3/ })).toBeInTheDocument();
  });

  it('prices every option of the settings, and reads the balance under the bar', async () => {
    authState.credits = 10;
    render(<CreateImageClient prefill={{}} />);
    await waitFor(() => expect(costShown()).toBe('8 credits'));
    expect(document.querySelector('[data-creator-bar-note]')).toHaveTextContent('Balance 10');
    expect(document.querySelector('[data-creator-bar-note]')).toHaveTextContent('Leaves 2');

    fireEvent.click(screen.getByRole('button', { name: /^Generation settings/ }));

    const settings = screen.getByRole('dialog', { name: 'Generation settings' });
    expect(within(settings).getByRole('radio', { name: '4K, 18 credits, 8 more than your balance' })).toHaveTextContent('4K18 · +8');
    expect(settings).toHaveTextContent('This run 8 credits · leaves 2');
    // What "+8" means, as the video creator says it.
    expect(settings).toHaveTextContent('“+8” means 8 credits more than your balance of 10.');
  });
});

/**
 * The server's opening (`loadCreatorOpening`), drawn from the first paint (2026-10-29): the model the page
 * opens on, its published settings and the run's price, until the first pick and the page's own price.
 */
describe('CreateImageClient opening', () => {
  const opening: CreatorOpening = {
    revision: 'test-catalog-rev',
    modelId: 'gpt-image-2',
    settings: { aspectRatio: '4:5', resolution: '2K' },
    costCredits: 14,
  };
  const modelChip = (container: HTMLElement) => container.querySelector('button[aria-haspopup="listbox"]');

  it('draws the opening\'s model, settings and price before its catalog is in', () => {
    modelCatalogState.catalogReady = false;
    const view = render(<CreateImageClient prefill={{}} opening={opening} />);

    expect(modelChip(view.container)).toHaveTextContent('GPT Image 2');
    expect(screen.getByRole('button', { name: /^Generation settings: / })).toHaveAccessibleName('Generation settings: 2K · 4:5');
    expect(view.container.querySelector('[data-creator-bar-note]')).toHaveTextContent('Balance 10000Leaves 9986');
  });

  it('waits for the revision the network confirms before its first pick', async () => {
    // The browser's stored catalog names Nano Banana 2 its default: until the network confirms it,
    // the page keeps the run it was drawn on.
    modelCatalogState.checkingRevision = true;
    const view = render(<CreateImageClient prefill={{}} opening={opening} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modelChip(view.container)).toHaveTextContent('GPT Image 2');

    modelCatalogState.checkingRevision = false;
    view.rerender(<CreateImageClient prefill={{}} opening={opening} />);
    await waitFor(() => expect(modelChip(view.container)).toHaveTextContent('Nano Banana 2'));
  });

  it('keeps a model the creator picks while the page waits for the revision', async () => {
    modelCatalogState.checkingRevision = true;
    modelCatalogState.summaries = imageModelSummaries;
    const view = render(<CreateImageClient prefill={{}} opening={opening} />);
    chooseModel(view.container, 'Imagen 4');
    expect(modelChip(view.container)).toHaveTextContent('Imagen 4');

    modelCatalogState.checkingRevision = false;
    view.rerender(<CreateImageClient prefill={{}} opening={opening} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(modelChip(view.container)).toHaveTextContent('Imagen 4');
  });
});
