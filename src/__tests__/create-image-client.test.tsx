import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateImageClient from '@/app/create-image/CreateImageClient';
import type { PersistedImageElementRecord } from '@/lib/persisted-media';
import type { RemixSourceBundle } from '@/lib/remix-source';

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
