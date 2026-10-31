import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
// vitest resolves next/link to the pages-router Link, which only navigates (and
// only calls onNavigate) inside this context.
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewPostClient from '@/app/post/new/NewPostClient';
import type { EditablePostDraft } from '@/app/post/new/post-editor-types';
import FeedbackViewport from '@/components/FeedbackViewport';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import { TITLE_MAX_LENGTH } from '@/lib/posts-server';

// One router object for every render: the composer's effects list the router
// as a dependency, and a fresh object per render reruns them on every render.
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const mockPush = routerMock.push;
const fetchMock = vi.fn();
const temporaryUploadMock = vi.hoisted(() => vi.fn());
const directResourceUploadMock = vi.hoisted(() => vi.fn(async (...args: unknown[]) => {
  void args;
  return { error: null };
}));
const searchParamsState = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsState.value,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
  }),
}));

vi.mock('@/lib/temporary-media-upload', () => ({
  uploadMediaToTemporaryStorage: temporaryUploadMock,
}));

// A picked video's length, as the browser reads it (its own test file). A jsdom
// media element never loads, so the real reader would hold every video pick
// until its 4 s timeout; unread (null) leaves the length to the server, as these
// tests always had it, and a test that needs a length answers it once.
const readVideoDurationMock = vi.hoisted(() => vi.fn(async (source: File | string): Promise<number | null> => {
  void source;
  return null;
}));
vi.mock('@/lib/video-metadata-probe', () => ({
  readVideoDurationSeconds: readVideoDurationMock,
}));

// The composer reads the profile up front to ask for a name and handle before
// a public post. Unread (null) leaves the decision to the server, as these
// tests always had it; the identity tests answer it themselves.
const loadOwnProfileMock = vi.hoisted(() => vi.fn());
const claimPublicIdentityMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/public-identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/public-identity')>(),
  loadOwnProfile: loadOwnProfileMock,
  claimPublicIdentity: claimPublicIdentityMock,
}));

vi.mock('@/lib/signed-url-upload', async () => {
  const { UploadCancelledError } = await import('@/lib/upload-queue');
  return {
    resolveSignedUploadUrl: (intent: {
      path: string;
      token: string;
      signedUploadUrl?: string | null;
    }) => intent.signedUploadUrl
      ?? `https://storage.example.test/storage/v1/object/upload/sign/post_resource_files/${intent.path}?token=${intent.token}`,
    uploadFileToSignedUrl: (
      file: File,
      signedUploadUrl: string,
      options: {
        mimeType: string;
        onProgress?: (progress: { bytesSent: number; totalBytes: number; fraction: number }) => void;
        signal?: AbortSignal;
      },
    ) => {
      const url = new URL(signedUploadUrl);
      const marker = '/post_resource_files/';
      const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
      const token = url.searchParams.get('token');
      options.onProgress?.({ bytesSent: Math.floor(file.size / 2), totalBytes: file.size, fraction: 0.5 });
      const upload = Promise.resolve(directResourceUploadMock(
        path,
        token,
        file,
        { contentType: options.mimeType },
      )).then(() => undefined);
      if (!options.signal) return upload;
      if (options.signal.aborted) return Promise.reject(new UploadCancelledError());
      return new Promise<void>((resolve, reject) => {
        const abort = () => reject(new UploadCancelledError());
        options.signal!.addEventListener('abort', abort, { once: true });
        upload.then(
          () => {
            options.signal!.removeEventListener('abort', abort);
            options.onProgress?.({ bytesSent: file.size, totalBytes: file.size, fraction: 1 });
            resolve();
          },
          reject,
        );
      });
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        uploadToSignedUrl: directResourceUploadMock,
      }),
    },
  },
}));

const sharePublicGenerationMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/share-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-client')>()),
  sharePublicGeneration: sharePublicGenerationMock,
}));

const SOURCE_TOOLS_RESPONSE = {
  tools: [
    { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
    { slug: 'higgsfield', label: 'Higgsfield', models: [{ slug: 'soul', label: 'Soul' }], supportedMediaKinds: ['image', 'video'] },
    { slug: 'runway', label: 'Runway', models: [{ slug: 'gen-4', label: 'Gen-4' }], supportedMediaKinds: ['image', 'video'] },
    { slug: 'midjourney', label: 'Midjourney', models: [], supportedMediaKinds: ['image'] },
    { slug: 'kling', label: 'Kling', models: [], supportedMediaKinds: ['image', 'video'] },
    {
      slug: 'sora',
      label: 'Sora',
      models: [],
      supportedMediaKinds: ['video'],
      toolType: 'platform',
      capabilities: ['video'],
      catalogTier: 'historical',
      status: 'sunset',
      providerSlug: 'openai',
      aliases: ['OpenAI video'],
    },
    { slug: 'veo', label: 'Veo', models: [], supportedMediaKinds: ['video'] },
    { slug: 'capcut', label: 'CapCut', models: [], supportedMediaKinds: ['image', 'video'] },
    { slug: 'freepik', label: 'Freepik', models: [], supportedMediaKinds: ['image'] },
  ],
};

let queuedResponses: Array<{ ok: boolean; json: () => Promise<unknown>; status?: number }> = [];

function enqueueResponse(response: { ok: boolean; json: () => Promise<unknown>; status?: number }) {
  queuedResponses.push(response);
}

function createLegacyPrivateResourcePost(): EditablePostDraft {
  return {
    id: 'post-private-resource-title',
    generationId: null,
    title: 'A post with a legacy resource label',
    description: '',
    prompt: '',
    body: '',
    visibility: 'public',
    category: 'image',
    postFormat: 'media',
    sourceKind: 'external',
    sourceTool: 'Pika Labs',
    sourceToolSlug: 'pika-labs',
    sourceTools: [{ toolLabel: 'Pika Labs', toolSlug: 'pika-labs' }],
    mediaUrl: '/proof.png',
    mediaKind: 'image',
    archivedAt: null,
    resourceBundle: {
      accessMode: 'free',
      previewText: 'A reusable prompt supporting this finished image.',
      resources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        sections: [{
          id: 'private-section',
          title: 'Secret client launch prompt',
          kind: 'global',
          description: null,
          sortOrder: 0,
        }],
        items: [{
          id: 'private-prompt',
          scope: { kind: 'all' },
          type: 'prompt',
          role: 'primary',
          sectionId: 'private-section',
          title: 'Internal prompt copy',
          description: null,
          textContent: 'A detailed prompt that should remain protected.',
          externalUrl: null,
          storagePath: null,
          contentType: null,
          sizeBytes: null,
          workflowSnapshot: null,
          sortOrder: 0,
          isPrimary: true,
          remixUse: 'text_template',
        }],
      },
    },
    hasPaidOrders: false,
  };
}

describe('NewPostClient', () => {
  beforeEach(() => {
    mockPush.mockReset();
    routerMock.replace.mockReset();
    sharePublicGenerationMock.mockReset();
    fetchMock.mockReset();
    loadOwnProfileMock.mockReset();
    loadOwnProfileMock.mockResolvedValue(null);
    claimPublicIdentityMock.mockReset();
    temporaryUploadMock.mockReset();
    readVideoDurationMock.mockReset();
    directResourceUploadMock.mockReset();
    directResourceUploadMock.mockResolvedValue({ error: null });
    temporaryUploadMock.mockImplementation(async (file: File) => ({
      signedUrl: `https://storage.example.test/signed/${file.name}`,
      storagePath: `uploads/user-1/${file.name}`,
    }));
    searchParamsState.value = new URLSearchParams();
    queuedResponses = [];
    fetchMock.mockImplementation(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
      if (urlStr.startsWith('/api/source-tools')) {
        return { ok: true, json: async () => SOURCE_TOOLS_RESPONSE };
      }
      const next = queuedResponses.shift();
      if (next) return next;
      throw new Error(`Unexpected fetch: ${urlStr} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The order of the fields is held by 'puts media first, then the title…'.
  it('puts the public post hierarchy in the main composer path', () => {
    render(<NewPostClient />);

    expect(screen.getByRole('heading', { name: /create post/i })).toBeInTheDocument();
    expect(screen.getByText(/Share your work/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^title/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^story/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^media$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^media$/i })).toBeInTheDocument();
  });

  it('caps the title input at the limit and shows a live counter', () => {
    render(<NewPostClient />);

    const titleInput = screen.getByRole('textbox', { name: /^title/i });
    expect(screen.getByText(`0/${TITLE_MAX_LENGTH}`)).toBeInTheDocument();
    expect(titleInput).toHaveAttribute('maxlength', String(TITLE_MAX_LENGTH));

    fireEvent.change(titleInput, { target: { value: 'a'.repeat(TITLE_MAX_LENGTH) } });
    const atLimit = screen.getByText(`${TITLE_MAX_LENGTH}/${TITLE_MAX_LENGTH}`);
    expect(atLimit).toBeInTheDocument();
    expect(atLimit).not.toHaveClass('text-rose-300');
  });

  // A post written before the cap existed still opens in the editor with its
  // original title. The counter flags it, but the composer must not refuse to
  // save — the server grandfathers an unchanged title, and blocking here would
  // strand the author on every other field.
  // The Recipe preview is required: one the creator clears is asked for.
  it('blocks publishing a recipe whose preview was cleared', async () => {
    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A note that stands on its own for the community.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'A reusable prompt.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), { target: { value: '' } });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Add a recipe preview.');
    expect(screen.getByLabelText(/recipe preview, required/i)).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // S6 (2026-10-27): one public text in place of a "Public summary" that
  // silently won over a required "Package preview".
  it('asks for one Recipe preview that everyone sees before unlocking', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));

    const recipe = within(document.getElementById('recipe')!);
    const preview = recipe.getByLabelText(/recipe preview, required/i);
    expect(preview).toHaveAttribute('maxlength', '180');
    expect(recipe.getByText('0/180')).toBeInTheDocument();
    expect(recipe.getByText('Everyone sees this before unlocking.')).toBeInTheDocument();
    expect(recipe.queryByLabelText(/summary/i)).not.toBeInTheDocument();
    expect(recipe.queryByText(/package|resource/i)).not.toBeInTheDocument();
    expect(recipe.queryByRole('button', { name: /use suggested preview/i })).not.toBeInTheDocument();
    // An upload post has no Remix, and the switch is gone everywhere (S1).
    expect(recipe.queryByRole('checkbox', { name: /remix/i })).not.toBeInTheDocument();
    expect(recipe.queryByText(/remix comes with this recipe/i)).not.toBeInTheDocument();
  });

  // S6/S7: the preview is written from the items as they are saved, and
  // follows them until the creator writes in it.
  it('suggests the preview from the items and stops once the creator writes it', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    const preview = () => screen.getByLabelText(/recipe preview, required/i);
    expect(preview()).toHaveValue('');

    const addItem = (type: RegExp, text: string) => {
      fireEvent.click(screen.getByRole('button', { name: /^add item$/i }));
      fireEvent.click(screen.getByRole('button', { name: type }));
      fireEvent.change(screen.getByLabelText(/^protected content$/i), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    };
    addItem(/prompt or script/i, 'Open with the before state, then reveal the product.');
    expect(preview()).toHaveValue('Includes the prompt.');
    addItem(/guide or notes/i, 'Keep the first shot under seven seconds.');
    expect(preview()).toHaveValue('Includes the prompt and a written guide.');

    fireEvent.change(preview(), { target: { value: 'The hook prompt and the timing notes behind it.' } });
    addItem(/prompt or script/i, 'A second prompt for the closing shot.');
    expect(preview()).toHaveValue('The hook prompt and the timing notes behind it.');
  });

  // The app's choice, as cards: a creator sees that a recipe can be sold
  // before choosing anything, where a checkbox hid Paid behind a second step
  // (and a status pill in the heading repeated what the controls said).
  it('offers free, paid and no recipe as one choice of three cards', () => {
    render(<NewPostClient />);

    const free = screen.getByRole('radio', { name: /free recipe/i });
    const paid = screen.getByRole('radio', { name: /paid recipe/i });
    const none = screen.getByRole('radio', { name: /no recipe/i });
    expect(none).toBeChecked();
    // One group: what makes the arrow keys move between the cards.
    expect(new Set([free, paid, none].map((radio) => radio.getAttribute('name'))).size).toBe(1);
    expect(free).toHaveAttribute('name', expect.stringMatching(/\S/));
    expect(screen.queryByRole('checkbox', { name: /add a reusable recipe/i })).toBeNull();
    expect(screen.queryByLabelText(/price in credits/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /add your first item/i })).toBeNull();

    fireEvent.click(paid);
    expect(paid).toBeChecked();
    expect(screen.getByLabelText(/price in credits/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add your first item/i })).toBeInTheDocument();

    fireEvent.click(free);
    expect(free).toBeChecked();
    expect(screen.queryByLabelText(/price in credits/i)).toBeNull();
    expect(screen.getByText(/add a free recipe to their library/i)).toBeInTheDocument();

    fireEvent.click(none);
    expect(none).toBeChecked();
    expect(screen.queryByRole('button', { name: /add your first item/i })).toBeNull();
  });

  // D1 (2026-10-27): a recipe people have can be corrected; each save is a
  // new version and they keep the one they got. The composer says so.
  it('lets a recipe people have be edited, and says they keep the version they got', () => {
    const { unmount } = render(
      <NewPostClient initialPost={{ ...createLegacyPrivateResourcePost(), hasPaidOrders: true, resourceBundleBuyerCount: 3 }} />,
    );

    const free = screen.getByRole('radio', { name: /free recipe/i });
    expect(free).toBeChecked();
    expect(free).toBeEnabled();
    expect(screen.getByRole('radio', { name: /paid recipe/i })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /no recipe/i })).toBeEnabled();
    expect(screen.getByText('3 people have this recipe. They keep the version they got and see your changes.')).toBeInTheDocument();
    expect(screen.queryByText(/protected/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add item$/i })).toBeEnabled();
    expect(screen.getByLabelText(/recipe preview, required/i)).toBeEnabled();
    unmount();

    render(<NewPostClient initialPost={{ ...createLegacyPrivateResourcePost(), resourceBundleBuyerCount: 1 }} />);
    expect(screen.getByText('1 person has this recipe. They keep the version they got and see your changes.')).toBeInTheDocument();
  });

  // Chrome's implicit submission skips the composer's disabled first submit
  // button for a non-text control and clicks the next one, "Save private":
  // on the E2E harness Enter on a card posted the form. Enter chooses the
  // card instead, and the form takes Enter from every checkbox too; a text
  // field keeps it (the disabled first button makes it do nothing).
  it('takes Enter on a recipe card as the choice, never as a submit', () => {
    render(<NewPostClient />);

    const paid = screen.getByRole('radio', { name: /paid recipe/i });
    expect(fireEvent.keyDown(paid, { key: 'Enter' })).toBe(false);
    expect(paid).toBeChecked();
    expect(fireEvent.keyDown(paid, { key: 'Enter' })).toBe(false);
    expect(paid).toBeChecked();
    expect(fireEvent.keyDown(screen.getByRole('checkbox', { name: /mark as nsfw/i }), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(screen.getByRole('textbox', { name: /^title/i }), { key: 'Enter' })).toBe(true);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/posts', expect.anything());
  });

  // The cards are now the one control that takes a recipe off a post: the
  // save must say so, since the update path keeps what is stored for a
  // missing key. H2 (2026-10-27): that save deletes the recipe and its
  // files, so it asks first.
  it('asks before an edit’s save removes the recipe, and sends the removal only when told to', async () => {
    const putCalls = () => fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/posts/') && init?.method === 'PUT');
    enqueueResponse({
      ok: true,
      json: async () => ({ success: true, postId: 'post-private-resource-title', visibility: 'public' }),
    });
    render(
      <>
        <NewPostClient initialPost={createLegacyPrivateResourcePost()} />
        <FeedbackViewport />
      </>
    );

    expect(screen.getByRole('radio', { name: /free recipe/i })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /no recipe/i }));
    expect(screen.queryByText('Secret client launch prompt')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

    const question = await screen.findByRole('alertdialog', { name: 'Remove this recipe?' });
    expect(question).toHaveAccessibleDescription('Its 1 item and files will be deleted.');
    fireEvent.click(within(question).getByRole('button', { name: 'Keep recipe' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(putCalls()).toHaveLength(0);

    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove recipe' }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const payload = JSON.parse(String((putCalls()[0][1] as { body: string }).body));
    expect(payload.resourceBundle).toEqual({ accessMode: 'none' });
  });

  it('says the people who have a recipe keep it when it is removed', async () => {
    render(
      <>
        <NewPostClient initialPost={{ ...createLegacyPrivateResourcePost(), resourceBundleBuyerCount: 2 }} />
        <FeedbackViewport />
      </>
    );

    fireEvent.click(screen.getByRole('radio', { name: /no recipe/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);
    const question = await screen.findByRole('alertdialog', { name: 'Remove this recipe?' });
    expect(question).toHaveAccessibleDescription(
      'Its 1 item and files will be deleted. The 2 people who have it keep their copy; it comes off sale.',
    );
    expect(within(question).getByRole('button', { name: 'Remove recipe' })).toBeInTheDocument();
  });

  // A creation post without a recipe shows its prompt and lets anyone remix
  // (S1), so taking the recipe off puts the post back that way: said in the
  // question rather than found out (review of #567).
  it('says a creation post reopens its prompt and Remix when its recipe is removed', async () => {
    // A creation-backed edit reads its creation first, as the sold-generation save below does.
    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [{ id: 'gen-1', output_url: 'https://proxy.example.com/generated_images/user-1/one.jpg', category: 'image', title: 'One', description: '', prompt: 'The prompt.', model: 'nano-banana-2' }],
      }),
    });
    render(
      <>
        <NewPostClient initialPost={{ ...createLegacyPrivateResourcePost(), generationId: 'gen-1', resourceBundleBuyerCount: 2 }} />
        <FeedbackViewport />
      </>
    );

    // The creation loads first; until it has, the save is held.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^make private/i })[0]).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: /no recipe/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);
    const question = await screen.findByRole('alertdialog', { name: 'Remove this recipe?' });
    expect(question).toHaveAccessibleDescription(
      'Its 1 item and files will be deleted. The 2 people who have it keep their copy; it comes off sale. '
      + 'The post’s prompt and Remix will be open to everyone again, as on any post without a recipe.',
    );
  });

  // The Free/Paid pills counted every click, the checkbox none; the cards
  // count a choice of Free or Paid, never No recipe or the card already chosen.
  it('counts a choice of free or paid once, and no recipe never', () => {
    searchParamsState.value = new URLSearchParams('from=creations');
    const events: Array<{ eventName: string; parameters: Record<string, unknown> }> = [];
    const recordEvent = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('magicbooklet:product-event', recordEvent);
    try {
      render(<NewPostClient />);
      const selections = () => events
        .filter((event) => event.eventName === 'recipe_access_mode_selected')
        .map((event) => event.parameters);

      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(selections()).toEqual([{ access_mode: 'free', entry_surface: 'creations' }]);
      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(selections()).toHaveLength(1);
      fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
      expect(selections()).toEqual([
        { access_mode: 'free', entry_surface: 'creations' },
        { access_mode: 'paid', entry_surface: 'creations' },
      ]);
      fireEvent.click(screen.getByRole('radio', { name: /no recipe/i }));
      expect(selections()).toHaveLength(2);
    } finally {
      window.removeEventListener('magicbooklet:product-event', recordEvent);
    }
  });

  // Studio opens a free recipe's editor at the price too (`focus=price`): the
  // request waited for Paid, so an arrow from Free to Paid pulled the focus
  // into the price field, where the next arrow changed the price.
  it('does not move the focus to the price when the creator changes a free recipe to paid', async () => {
    searchParamsState.value = new URLSearchParams('resourceMode=free&focus=price&from=creations');
    render(<NewPostClient initialPost={createLegacyPrivateResourcePost()} />);

    expect(screen.getByText(/you came from my studio to manage this post/i)).toBeInTheDocument();
    const free = screen.getByRole('radio', { name: /free recipe/i });
    expect(free).toBeChecked();
    free.focus();
    fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
    const priceInput = screen.getByRole('spinbutton', { name: /price in credits/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(priceInput).not.toHaveFocus();
  });

  // Saving an empty card produced a row the publish gate silently discarded,
  // which read as the composer losing the resource. Mobile has always refused.
  it('refuses to save a resource card with no content', () => {
    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/external link/i);

    expect(screen.getByRole('button', { name: /save item/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^link$/i), {
      target: { value: 'https://ugc.example.com/doc' },
    });
    expect(screen.getByRole('button', { name: /save item/i })).toBeEnabled();
  });

  // A-F14: a new item opened in red. Errors now wait for a touched field;
  // until then a plain line says what Save is waiting for.
  it('holds the item editor’s errors until a field was touched, with a plain line meanwhile', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/external link/i);

    const dialog = within(screen.getByRole('dialog'));
    const save = dialog.getByRole('button', { name: /save item/i });
    const link = dialog.getByLabelText(/^link$/i);
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('Add a link to save this item.');
    expect(dialog.queryByText(/add the content, link, or file/i)).not.toBeInTheDocument();
    expect(link).toHaveAttribute('aria-invalid', 'false');

    fireEvent.change(link, { target: { value: 'ugc.example.com/doc' } });
    expect(dialog.queryByText('Add a valid http:// or https:// link.')).not.toBeInTheDocument();
    fireEvent.blur(link);
    expect(dialog.getByText('Add a valid http:// or https:// link.')).toBeInTheDocument();
    expect(link).toHaveAttribute('aria-invalid', 'true');

    const title = dialog.getByLabelText(/item title, required/i);
    fireEvent.change(title, { target: { value: '' } });
    expect(dialog.queryByText('Add an item title.')).not.toBeInTheDocument();
    fireEvent.blur(title);
    expect(dialog.getByText('Add an item title.')).toBeInTheDocument();

    fireEvent.change(title, { target: { value: 'Prompt doc' } });
    fireEvent.change(link, { target: { value: 'https://ugc.example.com/doc' } });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAccessibleDescription(expect.stringMatching(/\S/));
  });

  // S8: the four types nearly every recipe uses come first; the rest wait
  // behind More types.
  it('offers four item types first and the other five behind More types', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));

    const dialog = screen.getByRole('dialog', { name: 'Add an item' });
    const rowNames = () => within(dialog).getAllByRole('button')
      .filter((button) => button.getAttribute('aria-label') !== 'Close item editor')
      .map((button) => button.textContent ?? '');
    expect(rowNames()).toEqual([
      expect.stringMatching(/^Prompt or script/),
      expect.stringMatching(/^Reference media/),
      expect.stringMatching(/^Model settings/),
      expect.stringMatching(/^Guide or notes/),
      'More types',
    ]);
    const more = within(dialog).getByRole('button', { name: 'More types' });
    expect(more).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(rowNames().slice(5)).toEqual([
      expect.stringMatching(/^Workflow or project/),
      expect.stringMatching(/^Source assets/),
      expect.stringMatching(/^External link/),
      expect.stringMatching(/^Remix link/),
      expect.stringMatching(/^Other/),
    ]);

    fireEvent.click(within(dialog).getByRole('button', { name: /^source assets/i }));
    const editor = within(screen.getByRole('dialog'));
    expect(editor.getByLabelText(/item title, required/i)).toHaveValue('Source assets');
    expect(editor.getByText('Everyone sees this before unlocking.')).toBeInTheDocument();
    expect(editor.getByLabelText(/note shown after unlock/i)).toBeInTheDocument();
    expect(editor.getByText('Up to 50 MB each.')).toBeInTheDocument();
    expect(editor.getByRole('button', { name: 'Save item' })).toBeDisabled();
  });

  // The editor opens on a type chooser with no card, so its pristine snapshot
  // was taken before the card existed and the warning never fired for new cards.
  it('warns before discarding a new resource card with unsaved edits', async () => {
    render(
      <>
        <NewPostClient />
        <FeedbackViewport />
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'A prompt worth keeping.' },
    });

    // The editor hides the rest of the page from assistive tech while it is
    // up; the question, added after it opened, is still reachable.
    fireEvent.click(screen.getByRole('button', { name: /close item editor/i }));
    const question = await screen.findByRole('alertdialog', { name: 'Discard changes to this item?' });
    fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^protected content$/i)).toHaveValue('A prompt worth keeping.');

    fireEvent.click(screen.getByRole('button', { name: /close item editor/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByLabelText(/^protected content$/i)).not.toBeInTheDocument());
  });

  // Its own Escape and Tab trap listen on the window, which hears a key after
  // the question has handled it.
  it('leaves the keyboard to its discard question while the question is up', async () => {
    render(
      <>
        <NewPostClient />
        <FeedbackViewport />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    const content = screen.getByLabelText(/^protected content$/i);
    fireEvent.change(content, { target: { value: 'A prompt worth keeping.' } });

    content.focus();
    fireEvent.keyDown(content, { key: 'Escape' });
    const question = await screen.findByRole('alertdialog', { name: 'Discard changes to this item?' });
    const keep = within(question).getByRole('button', { name: 'Keep editing' });
    const discard = within(question).getByRole('button', { name: 'Discard changes' });
    await waitFor(() => expect(keep).toHaveFocus());

    // A Tab that does not wrap never reaches the editor's trap beneath.
    fireEvent.keyDown(keep, { key: 'Tab' });
    expect(keep).toHaveFocus();

    discard.focus();
    fireEvent.keyDown(discard, { key: 'Tab' });
    expect(keep).toHaveFocus();

    // Escape answers the question alone: the editor stays open and asks nothing more.
    fireEvent.keyDown(keep, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^protected content$/i)).toHaveValue('A prompt worth keeping.');
  });

  // The server resolves the content type from the extension when the browser
  // cannot name one, and finalize rejects an object that disagrees with it.
  it('uploads a resource file with the content type the server resolved', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        bucket: 'post_resource_files',
        uploadId: 'upload-workflow-json',
        path: 'user-1/abc-workflow.json',
        token: 'signed-token',
        expiresInSeconds: 7200,
        expected: { fileName: 'workflow.json', contentType: 'application/json', sizeBytes: 9 },
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        bucket: 'post_resource_files',
        path: 'user-1/abc-workflow.json',
        storagePath: 'post_resource_files/user-1/abc-workflow.json',
        contentType: 'application/json',
        sizeBytes: 9,
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/source assets/i);

    // The editor is a portal, so its file input lives outside the container.
    // A .json file is one browsers commonly hand over with no type at all.
    const resourceInput = document.querySelector('input[type="file"].sr-only') as HTMLInputElement;
    const file = new File(['{"a":1}'], 'workflow.json', { type: '' });
    await act(async () => {
      fireEvent.change(resourceInput, { target: { files: [file] } });
    });

    expect(directResourceUploadMock).toHaveBeenCalledWith(
      'user-1/abc-workflow.json',
      'signed-token',
      file,
      { contentType: 'application/json' },
    );

    const finalizeCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes('/api/uploads/finalize')
    );
    expect(JSON.parse(String((finalizeCall?.[1] as { body: string }).body))).toEqual({
      uploadId: 'upload-workflow-json',
    });
  });

  it('keeps successful resource uploads when a later file fails', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        bucket: 'post_resource_files',
        uploadId: 'upload-good-json',
        path: 'user-1/good.json',
        token: 'good-token',
        expected: { fileName: 'good.json', contentType: 'application/json', sizeBytes: 4 },
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        bucket: 'post_resource_files',
        path: 'user-1/good.json',
        storagePath: 'post_resource_files/user-1/good.json',
        contentType: 'application/json',
        sizeBytes: 4,
      }),
    });
    enqueueResponse({
      ok: false,
      json: async () => ({ error: 'Storage is temporarily unavailable.' }),
    });

    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/source assets/i);

    const resourceInput = document.querySelector('input[type="file"].sr-only') as HTMLInputElement;
    fireEvent.change(resourceInput, {
      target: {
        files: [
          new File(['good'], 'good.json', { type: 'application/json' }),
          new File(['bad'], 'broken.zip', { type: 'application/zip' }),
        ],
      },
    });

    expect(await screen.findByText('good.json')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/broken\.zip.*storage is temporarily unavailable/i);
    expect(screen.getByRole('button', { name: /save item/i })).toBeEnabled();
  });

  it('keeps the resource editor open and unsaveable while a file uploads', async () => {
    let finishUpload: ((value: { error: null }) => void) | undefined;
    directResourceUploadMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishUpload = resolve;
    }));
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        bucket: 'post_resource_files',
        uploadId: 'upload-slow-png',
        path: 'user-1/slow.png',
        token: 'slow-token',
        expected: { fileName: 'slow.png', contentType: 'image/png', sizeBytes: 4 },
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        bucket: 'post_resource_files',
        path: 'user-1/slow.png',
        storagePath: 'post_resource_files/user-1/slow.png',
        contentType: 'image/png',
        sizeBytes: 4,
      }),
    });

    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/source assets/i);

    const resourceInput = document.querySelector('input[type="file"].sr-only') as HTMLInputElement;
    fireEvent.change(resourceInput, {
      target: { files: [new File(['slow'], 'slow.png', { type: 'image/png' })] },
    });

    expect(await screen.findByText('Uploading')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /close item editor/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /save item/i })).toBeDisabled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/wait for the file upload/i);

    await act(async () => {
      finishUpload?.({ error: null });
    });

    expect(await screen.findByText('slow.png')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
      expect(screen.getByRole('button', { name: /save item/i })).toBeEnabled();
    });
  });

  it('lets a creator cancel a stalled resource upload and retry the same file', async () => {
    directResourceUploadMock
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ error: null });
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        bucket: 'post_resource_files',
        uploadId: 'upload-first-stalled',
        path: 'user-1/first-stalled.png',
        token: 'first-token',
        expected: { fileName: 'stalled.png', contentType: 'image/png', sizeBytes: 7 },
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        bucket: 'post_resource_files',
        uploadId: 'upload-retried',
        path: 'user-1/retried.png',
        token: 'retry-token',
        expected: { fileName: 'stalled.png', contentType: 'image/png', sizeBytes: 7 },
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        bucket: 'post_resource_files',
        path: 'user-1/retried.png',
        storagePath: 'post_resource_files/user-1/retried.png',
        contentType: 'image/png',
        sizeBytes: 7,
      }),
    });

    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/source assets/i);

    const resourceInput = document.querySelector('input[type="file"].sr-only') as HTMLInputElement;
    fireEvent.change(resourceInput, {
      target: { files: [new File(['stalled'], 'stalled.png', { type: 'image/png' })] },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel upload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/upload cancelled/i);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Retry file' }));

    expect(await screen.findByText('stalled.png')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry file' })).not.toBeInTheDocument();
    expect(directResourceUploadMock).toHaveBeenCalledTimes(2);
  });

  it('rejects documents in a reference-media card before upload', async () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /reference media/i }));

    const resourceInput = document.querySelector('input[type="file"].sr-only') as HTMLInputElement;
    expect(resourceInput.getAttribute('accept')).toContain('image/jpeg');
    expect(resourceInput.getAttribute('accept')).toContain('.heic');
    expect(resourceInput.getAttribute('accept')).not.toContain('image/*');
    fireEvent.change(resourceInput, {
      target: { files: [new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/use source assets for documents or archives/i);
    expect(directResourceUploadMock).not.toHaveBeenCalled();
  });

  it('contains focus in the resource dialog and restores it when closed', () => {
    const { container } = render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    const opener = screen.getByRole('button', { name: /add your first item/i });
    opener.focus();
    fireEvent.click(opener);

    expect(container).toHaveAttribute('aria-hidden', 'true');
    const closeButton = screen.getByRole('button', { name: /close item editor/i });
    closeButton.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    // The picker's last stop is "More types" while the other five are folded.
    expect(screen.getByRole('button', { name: 'More types' })).toHaveFocus();

    fireEvent.click(closeButton);
    expect(container).not.toHaveAttribute('aria-hidden');
    expect(opener).toHaveFocus();
  });

  // An "Other" card is the one type that serializes an attachment's own
  // resource type, so the same file has to be typed the same way mobile types
  // it or the two clients write different items for identical input.
  it('types an uploaded attachment the way the mobile composer does', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        bucket: 'post_resource_files',
        uploadId: 'upload-still-png',
        path: 'user-1/abc-still.png',
        token: 'signed-token',
        expiresInSeconds: 7200,
        expected: { fileName: 'still.png', contentType: 'image/png', sizeBytes: 5 },
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        bucket: 'post_resource_files',
        path: 'user-1/abc-still.png',
        storagePath: 'post_resource_files/user-1/abc-still.png',
        contentType: 'image/png',
        sizeBytes: 5,
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-other-card',
        showcasePath: '/showcase/post-other-card',
        resourceBundlePath: '/showcase/post-other-card#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A breakdown with a supporting still attached to it.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/anything useful that does not fit above/i);
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Extras' } });

    const resourceInput = document.querySelector('input[type="file"].sr-only') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(resourceInput, {
        target: { files: [new File(['png'], 'still.png', { type: 'image/png' })] },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'A supporting still from this breakdown.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    const request = fetchMock.mock.calls[3][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(resourceBundle.resources.items).toMatchObject([
      { type: 'reference_image', title: 'still.png', storagePath: 'user-1/abc-still.png' },
    ]);
  });

  // D1 (2026-10-27): a sold recipe is no longer frozen. Buyers keep the
  // version they bought; the creator can still fix a typo, the price or an
  // item, and the save sends the recipe like any other.
  it('edits a recipe people have bought and sends it with the save', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-sold-1',
        visibility: 'public',
      }),
    });

    render(<NewPostClient initialPost={{
      id: 'post-sold-1',
      generationId: null,
      title: 'A sold package with a real title',
      description: '',
      prompt: '',
      body: '',
      visibility: 'public',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'external',
      sourceTool: 'Pika Labs',
      sourceToolSlug: 'pika-labs',
      sourceTools: [{ toolLabel: 'Pika Labs', toolSlug: 'pika-labs' }],
      mediaUrl: '/proof.png',
      mediaKind: 'image',
      archivedAt: null,
      resourceBundle: {
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: 'The prompt and setup behind this image.',
        resources: {
          promptText: 'A detailed prompt that buyers already paid for.',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        },
      },
      hasPaidOrders: true,
    }} />);

    expect(screen.queryByText(/protected/i)).not.toBeInTheDocument();
    const price = screen.getByRole('spinbutton', { name: /price in credits/i });
    expect(price).toHaveValue(900);
    expect(screen.getByRole('button', { name: /^add item$/i })).toBeEnabled();
    expect(screen.getByLabelText(/recipe preview, required/i)).toHaveValue('The prompt and setup behind this image.');

    fireEvent.change(price, { target: { value: '700' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const payload = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));
    expect(payload.resourceBundle).toMatchObject({
      accessMode: 'paid',
      priceUsdCents: 700,
      previewText: 'The prompt and setup behind this image.',
      resources: { allowRemix: false },
    });
  });

  // An existing post made from a creation is saved through the post route
  // like any other post; the publish route is for creating one. A sold
  // recipe goes with it (D1), with the remix value it was loaded with (S1).
  it('saves an existing sold generation post through the post route, its recipe with it', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [{
          id: 'gen-sold-1',
          output_url: 'https://proxy.example.com/generated_images/user-1/sold.jpg',
          category: 'image',
          title: 'Sold generation',
          description: '',
          prompt: 'The original protected prompt.',
          model: 'nano-banana-2',
        }],
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-gen-sold-1',
        showcasePath: '/showcase/post-gen-sold-1',
        resourceBundlePath: '/showcase/post-gen-sold-1#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient initialPost={{
      id: 'post-gen-sold-1',
      generationId: 'gen-sold-1',
      title: 'A sold generated post',
      description: '',
      prompt: 'The original protected prompt.',
      body: '',
      visibility: 'public',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'magicbooklet',
      sourceTool: 'magicbooklet',
      sourceToolSlug: 'magicbooklet',
      sourceTools: [{ toolLabel: 'magicbooklet', toolSlug: 'magicbooklet' }],
      mediaUrl: 'https://proxy.example.com/generated_images/user-1/sold.jpg',
      mediaKind: 'image',
      archivedAt: null,
      resourceBundle: {
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: 'The original prompt behind this generation.',
        resources: {
          promptText: 'The original protected prompt.',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        },
      },
      hasPaidOrders: true,
    }} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^save changes/i })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-gen-sold-1', expect.objectContaining({ method: 'PUT' }));
    });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
    const updateCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/posts/post-gen-sold-1');
    const payload = JSON.parse(String((updateCall?.[1] as { body: string }).body));
    expect(payload).toMatchObject({ title: 'A sold generated post', visibility: 'public' });
    expect(payload.resourceBundle).toMatchObject({ accessMode: 'paid', priceUsdCents: 900, resources: { allowRemix: false } });
    expect(payload).not.toHaveProperty('mediaItems');
  });

  // The recipe manager for an in-app creation post must prefill from the
  // server-rendered payload the way the mobile composer does: prompt and
  // reference-media cards from the stored bundle, proof media from the post's
  // own media items. Every in-app post is generation-backed, so this is the
  // main manage-unlock path.
  function createGenerationRecipePost(): EditablePostDraft {
    return {
      id: 'post-gen-recipe-1',
      generationId: 'gen-7',
      title: 'Untitled post',
      rawTitle: '',
      description: '',
      prompt: 'venom hero shot',
      body: '',
      visibility: 'public',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'magicbooklet',
      sourceTool: 'magicbooklet',
      sourceToolSlug: 'magicbooklet',
      sourceTools: [{ toolLabel: 'magicbooklet', toolSlug: 'magicbooklet' }],
      mediaUrl: 'https://proxy.example.com/generated_images/user-1/gen-7.png',
      mediaKind: 'image',
      mediaItems: [{
        id: 'post-gen-recipe-1:cover',
        mediaKey: 'm0',
        url: 'https://proxy.example.com/generated_images/user-1/gen-7.png',
        mediaKind: 'image',
        contentType: null,
        originalName: null,
      } as never],
      archivedAt: null,
      resourceBundle: {
        accessMode: 'free',
        resources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: true,
          sections: [{
            id: 'recipe-section',
            title: 'Exact prompt',
            kind: 'global',
            description: null,
            sortOrder: 0,
          }],
          items: [
            {
              id: 'recipe-prompt',
              scope: { kind: 'all' },
              type: 'prompt',
              role: 'primary',
              sectionId: 'recipe-section',
              title: 'Prompt',
              description: null,
              textContent: 'venom hero shot, cinematic sparks',
              externalUrl: null,
              storagePath: null,
              contentType: null,
              sizeBytes: null,
              workflowSnapshot: null,
              sortOrder: 0,
              isPrimary: true,
              remixUse: 'text_template',
            },
            // The owner detail merges the generation's reference media in
            // server-side (sectionId: null, storagePath only — no URL).
            {
              id: 'gen-input-1',
              scope: { kind: 'all' },
              type: 'reference_image',
              role: 'style_reference',
              sectionId: null,
              title: 'Reference image 1',
              description: null,
              textContent: null,
              externalUrl: null,
              storagePath: 'generation_inputs/user-1/gen-7/00-reference_image.jpg',
              contentType: null,
              sizeBytes: null,
              workflowSnapshot: null,
              sortOrder: 1,
              isPrimary: false,
              remixUse: 'none',
            },
          ],
        },
      },
      hasPaidOrders: false,
    };
  }

  it('prefills recipe cards and proof media for a generation-backed post', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [{
          id: 'gen-7',
          output_url: 'https://proxy.example.com/generated_images/user-1/gen-7.png',
          category: 'image',
          title: 'Venom hero',
          description: '',
          prompt: 'venom hero shot',
          model: 'nano-banana-2',
        }],
      }),
    });

    render(<NewPostClient initialPost={createGenerationRecipePost()} />);

    expect(screen.getByText('Exact prompt')).toBeInTheDocument();
    expect(screen.getByText('Reference image 1')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByRole('img').length).toBeGreaterThan(0);
    });
    // The display fallback for an empty title must never hydrate the editor —
    // saving would echo it into a stored title the placeholder gate rejects.
    expect(screen.queryByDisplayValue('Untitled post')).not.toBeInTheDocument();
  });

  it('seeds the recipe from the generation when managing an empty package', async () => {
    searchParamsState.value = new URLSearchParams('resourceMode=paid&focus=price&from=creations');
    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [{
          id: 'gen-7',
          output_url: 'https://proxy.example.com/generated_images/user-1/gen-7.png',
          category: 'image',
          title: 'Venom hero',
          description: '',
          prompt: 'venom hero shot',
          model: 'nano-banana-2',
          paywallPrefill: {
            resourceKinds: ['prompt'],
            promptText: 'venom hero shot, cinematic sparks',
            notesMarkdown: null,
            allowRemix: false,
            referenceCount: 0,
            referenceKindCounts: {},
          },
        }],
      }),
    });

    const post = createGenerationRecipePost();
    post.resourceBundle = { accessMode: 'none' };

    render(<NewPostClient initialPost={post} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /edit exact generation prompt/i })).toBeInTheDocument();
    });
  });

  // A free recipe hands its prompt to anyone with one tap, so an untitled creation's post
  // opened with one starts from the prompt's opening; only a paid one swaps it (owner, 2026-10-29).
  it('starts an untitled creation’s post with a free recipe from the prompt’s title', async () => {
    searchParamsState.value = new URLSearchParams('generationId=gen-free&resourceMode=free');
    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [{
          id: 'gen-free',
          output_url: 'https://proxy.example.com/generated_images/user-1/gen-free.png',
          category: 'image',
          title: '',
          description: '',
          prompt: 'A product still lit like a window display, soft morning light, 85mm',
          model: 'nano-banana-2',
          paywallPrefill: null,
        }],
      }),
    });

    render(<NewPostClient />);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Product still lit like a window display');
    });
  });

  // S1 (2026-10-27): a creation post's recipe includes its Remix, so there is
  // no switch for it. An edit sends back the value the recipe was loaded with.
  it('says Remix comes with a creation post’s recipe and sends back the remix value it was loaded with', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [{
          id: 'gen-7',
          output_url: 'https://proxy.example.com/generated_images/user-1/gen-7.png',
          category: 'image',
          title: 'Venom hero',
          description: '',
          prompt: 'venom hero shot',
          model: 'nano-banana-2',
        }],
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({ success: true, postId: 'post-gen-recipe-1', visibility: 'public' }),
    });

    render(<NewPostClient initialPost={createGenerationRecipePost()} />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/generations'))).toBe(true));

    expect(screen.getByText('Remix comes with this recipe: people who unlock it can remix your post.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /remix/i })).not.toBeInTheDocument();
    // No stored preview: the suggestion reads the items.
    expect(screen.getByLabelText(/recipe preview, required/i)).toHaveValue('Includes the prompt and reference media.');

    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-gen-recipe-1', expect.objectContaining({ method: 'PUT' })));
    const updateCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/posts/post-gen-recipe-1');
    const payload = JSON.parse(String((updateCall?.[1] as { body: string }).body));
    expect(payload.resourceBundle).toMatchObject({
      accessMode: 'free',
      summary: 'Includes the prompt and reference media.',
      previewText: 'Includes the prompt and reference media.',
      resources: { allowRemix: true },
    });
  });

  it('keeps the server-provided draft when the generations fetch fails', async () => {
    enqueueResponse({
      ok: false,
      status: 500,
      json: async () => ({ error: 'generations unavailable' }),
    });

    render(<NewPostClient initialPost={createGenerationRecipePost()} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/generations'),
        expect.anything(),
      );
    });

    // The stored bundle and the post's own media are server truths; a failed
    // enhancement fetch must not blank them.
    expect(screen.getByText('Exact prompt')).toBeInTheDocument();
    expect(screen.getByText('Reference image 1')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByRole('img').length).toBeGreaterThan(0);
    });
  });

  it('keeps an untouched legacy private resource label out of the public title', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-private-resource-title',
        visibility: 'private',
      }),
    });
    render(<NewPostClient initialPost={createLegacyPrivateResourcePost()} />);

    expect(screen.getByText('Secret client launch prompt')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const payload = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));
    expect(payload.resourceBundle.resources.sections[0]).not.toHaveProperty('publicTitle');
  });

  it('publishes a legacy resource title only after the creator edits its public field', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-private-resource-title',
        visibility: 'private',
      }),
    });
    render(<NewPostClient initialPost={createLegacyPrivateResourcePost()} />);

    fireEvent.click(screen.getByRole('button', { name: /edit secret client launch prompt/i }));
    expect(screen.getByText(/older private label stays hidden/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/item title, required/i), {
      target: { value: 'Reusable launch prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const payload = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));
    expect(payload.resourceBundle.resources.sections[0]).toMatchObject({
      title: 'Secret client launch prompt',
      publicTitle: 'Reusable launch prompt',
    });
  });

  // S6: a recipe saved with a separate summary opens with the one preview
  // starting from that summary (what buyers saw first), and the save sends
  // the preview as both.
  it('starts the one Recipe preview from a stored summary and sends it as the preview', async () => {
    const initialPost = createLegacyPrivateResourcePost();
    initialPost.resourceBundle = {
      ...initialPost.resourceBundle,
      summary: 'A short public summary retained from the existing listing.',
      previewText: 'A separate detailed preview retained with the package.',
    };
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: initialPost.id,
        visibility: 'private',
      }),
    });

    render(<NewPostClient initialPost={initialPost} />);

    expect(screen.queryByLabelText(/summary/i)).not.toBeInTheDocument();
    const preview = screen.getByLabelText(/recipe preview, required/i);
    expect(preview).toHaveValue('A short public summary retained from the existing listing.');

    fireEvent.change(preview, {
      target: { value: 'An updated recipe preview that replaces the old summary.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const payload = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));
    expect(payload.resourceBundle).toMatchObject({
      summary: 'An updated recipe preview that replaces the old summary.',
      previewText: 'An updated recipe preview that replaces the old summary.',
    });
  });

  // The listing rule (18 characters, no stand-in words) speaks under the one
  // field it reads, in the app's words.
  it('puts listing-quality feedback under the Recipe preview', async () => {
    const initialPost = createLegacyPrivateResourcePost();
    initialPost.resourceBundle = {
      ...initialPost.resourceBundle,
      summary: 'test',
      previewText: 'A useful detailed preview that would otherwise pass listing quality.',
    };

    render(<NewPostClient initialPost={initialPost} />);
    const preview = screen.getByLabelText(/recipe preview, required/i);
    expect(preview).toHaveValue('test');
    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

    await waitFor(() => expect(preview).toHaveAttribute('aria-invalid', 'true'));
    expect(preview).toHaveAccessibleDescription(expect.stringContaining(
      'Write a recipe preview of at least 18 characters that says what people get.',
    ));
    expect(screen.getByRole('alert')).toHaveTextContent('Write a recipe preview of at least 18 characters that says what people get.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the resource opener after closing the dialog', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    const opener = screen.getByRole('button', { name: /add your first item/i });
    opener.focus();

    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /close item editor/i }));
    expect(opener).toHaveFocus();
  });

  it('limits the general resource picker to server-supported file types', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/source assets/i);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('.workflow');
    expect(input.accept).toContain('.pdf');
    expect(input.accept).toContain('application/x-yaml');
    expect(input.accept).not.toContain('*/*');
  });

  // S1: Remix is no item of its own any more; a recipe needs at least one.
  // A stored recipe that only granted remix is asked for an item (or No
  // recipe) when it is saved, and nothing is sent until then.
  it('asks a recipe that only granted remix for an item before it is saved', async () => {
    render(<NewPostClient initialPost={{
      id: 'post-remix-only',
      generationId: null,
      title: 'A remix grant with a real title',
      description: '',
      prompt: '',
      body: '',
      visibility: 'public',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'external',
      sourceTool: 'Pika Labs',
      sourceToolSlug: 'pika-labs',
      sourceTools: [{ toolLabel: 'Pika Labs', toolSlug: 'pika-labs' }],
      mediaUrl: '/proof.png',
      mediaKind: 'image',
      archivedAt: null,
      resourceBundle: {
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: 'Remix this creation directly after unlocking it.',
        resources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: true,
        },
      },
      hasPaidOrders: true,
      resourceBundleBuyerCount: 2,
    }} />);

    expect(screen.getByText('Add at least one item.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Add at least one item to the recipe.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flags but does not block a grandfathered over-limit title loaded into the editor', async () => {
    const grandfatheredTitle = 'g'.repeat(TITLE_MAX_LENGTH + 9);
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-grandfathered-1',
        showcasePath: '/showcase/post-grandfathered-1',
        resourceBundlePath: null,
        visibility: 'private',
        resourceBundleStatus: null,
      }),
    });

    render(<NewPostClient initialPost={{
      id: 'post-grandfathered-1',
      generationId: null,
      title: grandfatheredTitle,
      description: '',
      prompt: '',
      body: '',
      visibility: 'private',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'external',
      sourceTool: 'Pika Labs',
      sourceToolSlug: 'pika-labs',
      sourceTools: [{ toolLabel: 'Pika Labs', toolSlug: 'pika-labs' }],
      mediaUrl: '/proof.png',
      mediaKind: 'image',
      archivedAt: null,
      resourceBundle: { accessMode: 'none' },
      hasPaidOrders: false,
    }} />);

    expect(screen.getByText(`${TITLE_MAX_LENGTH + 9}/${TITLE_MAX_LENGTH}`)).toHaveClass('text-rose-300');

    fireEvent.click(screen.getAllByRole('button', { name: /save/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('blocks publishing an untitled post and never reaches the API', async () => {
    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A note that is long enough to publish on its own.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/add a title for your post/i);
    // Only the source-tools bootstrap fetch — the post itself never went out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks the title required and drops the old optional placeholder', () => {
    render(<NewPostClient />);

    const titleInput = screen.getByRole('textbox', { name: /^title/i });
    expect(titleInput).toHaveAttribute('aria-required', 'true');
    expect(titleInput).toHaveAttribute('placeholder', 'What is this creation about?');
    expect(screen.queryByPlaceholderText(/title \(optional\)/i)).not.toBeInTheDocument();

    // The publish checklist has to agree, or the composer reads "ready" while
    // the publish button refuses.
    expect(screen.getByText('Title added')).toBeInTheDocument();
  });

  it('keeps the minimal composer chrome quiet and focused', () => {
    render(<NewPostClient />);

    expect(screen.queryByText(/community post composer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/one post, one optional recipe/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /browse recipes/i })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: /^media$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^text$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add media/i })).toBeInTheDocument();

    const checklist = screen.getByLabelText(/publish checklist/i);
    expect(checklist).toHaveTextContent(/media added/i);
    expect(checklist).toHaveTextContent(/story optional/i);
    expect(checklist).toHaveTextContent(/recipe optional/i);
  });

  it('shows section-local validation feedback near the failing composer section', () => {
    render(<NewPostClient />);

    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/upload an image or video/i);
    expect(alert.closest('[data-composer-section]')).toHaveAttribute('data-composer-section', 'post');
  });

  it('offers profile repair without losing the current composer after a readiness error', async () => {
    enqueueResponse({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
        field: 'profile',
        actionHref: '/profile',
        actionLabel: 'Complete profile and return',
      }),
    });

    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })],
      },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/custom handle/i);
    expect(alert.closest('[data-composer-section]')).toHaveAttribute('data-composer-section', 'publish');
    const repairLink = screen.getByRole('link', { name: /complete profile in a new tab/i });
    expect(repairLink).toHaveAttribute('href', '/profile?source=post-composer');
    expect(repairLink).toHaveAttribute('target', '_blank');
  });

  it('renders searchable Made With comboboxes fetched from the API', async () => {
    render(<NewPostClient />);
    openMadeWith();

    expect(screen.getByText(/made with/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add another tool/i })).toBeInTheDocument();
    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    expect(toolPicker).toHaveAttribute('aria-autocomplete', 'list');

    fireEvent.focus(toolPicker);
    expect(await screen.findByRole('option', { name: 'Higgsfield' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /model for tool 1/i })).toBeDisabled();
  });

  it('keeps historical tools out of the default list but finds them by alias', async () => {
    render(<NewPostClient />);
    openMadeWith();

    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.focus(toolPicker);

    expect(screen.queryByRole('option', { name: 'Sora' })).not.toBeInTheDocument();

    fireEvent.change(toolPicker, { target: { value: 'OpenAI video' } });

    expect(await screen.findByRole('option', { name: 'Sora' })).toBeInTheDocument();
  });

  it('creates provisional tools and models from the searchable Made With comboboxes', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-provisional-tool-1',
        showcasePath: '/showcase/post-provisional-tool-1',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    const { container } = render(<NewPostClient />);
    openMadeWith();
    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });

    fireEvent.change(toolPicker, { target: { value: 'Pika Labs' } });
    fireEvent.click(await screen.findByRole('option', { name: /create “pika labs”/i }));

    const modelPicker = screen.getByRole('combobox', { name: /model for pika labs/i });
    fireEvent.change(modelPicker, { target: { value: 'Pika 2.2' } });
    fireEvent.click(await screen.findByRole('option', { name: /create “pika 2.2”/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })],
      },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const sourceTools = JSON.parse(String(request.body.get('sourceTools')));
    expect(sourceTools).toEqual([
      {
        toolLabel: 'Pika Labs',
        toolSlug: 'pika-labs',
        modelLabel: 'Pika 2.2',
        modelSlug: 'pika-2-2',
        createTool: true,
        createModel: true,
      },
    ]);
  });

  it('supports keyboard selection and Escape in the Made With combobox', async () => {
    render(<NewPostClient />);
    openMadeWith();

    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.focus(toolPicker);
    await screen.findByRole('option', { name: 'Higgsfield' });
    fireEvent.keyDown(toolPicker, { key: 'ArrowDown' });
    fireEvent.keyDown(toolPicker, { key: 'ArrowDown' });
    fireEvent.keyDown(toolPicker, { key: 'Enter' });

    expect(toolPicker).toHaveValue('Higgsfield');

    fireEvent.focus(toolPicker);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(toolPicker, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows source catalog validation errors inside the Made With section', async () => {
    enqueueResponse({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'You reached the source tool creation limit of 10 per 24 hours.',
        field: 'sourceTools',
      }),
    });

    const { container } = render(<NewPostClient />);
    openMadeWith();
    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.change(toolPicker, { target: { value: 'Pika Labs' } });
    fireEvent.click(await screen.findByRole('option', { name: /create “pika labs”/i }));

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })],
      },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/creation limit/i);
    expect(alert.closest('[data-composer-section]')).toHaveAttribute('data-composer-section', 'post');
  });

  it('serializes selected Made With tools with display labels and model labels', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-made-with-1',
        showcasePath: '/showcase/post-made-with-1',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    const { container } = render(<NewPostClient />);
    openMadeWith();

    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.focus(toolPicker);
    fireEvent.click(await screen.findByRole('option', { name: 'Higgsfield' }));
    const modelPicker = screen.getByRole('combobox', { name: /model for higgsfield/i });
    fireEvent.focus(modelPicker);
    fireEvent.click(await screen.findByRole('option', { name: 'Soul' }));

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })],
      },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const sourceTools = JSON.parse(String(request.body.get('sourceTools')));

    expect(sourceTools).toEqual([
      {
        toolLabel: 'Higgsfield',
        toolSlug: 'higgsfield',
        modelLabel: 'Soul',
        modelSlug: 'soul',
      },
    ]);
  });

  it('keeps existing custom Made With metadata local unless Create is selected', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-custom-tool-1',
        showcasePath: '/showcase/post-custom-tool-1',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    render(<NewPostClient initialPost={{
      id: 'post-custom-tool-1',
      generationId: null,
      title: 'Custom metadata',
      description: '',
      prompt: '',
      body: '',
      visibility: 'private',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'external',
      sourceTool: 'Pika Labs',
      sourceToolSlug: 'pika-labs',
      sourceTools: [{
        toolLabel: 'Pika Labs',
        toolSlug: 'pika-labs',
        modelLabel: 'Pika 2.2',
        modelSlug: 'pika-2-2',
      }],
      mediaUrl: '/proof.png',
      mediaKind: 'image',
      archivedAt: null,
      resourceBundle: { accessMode: 'none' },
      hasPaidOrders: false,
    }} />);
    openMadeWith();

    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.change(toolPicker, { target: { value: 'Pika Studio' } });
    fireEvent.blur(toolPicker);

    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /^publish publicly/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: string };
    const sourceTools = JSON.parse(request.body).sourceTools;

    expect(sourceTools).toEqual([
      {
        toolLabel: 'Pika Studio',
        toolSlug: 'pika-studio',
        modelLabel: 'Pika 2.2',
        modelSlug: 'pika-2-2',
      },
    ]);
  });

  it('reveals only the selected resource sections and submits a resource bundle', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-1',
        showcasePath: '/showcase/post-1',
        resourceBundlePath: '/showcase/post-1#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'Lead with a concrete before-and-after in the first line.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));

    // A package is a list of cards now: pick a type, fill it, save it.
    expect(screen.getByText(/what people receive/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), {
      target: { value: 'Hook prompt' },
    });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'Use a before\/after hook and keep the CTA visible in frame.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The exact hook prompt behind this post.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    // Legacy flat fields stay null under the card model; the content lives in
    // structured items, and the card title becomes the public section title.
    expect(resourceBundle).toMatchObject({
      accessMode: 'free',
      previewText: 'The exact hook prompt behind this post.',
      resources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
    });
    expect(resourceBundle.resources.sections).toMatchObject([
      { title: 'Hook prompt', publicTitle: 'Hook prompt', resourceType: 'prompt', kind: 'global' },
    ]);
    expect(resourceBundle.resources.items).toMatchObject([
      {
        type: 'prompt',
        textContent: 'Use a before/after hook and keep the CTA visible in frame.',
        remixUse: 'text_template',
        scope: { kind: 'all' },
      },
    ]);
    expect(await screen.findByRole('link', { name: /open recipe section/i })).toHaveAttribute(
      'href',
      '/showcase/post-1#recipe'
    );
  });

  it('keeps visibility choices available for paid unlock drafts and serializes structured links', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-2',
        showcasePath: null,
        ownerPath: '/post/post-2/edit',
        resourceBundlePath: '/post/post-2/edit#recipe',
        visibility: 'private',
        resourceBundleStatus: 'draft',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'Keep the hook direct and make the benefit visible instantly.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));

    expect(screen.queryByText(/public post required/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    chooseItemType(/external link/i);
    fireEvent.change(screen.getByLabelText(/item title, required/i), {
      target: { value: 'Prompt doc' },
    });
    fireEvent.change(screen.getByLabelText(/^link$/i), {
      target: { value: 'https://ugc.example.com/doc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'A linked prompt document you can reuse.' },
    });
    // Prices are entered in tokens now, and price_usd_cents stores the token
    // count directly, so 1200 tokens is what the payload should carry.
    fireEvent.change(screen.getByRole('spinbutton', { name: /price in credits/i }), {
      target: { value: '1200' },
    });
    // What buyers pay and the creator's 85% of it, in money (A-F5).
    expect(screen.getByText('Buyers pay $12.00 · You earn ~$10.20 (85%) · Payouts from $100')).toBeInTheDocument();
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(String(request.body.get('visibility'))).toBe('private');
    // Links are structured items on a card now, not loose attachment rows.
    expect(resourceBundle).toMatchObject({
      accessMode: 'paid',
      priceUsdCents: 1200,
      resources: { attachments: [] },
    });
    expect(resourceBundle.resources.items).toMatchObject([
      {
        type: 'external_link',
        title: 'Prompt doc',
        externalUrl: 'https://ugc.example.com/doc',
      },
    ]);
    expect(await screen.findByRole('link', { name: /continue editing/i })).toHaveAttribute(
      'href',
      '/post/post-2/edit'
    );
  });

  // Each card becomes one section, and the card title is what a buyer sees on
  // the locked package. Multiple cards therefore carry their own scope.
  it('serializes every card as its own publicly titled section', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-sectioned-1',
        showcasePath: '/showcase/post-sectioned-1',
        resourceBundlePath: '/showcase/post-sectioned-1#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A compact breakdown for a multi-part creative.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));

    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Hook' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'Open with the before state, then reveal the product.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.click(screen.getByRole('button', { name: /^add item$/i }));
    fireEvent.click(screen.getByRole('button', { name: /guide or notes/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Timing' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'Keep this first section under seven seconds.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The hook prompt plus the timing notes behind it.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(resourceBundle.resources.sections).toMatchObject([
      { title: 'Hook', publicTitle: 'Hook', resourceType: 'prompt', kind: 'global', sortOrder: 0 },
      { title: 'Timing', publicTitle: 'Timing', resourceType: 'note', kind: 'global', sortOrder: 1 },
    ]);
    const [promptSection, noteSection] = resourceBundle.resources.sections;
    expect(resourceBundle.resources.items).toMatchObject([
      {
        type: 'prompt',
        title: 'Hook',
        textContent: 'Open with the before state, then reveal the product.',
        sectionId: promptSection.id,
        isPrimary: true,
      },
      {
        type: 'note',
        title: 'Timing',
        textContent: 'Keep this first section under seven seconds.',
        sectionId: noteSection.id,
        isPrimary: false,
      },
    ]);
  });

  it('uploads media to Supabase before posting ordered metadata to the API', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-3',
        showcasePath: '/showcase/post-3',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })],
      },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const mediaItems = JSON.parse(String(request.body.get('mediaItems')));

    expect(mediaItems).toEqual([
      expect.objectContaining({
        storagePath: expect.stringMatching(/^uploads\/user-1\/.+\.png$/),
        originalName: 'proof.png',
        contentType: 'image/png',
      }),
    ]);
    expect(request.body.get('media')).toBeNull();
  });

  // A scope has to name the key the media is actually stored under. Positional
  // keys only happened to match on create, and never matched in edit mode.
  it('scopes resources to the media key it submits, not a positional one', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-scoped-1',
        showcasePath: '/showcase/post-scoped-1',
        resourceBundlePath: '/showcase/post-scoped-1#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    const readCards = renderComposerWithTwoImages();
    expect(readCards()).toHaveLength(2);

    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Second shot prompt' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'The prompt that produced the second image only.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply to media 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The prompt behind the second output.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const mediaItems = JSON.parse(String(request.body.get('mediaItems')));
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    // Every submitted item names its own key, and they are distinct.
    const submittedKeys = mediaItems.map((item: { mediaKey: string }) => item.mediaKey);
    expect(submittedKeys).toHaveLength(2);
    submittedKeys.forEach((key: string) => expect(key).toMatch(/^media-[0-9a-f-]{36}$/));
    expect(new Set(submittedKeys).size).toBe(2);

    // The scope points at the second output's real key, not 'media-2'.
    expect(resourceBundle.resources.items[0].scope).toEqual({
      kind: 'media',
      mediaKeys: [submittedKeys[1]],
    });
    expect(resourceBundle.resources.sections[0].scope).toEqual({
      kind: 'media',
      mediaKeys: [submittedKeys[1]],
    });
  });

  // The server assigns a UUID to media added during an edit when the client
  // sends no key, which orphaned any scope pointing at that new output.
  it('keeps a scope attached to media added while editing a post', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-edit-scope',
        visibility: 'public',
      }),
    });

    const { container } = render(<NewPostClient initialPost={{
      id: 'post-edit-scope',
      generationId: null,
      title: 'An existing post with a real title',
      description: '',
      prompt: '',
      body: '',
      visibility: 'public',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'external',
      sourceTool: 'Pika Labs',
      sourceToolSlug: 'pika-labs',
      sourceTools: [{ toolLabel: 'Pika Labs', toolSlug: 'pika-labs' }],
      mediaUrl: '/proof.png',
      mediaKind: 'image',
      mediaItems: [{
        id: 'existing-media-1',
        mediaKey: 'proof-a',
        url: '/proof.png',
        mediaKind: 'image',
        contentType: 'image/png',
        originalName: 'proof.png',
        width: null,
        height: null,
        durationSeconds: null,
        sortOrder: 0,
      }],
      archivedAt: null,
      resourceBundle: { accessMode: 'none' },
      hasPaidOrders: false,
    }} />);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] },
      });
    });

    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'New shot prompt' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'The prompt behind the image added during this edit.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply to media 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The prompt behind the newly added output.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const payload = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));

    // Existing media sends no key -- the server derives the stored one, and a
    // key it disagrees with is rejected outright.
    expect(payload.mediaItems[0]).toEqual({ existingId: 'existing-media-1' });

    const addedKey = payload.mediaItems[1].mediaKey;
    expect(addedKey).toMatch(/^media-[0-9a-f-]{36}$/);
    expect(payload.resourceBundle.resources.items[0].scope).toEqual({
      kind: 'media',
      mediaKeys: [addedKey],
    });
  });

  // A scope left pointing at removed media fails server validation on publish,
  // and with one output left the scope picker is gone, so it cannot be cleared.
  it('drops a scope key when its media is removed', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-scope-cleanup',
        showcasePath: '/showcase/post-scope-cleanup',
        resourceBundlePath: '/showcase/post-scope-cleanup#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    const readCards = renderComposerWithTwoImages();

    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Second shot prompt' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'The prompt that produced the second image only.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply to media 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    expect(screen.getByText(/1 selected output/i)).toBeInTheDocument();

    // Remove the output that resource was scoped to.
    fireEvent.click(screen.getByRole('button', { name: /remove media 2/i }));
    expect(readCards()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The prompt behind this output.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const mediaItems = JSON.parse(String(request.body.get('mediaItems')));
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(mediaItems).toHaveLength(1);
    expect(resourceBundle.resources.items[0].scope).toEqual({ kind: 'all' });
    expect(resourceBundle.resources.sections[0].scope).toEqual({ kind: 'all' });
  });

  it('clears every resource scope when switching from media proof to text', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-text-scope-cleanup',
        showcasePath: '/showcase/post-text-scope-cleanup',
        resourceBundlePath: '/showcase/post-text-scope-cleanup#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    renderComposerWithTwoImages();
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Second shot prompt' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'The prompt that originally applied to the second output.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply to media 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    expect(screen.getByText(/1 selected output/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    expect(screen.queryByLabelText('Post media order')).not.toBeInTheDocument();
    expect(screen.queryByText(/selected output/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A useful text proof with enough detail for the community to learn from.' },
    });

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The reusable prompt supporting this written breakdown.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));
    expect(request.body.get('mediaItems')).toBeNull();
    expect(resourceBundle.resources.items[0].scope).toEqual({ kind: 'all' });
    expect(resourceBundle.resources.sections[0].scope).toEqual({ kind: 'all' });
  });

  it('asks for confirmation before removing a resource card', () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Keepable prompt' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'A resource that should not disappear on the first click.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));

    fireEvent.click(screen.getByRole('button', { name: /remove keepable prompt/i }));
    expect(screen.getByText('Keepable prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^keep$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.queryByText('Keepable prompt')).not.toBeInTheDocument();
  });

  // H2: removing the last item used to switch the recipe to No recipe by
  // itself (and an edit's save then deleted it). The recipe stays chosen and
  // Publish asks for an item instead, as the app does.
  it('keeps the recipe chosen when its last item goes, and asks for an item at Publish', async () => {
    render(<NewPostClient />);
    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A note that stands on its own for the community.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'A reusable prompt for the hook.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove prompt or script/i }));
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

    expect(screen.getByRole('radio', { name: /paid recipe/i })).toBeChecked();
    expect(screen.getByRole('button', { name: /add your first item/i })).toBeInTheDocument();
    expect(screen.getByText('Add at least one item.')).toBeInTheDocument();
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Add at least one item to the recipe.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Every post now needs a title, so tests that submit have to name the post
  // before clicking through. Tests asserting the title rule itself skip this.
  // Deliberately not "test"/"sample"/"draft": those are placeholder tokens that
  // getPublicPostQualityError rejects, which would block publishing here for a
  // reason that has nothing to do with what each test is asserting.
  // Made with is folded into one row until it is opened.
  function openMadeWith() {
    fireEvent.click(screen.getByRole('button', { name: /^made with/i }));
  }

  function fillRequiredTitle(value = 'Neon skyline color study') {
    fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), { target: { value } });
  }

  // S8: five of the nine item types wait behind "More types" in the picker.
  function chooseItemType(name: RegExp) {
    const picker = within(screen.getByRole('dialog'));
    const more = picker.getByRole('button', { name: 'More types' });
    if (more.getAttribute('aria-expanded') === 'false' && !picker.queryByRole('button', { name })) {
      fireEvent.click(more);
    }
    fireEvent.click(picker.getByRole('button', { name }));
  }

  function renderComposerWithTwoImages() {
    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['cover'], 'cover.png', { type: 'image/png' }),
          new File(['second'], 'second.png', { type: 'image/png' }),
        ],
      },
    });
    // The strip also holds the "Add media" tile, which is not a reorderable card.
    return () =>
      (Array.from(screen.getByLabelText('Post media order').children) as HTMLElement[]).filter(
        (node) => node.getAttribute('aria-label') !== 'Add more media'
      );
  }

  function pickUpCard(card: HTMLElement, clientX: number) {
    // jsdom has no pointer capture; the component only calls it when available.
    card.setPointerCapture = vi.fn();
    card.hasPointerCapture = vi.fn(() => false);
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, pointerType: 'mouse', clientX, clientY: 0 });
  }

  it('uploads media as soon as it is added and does not upload it again on publish', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-eager-1',
        showcasePath: '/showcase/post-eager-1',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(['cover'], 'cover.png', { type: 'image/png' }),
            new File(['clip'], 'clip.mp4', { type: 'video/mp4' }),
          ],
        },
      });
    });

    // Both files went up on selection, before publish was ever pressed.
    expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2 of 5 media added')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), {
      target: { value: 'Eagerly uploaded post' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    // Still 2: publish skipped both because they already carry a storagePath.
    expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
  });

  it('publish waits for every in-flight add batch, not just the newest one', async () => {
    // Two separate adds create two concurrent upload batches. Tracking only the
    // latest batch let publish proceed while the older one was still uploading,
    // and it re-uploaded that batch's files.
    let releaseSlow: (() => void) | null = null;
    temporaryUploadMock.mockImplementation(async (file: File) => {
      if (file.name === 'slow.png' && !releaseSlow) {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return {
        signedUrl: `https://storage.example.test/signed/${file.name}`,
        storagePath: `uploads/user-1/${file.name}`,
      };
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-two-batches',
        showcasePath: '/showcase/post-two-batches',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    // Batch A hangs mid-transfer; batch B lands instantly.
    fireEvent.change(fileInput, {
      target: { files: [new File(['a'], 'slow.png', { type: 'image/png' })] },
    });
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['b'], 'fast.png', { type: 'image/png' })] },
      });
    });

    fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), {
      target: { value: 'Two batches' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    // Publish is parked on batch A — nothing may dispatch yet.
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseSlow?.();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Each file went up exactly once; publish reused both staged paths.
    const uploadsOf = (name: string) => temporaryUploadMock.mock.calls
      .filter((call) => (call[0] as File).name === name).length;
    expect(uploadsOf('slow.png')).toBe(1);
    expect(uploadsOf('fast.png')).toBe(1);
    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const mediaItems = JSON.parse(String(request.body.get('mediaItems')));
    expect(mediaItems).toEqual([
      expect.objectContaining({ storagePath: 'uploads/user-1/slow.png' }),
      expect.objectContaining({ storagePath: 'uploads/user-1/fast.png' }),
    ]);
  });

  it('uploads each added file exactly once under React Strict Mode', async () => {
    // Strict Mode double-invokes state updaters in dev. Collecting the accepted
    // files via a side effect inside the updater made every add upload each
    // file twice, staging an orphaned duplicate object per file.
    const { StrictMode } = await import('react');
    const { container } = render(
      <StrictMode>
        <NewPostClient />
      </StrictMode>
    );
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(['cover'], 'cover.png', { type: 'image/png' }),
            new File(['clip'], 'clip.mp4', { type: 'video/mp4' }),
          ],
        },
      });
    });

    expect(screen.getByText('2 of 5 media added')).toBeInTheDocument();
    expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
  });

  it('shows a progress bar while added media uploads', async () => {
    let releaseUpload: (() => void) | null = null;
    temporaryUploadMock.mockImplementation(async (file: File) => {
      await new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      return {
        signedUrl: `https://storage.example.test/signed/${file.name}`,
        storagePath: `uploads/user-1/${file.name}`,
      };
    });

    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['cover'], 'cover.png', { type: 'image/png' })] },
    });

    // The bar is on screen while the transfer is still open.
    const bar = await screen.findByRole('progressbar', { name: /media upload progress/i });
    expect(bar).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();

    await act(async () => {
      releaseUpload?.();
    });

    await waitFor(() => {
      expect(screen.queryByRole('progressbar', { name: /media upload progress/i })).not.toBeInTheDocument();
    });
  });

  it('lifts a card on pick-up and moves it with the pointer', () => {
    const getCards = renderComposerWithTwoImages();
    const cards = getCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].className).toContain('cursor-grab');

    pickUpCard(cards[0], 0);
    expect(getCards()[0].className).toContain('scale-[1.04]');

    fireEvent.pointerMove(cards[0], { pointerId: 1, clientX: 60, clientY: 0 });
    expect(cards[0].style.transform).toBe('translateX(60px)');

    // Released short of a full slot: it settles back, order untouched.
    fireEvent.pointerUp(cards[0], { pointerId: 1, clientX: 60, clientY: 0 });
    expect(cards[0].style.transform).toBe('');
    expect(getCards()[0].className).not.toContain('scale-[1.04]');
    expect(getCards()[0].querySelector('img')?.getAttribute('alt')).toBe('Media 1');
  });

  it('reorders when a card is carried a full slot', () => {
    const getCards = renderComposerWithTwoImages();
    const second = getCards()[1];
    expect(second.querySelector('img')?.getAttribute('alt')).toBe('Media 2');

    pickUpCard(second, 300);
    // One slot is 124px; drag left past it.
    fireEvent.pointerMove(second, { pointerId: 1, clientX: 160, clientY: 0 });
    fireEvent.pointerUp(second, { pointerId: 1, clientX: 160, clientY: 0 });

    // That card now holds the cover slot, and no phantom media was added.
    const after = getCards();
    expect(after[0].textContent).toContain('Cover');
    expect(after[0].querySelector('img')?.getAttribute('alt')).toBe('Media 1');
    expect(screen.getByText('2 of 5 media added')).toBeInTheDocument();
  });

  it('does not pick a card up when the press lands on its buttons', () => {
    const getCards = renderComposerWithTwoImages();
    const removeButton = screen.getByRole('button', { name: /remove media 1/i });

    fireEvent.pointerDown(removeButton, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 });
    expect(getCards()[0].className).not.toContain('scale-[1.04]');

    fireEvent.click(removeButton);
    expect(screen.getByText('1 of 5 media added')).toBeInTheDocument();
  });

  it('uploads and preserves the order of multiple image and video files', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-gallery-1',
        showcasePath: '/showcase/post-gallery-1',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['cover'], 'cover.png', { type: 'image/png' }),
          new File(['clip'], 'clip.mp4', { type: 'video/mp4' }),
        ],
      },
    });

    // findByText: appending is async now — the composer reads video metadata
    // (duration gate) before accepting files.
    expect(await screen.findByText('2 of 5 media added')).toBeInTheDocument();
    expect(screen.getByLabelText('Post media order')).toBeInTheDocument();

    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const mediaItems = JSON.parse(String(request.body.get('mediaItems')));
    expect(mediaItems).toEqual([
      expect.objectContaining({ originalName: 'cover.png', contentType: 'image/png' }),
      expect.objectContaining({ originalName: 'clip.mp4', contentType: 'video/mp4' }),
    ]);
  });

  it('refuses a picked video measured over the limit before uploading it', async () => {
    // Since 2026-10-31 a .mov is measured on Chrome too (the reader skipped every one before),
    // so an iPhone clip over the limit is refused at the pick, as an MP4 always was.
    readVideoDurationMock.mockResolvedValueOnce(601);
    const { container } = render(<NewPostClient />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clip = new File(['clip'], 'long-take.mov', { type: 'video/quicktime' });

    fireEvent.change(fileInput, { target: { files: [clip] } });

    expect(await screen.findByText('Videos must be 10 minutes or shorter.')).toBeInTheDocument();
    expect(readVideoDurationMock.mock.calls.at(-1)?.[0]).toBe(clip);
    expect(temporaryUploadMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/media added/)).toBeNull();
  });

  it('prefills generated paid unlocks and focuses the price field', async () => {
    searchParamsState.value = new URLSearchParams({
      generationId: 'gen-paid-1',
      publishIntent: 'paid-generation',
      resourceMode: 'paid',
      focus: 'price',
    });

    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [
          {
            id: 'gen-paid-1',
            output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
            category: 'image',
            model: 'nano-banana-2',
            title: 'Launch still',
            description: 'A polished creator-style launch image.',
            prompt: 'A creator-style product image with warm natural light.',
            paywallPrefill: {
              resourceKinds: ['prompt', 'notes', 'remix'],
              promptText: 'A creator-style product image with warm natural light.',
              notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0',
              allowRemix: true,
            },
          },
        ],
      }),
    });
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-paywall-1',
        showcasePath: '/showcase/post-paywall-1',
        resourceBundlePath: '/showcase/post-paywall-1#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient />);

    // The prefill lands as items in the list, not as loose textareas; the
    // prompt is the same item "Include exact prompt" makes.
    expect(await screen.findByText('Exact generation prompt')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/generations?includeArchived=true&id=gen-paid-1&limit=1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(screen.getByText(/saved prompt, reusable setup notes, and remix access are ready/i)).toBeInTheDocument();
    // The saved generation seeds items rather than loose fields. Remix comes
    // with the recipe (S1): there is no switch, and a new recipe sends false.
    expect(screen.queryByRole('checkbox', { name: /remix/i })).not.toBeInTheDocument();
    expect(screen.getByText('Remix comes with this recipe: people who unlock it can remix your post.')).toBeInTheDocument();
    expect(screen.getByText('Guide or notes')).toBeInTheDocument();
    expect(screen.getByLabelText(/recipe preview, required/i)).toHaveValue('Includes the prompt and a written guide.');

    const priceInput = screen.getByRole('spinbutton', { name: /price in credits/i });
    await waitFor(() => {
      expect(priceInput).toHaveFocus();
    });

    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'The saved prompt and setup behind this image.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const request = fetchMock.mock.calls[2][1] as { body: string };
    const payload = JSON.parse(request.body);

    expect(payload).toMatchObject({
      generationId: 'gen-paid-1',
      visibility: 'public',
      resourceBundle: {
        accessMode: 'paid',
        priceUsdCents: 900,
        resources: { allowRemix: false },
      },
    });
    expect(payload.resourceBundle.resources.items).toMatchObject([
      { type: 'prompt', title: 'Exact generation prompt', textContent: 'A creator-style product image with warm natural light.' },
      { type: 'note', textContent: 'Saved generation setup\nModel: Nano Banana 2.0' },
    ]);
  });

  it('falls back to the manual paid composer when a generation has no usable prefill', async () => {
    searchParamsState.value = new URLSearchParams({
      generationId: 'gen-paid-empty',
      publishIntent: 'paid-generation',
      resourceMode: 'paid',
    });

    enqueueResponse({
      ok: true,
      json: async () => ({
        generations: [
          {
            id: 'gen-paid-empty',
            output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
            category: 'image',
            model: 'nano-banana-2',
            title: 'Launch still',
            description: 'A polished creator-style launch image.',
            prompt: 'A polished creator-style launch image.',
            paywallPrefill: null,
          },
        ],
      }),
    });

    render(<NewPostClient />);

    expect(await screen.findByText(/does not have enough saved inputs to auto-fill a paid recipe yet/i)).toBeInTheDocument();
    // Nothing to seed, so the package starts empty rather than half-filled.
    expect(screen.getByRole('button', { name: /add your first item/i })).toBeInTheDocument();
  });

  it('opens the edit flow from creations in resource mode and focuses the price field', async () => {
    searchParamsState.value = new URLSearchParams({
      resourceMode: 'paid',
      focus: 'price',
      from: 'creations',
    });

    render(
      <NewPostClient
        initialPost={{
          id: 'post-edit-1',
          generationId: null,
          title: 'Private proof',
          description: '',
          prompt: '',
          body: 'A private proof post.',
          visibility: 'private',
          category: 'text',
          postFormat: 'text',
          sourceKind: 'manual',
          sourceTool: null,
          mediaUrl: null,
          mediaKind: null,
          archivedAt: null,
          resourceBundle: {
            accessMode: 'none',
          },
          hasPaidOrders: false,
        }}
      />
    );

    expect(screen.getByRole('heading', { name: /manage the recipe behind this post/i })).toBeInTheDocument();
    expect(screen.getAllByText(/you came from my studio/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/this recipe will save as a draft/i).length).toBeGreaterThan(0);

    const priceInput = screen.getByRole('spinbutton', { name: /price in credits/i });
    await waitFor(() => {
      expect(priceInput).toHaveFocus();
    });
    expect(priceInput).not.toBeDisabled();
  });

  // A-F17: Studio's "Add recipe" chose Paid and focused the price of a post
  // with nothing to sell yet. It now chooses nothing and focuses nothing. Recipe
  // sales' picker of posts with no recipe opens it the same way (2026-11-01).
  it.each([
    ['Studio', 'creations'],
    ['Recipe sales', 'seller'],
    ['any page', 'profile'],
  ])('opens %s’s Add a recipe with no mode chosen, no Studio note and nothing focused', async (_surface, from) => {
    searchParamsState.value = new URLSearchParams({ recipe: 'add', from });

    render(
      <NewPostClient
        initialPost={{
          id: 'post-add-recipe-1',
          generationId: null,
          title: 'Private proof',
          description: '',
          prompt: '',
          body: 'A private proof post.',
          visibility: 'private',
          category: 'text',
          postFormat: 'text',
          sourceKind: 'manual',
          sourceTool: null,
          mediaUrl: null,
          mediaKind: null,
          archivedAt: null,
          resourceBundle: { accessMode: 'none' },
          hasPaidOrders: false,
        }}
      />
    );

    expect(screen.getByRole('heading', { name: 'Add a recipe to this post' })).toBeInTheDocument();
    expect(screen.queryByText(/you came from my studio/i)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /no recipe/i })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
    const priceInput = screen.getByRole('spinbutton', { name: /price in credits/i });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(priceInput).not.toHaveFocus();
  });

  it('keeps the seller dashboard as the way back when a listing is edited from it', () => {
    // The dashboard's edit links carry from=seller and returnTo; edit mode used
    // to label that link "Back to studio" while it returned to /marketplace/sell.
    searchParamsState.value = new URLSearchParams({
      from: 'seller',
      returnTo: '/marketplace/sell',
    });

    render(
      <NewPostClient
        initialPost={{
          id: 'post-edit-seller-1',
          generationId: null,
          title: 'Listed recipe',
          description: '',
          prompt: '',
          body: 'A listed post.',
          visibility: 'public',
          category: 'text',
          postFormat: 'text',
          sourceKind: 'manual',
          sourceTool: null,
          mediaUrl: null,
          mediaKind: null,
          archivedAt: null,
          resourceBundle: {
            accessMode: 'none',
          },
          hasPaidOrders: false,
        }}
      />
    );

    const backLink = screen.getByRole('link', { name: /back to recipe sales/i });
    expect(backLink).toHaveAttribute('href', '/marketplace/sell');
    expect(screen.queryByRole('link', { name: /back to studio/i })).not.toBeInTheDocument();
  });

  it('shows only Publish public and Save private buttons for new posts without an Unlisted option', () => {
    render(<NewPostClient />);

    expect(screen.getAllByRole('button', { name: /publish public/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /save private/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: /^unlisted$/i })).not.toBeInTheDocument();
  });

  it('sends visibility private when Save private is clicked', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-private-1',
        showcasePath: null,
        ownerPath: '/post/post-private-1/edit',
        resourceBundlePath: null,
        visibility: 'private',
        resourceBundleStatus: null,
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A private draft note.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    expect(String(request.body.get('visibility'))).toBe('private');
  });

  it('sends visibility public when Publish public is clicked', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-public-1',
        showcasePath: '/showcase/post-public-1',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A public note for the community.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    expect(String(request.body.get('visibility'))).toBe('public');
  });

  it('does not block Save private with public marketplace quality checks', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-private-paid-1',
        showcasePath: null,
        ownerPath: '/post/post-private-paid-1/edit',
        resourceBundlePath: '/post/post-private-paid-1/edit#recipe',
        visibility: 'private',
        resourceBundleStatus: 'draft',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
    fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'Setup' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'Use a simple private-only setup.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
      target: { value: 'A private-only setup you can reuse later.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    expect(String(request.body.get('visibility'))).toBe('private');
  });

  // A post is public or private since 2026-10-17 (decision 12): one saved as
  // unlisted before then opens as the private post the server stores it as.
  it('publishes a paid post saved as unlisted with Publish public', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        success: true,
        postId: 'post-unlisted-paid-1',
        showcasePath: '/showcase/post-unlisted-paid-1',
        resourceBundlePath: '/showcase/post-unlisted-paid-1#recipe',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(
      <NewPostClient
        initialPost={{
          id: 'post-unlisted-paid-1',
          generationId: null,
          title: 'A proper post title for quality check',
          description: 'Good description',
          prompt: '',
          body: 'This is sufficient body content for a quality check to pass.',
          visibility: 'unlisted',
          category: 'text',
          postFormat: 'text',
          sourceKind: 'manual',
          sourceTool: null,
          mediaUrl: null,
          mediaKind: null,
          archivedAt: null,
          resourceBundle: {
            accessMode: 'paid',
            priceUsdCents: 900,
            previewText: 'A detailed prompt you can reuse on your own posts.',
            resources: {
              promptText: 'A detailed prompt that passes quality checks easily.',
              notesMarkdown: null,
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            },
          },
          hasPaidOrders: false,
        }}
      />
    );

    expect(screen.queryByRole('button', { name: /make public/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^publish publicly/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[1][1].body).toContain('"visibility":"public"');
  });

  const postSavedAsUnlisted = {
    id: 'post-unlisted-1',
    generationId: null,
    title: 'Link post',
    description: '',
    prompt: '',
    body: 'A post from before the change.',
    visibility: 'unlisted' as const,
    category: 'text' as const,
    postFormat: 'text' as const,
    sourceKind: 'manual' as const,
    sourceTool: null,
    mediaUrl: null,
    mediaKind: null,
    archivedAt: null,
    resourceBundle: { accessMode: 'none' as const },
    hasPaidOrders: false,
  };

  it('opens a post saved as unlisted as private, with Public and Private only', () => {
    render(<NewPostClient initialPost={postSavedAsUnlisted} />);

    expect(screen.getByRole('heading', { name: /update post/i })).toBeInTheDocument();
    // It is private now: Save changes keeps it so, Publish publicly makes it public.
    expect(screen.getAllByRole('button', { name: /^save changes/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /^publish publicly/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: /unlisted/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /make public|make private/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/unlisted|shareable by link/i)).not.toBeInTheDocument();
    expect(screen.getByText('Saved privately in Studio')).toBeInTheDocument();
  });

  it('saves a post saved as unlisted as private', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-unlisted-1',
        showcasePath: null,
        ownerPath: '/post/post-unlisted-1/edit',
        resourceBundlePath: null,
        visibility: 'private',
        resourceBundleStatus: null,
      }),
    });

    render(<NewPostClient initialPost={postSavedAsUnlisted} />);

    fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const call = fetchMock.mock.calls[1];
    const body = JSON.parse(call[1].body);
    expect(body.visibility).toBe('private');
  });

  describe('media upload progress', () => {
    function attachFile(container: HTMLElement, file: File) {
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, { target: { files: [file] } });
    }

    it('reports real byte progress while the upload is in flight', async () => {
      // The file uploads on add and publish waits for it, so this bar is the
      // only feedback while the user is waiting on bytes.
      let reportProgress: ((progress: { bytesSent: number; totalBytes: number; fraction: number }) => void) | null = null;
      let finishUpload: ((value: { signedUrl: string; storagePath: string }) => void) | null = null;

      temporaryUploadMock.mockImplementation(async (
        file: File,
        options?: { onProgress?: (progress: { bytesSent: number; totalBytes: number; fraction: number }) => void },
      ) => {
        reportProgress = options?.onProgress ?? null;
        return new Promise((resolve) => {
          finishUpload = () => resolve({
            signedUrl: `https://storage.example.test/signed/${file.name}`,
            storagePath: `uploads/user-1/${file.name}`,
          });
        });
      });

      enqueueResponse({
        ok: true,
        json: async () => ({
          postId: 'post-progress',
          showcasePath: '/showcase/post-progress',
          resourceBundlePath: null,
          visibility: 'public',
          resourceBundleStatus: null,
        }),
      });

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['png-bytes'], 'proof.png', { type: 'image/png' }));
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      const progressBar = await screen.findByRole('progressbar', { name: /media upload progress/i });
      expect(progressBar).toHaveAttribute('aria-valuenow', '0');

      await act(async () => {
        reportProgress?.({ bytesSent: 30, totalBytes: 100, fraction: 0.3 });
      });
      await waitFor(() => {
        expect(screen.getByRole('progressbar', { name: /media upload progress/i }))
          .toHaveAttribute('aria-valuenow', '30');
      });

      await act(async () => {
        finishUpload?.({ signedUrl: 'x', storagePath: 'uploads/user-1/proof.png' });
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('lets the user cancel an add-time upload and keeps the file in the composer', async () => {
      temporaryUploadMock.mockImplementation(async (
        _file: File,
        options?: { signal?: AbortSignal },
      ) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const cancelled = new Error('Upload cancelled.');
          cancelled.name = 'UploadCancelledError';
          reject(cancelled);
        });
      }));

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['png-bytes'], 'proof.png', { type: 'image/png' }));

      // The bar belongs to the add now — no publish click is needed to see it.
      await screen.findByRole('progressbar', { name: /media upload progress/i });
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      await waitFor(() => {
        expect(screen.queryByRole('progressbar', { name: /media upload progress/i })).not.toBeInTheDocument();
      });
      // Cancelling the transfer must not drop the media or publish anything.
      expect(screen.getByText('1 of 5 media added')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries only the files that failed, keeping already-staged uploads', async () => {
      // Throwing away successes made a retry re-upload every file: duplicate
      // staged objects, wasted bandwidth, and sign rate limit burned for files
      // that were already up.
      let brokenShouldFail = true;
      temporaryUploadMock.mockImplementation(async (file: File) => {
        if (file.name === 'broken.png' && brokenShouldFail) {
          throw new Error('Storage rejected the upload.');
        }
        return {
          signedUrl: `https://storage.example.test/signed/${file.name}`,
          storagePath: `uploads/user-1/${file.name}`,
        };
      });

      const { container } = render(<NewPostClient />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(['ok'], 'good.png', { type: 'image/png' }),
            new File(['bad'], 'broken.png', { type: 'image/png' }),
          ],
        },
      });

      // Both went up on add; only broken.png failed, and it is reported there.
      await waitFor(() => {
        expect(screen.getByText(/1 of 2 uploads failed/i)).toBeInTheDocument();
      });
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);

      brokenShouldFail = false;
      enqueueResponse({
        ok: true,
        json: async () => ({
          postId: 'post-retry',
          showcasePath: '/showcase/post-retry',
          resourceBundlePath: null,
          visibility: 'public',
          resourceBundleStatus: null,
        }),
      });

      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // good.png was staged on add and never touched again; only broken.png
      // was retried. Counting per file is what actually pins that down.
      const uploadsOf = (name: string) => temporaryUploadMock.mock.calls
        .filter((call) => (call[0] as File).name === name).length;
      expect(uploadsOf('good.png')).toBe(1);
      expect(uploadsOf('broken.png')).toBe(2);
      const request = fetchMock.mock.calls[1][1] as { body: FormData };
      const mediaItems = JSON.parse(String(request.body.get('mediaItems')));
      expect(mediaItems).toEqual([
        expect.objectContaining({ storagePath: 'uploads/user-1/good.png', originalName: 'good.png' }),
        expect.objectContaining({ storagePath: 'uploads/user-1/broken.png', originalName: 'broken.png' }),
      ]);
    });

    it('re-uploads after a 5xx, because the server may have consumed the staged media', async () => {
      // A 5xx can come after the server moved the staged file into the post and
      // deleted it. Reusing that path would fail every retry, with no way out
      // but removing and re-adding the file.
      enqueueResponse({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Failed to create post.' }),
      });

      const { container } = render(<NewPostClient />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, {
        target: { files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })] },
      });

      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => {
        expect(screen.getByText(/failed to create post/i)).toBeInTheDocument();
      });
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);

      enqueueResponse({
        ok: true,
        json: async () => ({
          postId: 'post-recovered',
          showcasePath: '/showcase/post-recovered',
          resourceBundlePath: null,
          visibility: 'public',
          resourceBundleStatus: null,
        }),
      });

      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      // Re-staged rather than reusing the path the server just deleted.
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    });

    function enqueuePublished(postId: string) {
      enqueueResponse({
        ok: true,
        json: async () => ({
          postId,
          showcasePath: `/showcase/${postId}`,
          resourceBundlePath: null,
          visibility: 'public',
          resourceBundleStatus: null,
        }),
      });
    }

    it('keeps staged uploads after a 4xx refusal, so the fixed retry does not upload again', async () => {
      // Title, quality, safety and profile refusals come before the server
      // touches a staged file. Forgetting the paths there made a one-word title
      // fix cost a full re-upload of every file.
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Use a specific title instead of a placeholder.' }),
      });

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['png-bytes'], 'proof.png', { type: 'image/png' }));
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => {
        expect(screen.getByText(/specific title instead of a placeholder/i)).toBeInTheDocument();
      });

      enqueuePublished('post-after-400');
      fillRequiredTitle('A specific title for the retry');
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      const retry = fetchMock.mock.calls[2][1] as { body: FormData };
      expect(JSON.parse(String(retry.body.get('mediaItems')))).toEqual([
        expect.objectContaining({ storagePath: 'uploads/user-1/proof.png' }),
      ]);
    });

    it('re-uploads after the Made With refusal, which the server raises after consuming the files', async () => {
      // The catalog is checked only once the staged files are in the post, and
      // the post is then deleted, so those paths are gone.
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'You reached the source tool creation limit of 10 per 24 hours.',
          field: 'sourceTools',
        }),
      });

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['png-bytes'], 'proof.png', { type: 'image/png' }));
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => {
        expect(screen.getByText(/creation limit/i)).toBeInTheDocument();
      });

      enqueuePublished('post-after-catalog-refusal');
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    });

    it('re-uploads new media after an edit save fails with a 5xx', async () => {
      // The edit route consumes staged files the same way, and kept every path
      // after any failure, so one 5xx stranded the retry.
      enqueueResponse({ ok: false, status: 500, json: async () => ({ error: 'Failed to update post.' }) });

      const { container } = render(<NewPostClient initialPost={{
        id: 'post-edit-retry',
        generationId: null,
        title: 'An existing post with a real title',
        description: '',
        prompt: '',
        body: '',
        visibility: 'public',
        category: 'image',
        postFormat: 'media',
        sourceKind: 'external',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      }} />);
      attachFile(container, new File(['png-bytes'], 'added.png', { type: 'image/png' }));
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      await waitFor(() => {
        expect(screen.getByText(/failed to update post/i)).toBeInTheDocument();
      });

      // The retry reads the post's media back first: this save wrote none.
      enqueueResponse({ ok: true, json: async () => ({ success: true, post: { mediaItems: [] } }) });
      enqueueResponse({ ok: true, json: async () => ({ success: true, postId: 'post-edit-retry', visibility: 'public' }) });
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    });

    // An edit is refused over Made With only after the post and its media are
    // saved, so the picture is in the post under its key: uploading it again
    // under that key is refused.
    it('names media a failed edit save already wrote instead of uploading it again', async () => {
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'You reached the source tool creation limit of 10 per 24 hours.',
          field: 'sourceTools',
        }),
      });

      const { container } = render(<NewPostClient initialPost={{
        id: 'post-edit-written',
        generationId: null,
        title: 'An existing post with a real title',
        description: '',
        prompt: '',
        body: '',
        visibility: 'public',
        category: 'image',
        postFormat: 'media',
        sourceKind: 'external',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      }} />);
      attachFile(container, new File(['png-bytes'], 'added.png', { type: 'image/png' }));
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      expect(await screen.findByText(/creation limit/i)).toBeInTheDocument();

      const firstSave = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));
      const addedKey = firstSave.mediaItems[0].mediaKey as string;
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, post: { mediaItems: [{ id: 'row-written', mediaKey: addedKey }] } }),
      });
      enqueueResponse({ ok: true, json: async () => ({ success: true, postId: 'post-edit-written', visibility: 'public' }) });
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

      const retry = JSON.parse(String((fetchMock.mock.calls[3][1] as { body: string }).body));
      expect(retry.mediaItems).toEqual([{ existingId: 'row-written' }]);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
    });

    function rejectWhenAborted(signal: AbortSignal | undefined) {
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const cancelled = new Error('Upload cancelled.');
          cancelled.name = 'UploadCancelledError';
          reject(cancelled);
        });
      });
    }

    /** kept.png lands at once; hanging.png uploads until something aborts it. */
    function mockOneHangingUpload(signals: Map<string, AbortSignal>) {
      temporaryUploadMock.mockImplementation(async (
        file: File,
        options?: { signal?: AbortSignal },
      ) => {
        if (options?.signal) signals.set(file.name, options.signal);
        if (file.name === 'hanging.png') {
          return rejectWhenAborted(options?.signal);
        }
        return {
          signedUrl: `https://storage.example.test/signed/${file.name}`,
          storagePath: `uploads/user-1/${file.name}`,
        };
      });
    }

    function attachKeptAndHanging(container: HTMLElement) {
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(['kept'], 'kept.png', { type: 'image/png' }),
            new File(['hanging'], 'hanging.png', { type: 'image/png' }),
          ],
        },
      });
    }

    it('stops a removed file\'s upload, drops it from the bar, and publishes without it', async () => {
      const signals = new Map<string, AbortSignal>();
      mockOneHangingUpload(signals);
      enqueuePublished('post-without-removed');

      const { container } = render(<NewPostClient />);
      attachKeptAndHanging(container);
      expect(await screen.findByText(/uploading 1 of 2/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /remove media 2/i }));

      // Only the removed file stops, and the bar no longer waits on its bytes.
      expect(signals.get('hanging.png')?.aborted).toBe(true);
      expect(signals.get('kept.png')?.aborted).toBe(false);
      await waitFor(() => {
        expect(screen.queryByRole('progressbar', { name: /media upload progress/i })).not.toBeInTheDocument();
      });

      // The removed upload never finishes on its own: had publish waited on it,
      // nothing would be posted.
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const request = fetchMock.mock.calls[1][1] as { body: FormData };
      expect(JSON.parse(String(request.body.get('mediaItems')))).toEqual([
        expect.objectContaining({ storagePath: 'uploads/user-1/kept.png' }),
      ]);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    });

    it('leaves out a file removed while publish is waiting on its upload', async () => {
      const signals = new Map<string, AbortSignal>();
      mockOneHangingUpload(signals);
      enqueuePublished('post-removed-mid-publish');

      const { container } = render(<NewPostClient />);
      attachKeptAndHanging(container);
      await screen.findByText(/uploading 1 of 2/i);

      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await act(async () => {});
      // Parked on hanging.png.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: /remove media 2/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // Publish held the list as it was when clicked; the removed file is
      // neither uploaded again nor posted.
      const request = fetchMock.mock.calls[1][1] as { body: FormData };
      expect(JSON.parse(String(request.body.get('mediaItems')))).toEqual([
        expect.objectContaining({ storagePath: 'uploads/user-1/kept.png' }),
      ]);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
    });

    it('stops every upload when the post switches to text', async () => {
      const signals: AbortSignal[] = [];
      temporaryUploadMock.mockImplementation(async (
        _file: File,
        options?: { signal?: AbortSignal },
      ) => {
        if (options?.signal) signals.push(options.signal);
        return rejectWhenAborted(options?.signal);
      });

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['a'], 'first.png', { type: 'image/png' }));
      attachFile(container, new File(['b'], 'second.png', { type: 'image/png' }));
      await waitFor(() => expect(signals).toHaveLength(2));

      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));

      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('still cancels every file at once, and keeps them all', async () => {
      const signals: AbortSignal[] = [];
      temporaryUploadMock.mockImplementation(async (
        _file: File,
        options?: { signal?: AbortSignal },
      ) => {
        if (options?.signal) signals.push(options.signal);
        return rejectWhenAborted(options?.signal);
      });

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['a'], 'first.png', { type: 'image/png' }));
      attachFile(container, new File(['b'], 'second.png', { type: 'image/png' }));
      await waitFor(() => expect(signals).toHaveLength(2));

      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await waitFor(() => {
        expect(screen.queryByRole('progressbar', { name: /media upload progress/i })).not.toBeInTheDocument();
      });
      expect(screen.getByText('2 of 5 media added')).toBeInTheDocument();
    });

    it('gives the reason an added file failed instead of promising a retry', async () => {
      // A file the server refuses outright fails the same way at publish.
      temporaryUploadMock.mockImplementation(async () => {
        throw new Error('Image uploads must be 25MB or smaller.');
      });

      const { container } = render(<NewPostClient />);
      attachFile(container, new File(['big'], 'huge.png', { type: 'image/png' }));

      expect(await screen.findByText(
        '1 of 1 uploads failed (huge.png). Image uploads must be 25MB or smaller.',
      )).toBeInTheDocument();
      expect(screen.queryByText(/retried when you publish/i)).not.toBeInTheDocument();
    });

    it('names the files that failed instead of discarding the whole batch', async () => {
      // The old Promise.all rejected everything on the first failure, throwing
      // away uploads that had already succeeded and stranding their objects.
      temporaryUploadMock.mockImplementation(async (file: File) => {
        if (file.name === 'broken.png') {
          throw new Error('Storage rejected the upload.');
        }
        return {
          signedUrl: `https://storage.example.test/signed/${file.name}`,
          storagePath: `uploads/user-1/${file.name}`,
        };
      });

      const { container } = render(<NewPostClient />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(['ok'], 'good.png', { type: 'image/png' }),
            new File(['bad'], 'broken.png', { type: 'image/png' }),
          ],
        },
      });

      // Reported at the point of adding, without waiting for a publish attempt,
      // and the surviving upload is kept rather than the batch being discarded.
      await waitFor(() => {
        expect(screen.getByText(/1 of 2 uploads failed/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/broken\.png/i)).toBeInTheDocument();
      expect(screen.getByText('2 of 5 media added')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('leave guard', () => {
    /** Whether the browser would ask before a reload or a closed tab. */
    function leaveWouldPrompt() {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }

    function createSavedPost(): EditablePostDraft {
      return {
        id: 'post-guarded',
        generationId: null,
        title: 'A saved post with a real title',
        description: '',
        prompt: '',
        body: 'The saved caption.',
        visibility: 'public',
        category: 'image',
        postFormat: 'mixed',
        sourceKind: 'external',
        sourceTool: 'Pika Labs',
        sourceToolSlug: 'pika-labs',
        sourceTools: [{ toolLabel: 'Pika Labs', toolSlug: 'pika-labs' }],
        mediaUrl: '/proof.png',
        mediaKind: 'image',
        mediaItems: [{
          id: 'existing-media-1',
          mediaKey: 'proof-a',
          url: '/proof.png',
          mediaKind: 'image',
          contentType: 'image/png',
          originalName: 'proof.png',
          width: null,
          height: null,
          durationSeconds: null,
          sortOrder: 0,
        }],
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      };
    }

    it('guards a story typed before any title, and lets go once it is cleared', () => {
      render(<NewPostClient />);
      expect(leaveWouldPrompt()).toBe(false);

      const caption = screen.getByRole('textbox', { name: /^story/i });
      fireEvent.change(caption, { target: { value: 'A tip typed before its title.' } });
      expect(leaveWouldPrompt()).toBe(true);

      fireEvent.change(caption, { target: { value: '' } });
      expect(leaveWouldPrompt()).toBe(false);
    });

    it('treats any changed field of an existing post as unsaved, and an undone one as saved', () => {
      render(<NewPostClient initialPost={createSavedPost()} />);
      // Opening a post is not an edit.
      expect(leaveWouldPrompt()).toBe(false);

      const nsfw = screen.getByRole('checkbox', { name: /mark as nsfw/i });
      fireEvent.click(nsfw);
      expect(leaveWouldPrompt()).toBe(true);
      fireEvent.click(nsfw);
      expect(leaveWouldPrompt()).toBe(false);

      const caption = screen.getByRole('textbox', { name: /^story/i });
      fireEvent.change(caption, { target: { value: 'An edited caption.' } });
      expect(leaveWouldPrompt()).toBe(true);
      fireEvent.change(caption, { target: { value: 'The saved caption.' } });
      expect(leaveWouldPrompt()).toBe(false);

      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(leaveWouldPrompt()).toBe(true);
    });

    it('does not count what a linked creation fills in as unsaved work', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-guard-1' });
      enqueueResponse({
        ok: true,
        json: async () => ({
          generations: [{
            id: 'gen-guard-1',
            output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
            category: 'image',
            model: 'nano-banana-2',
            title: 'The creation title',
            description: 'The creation description.',
            prompt: 'A still life in morning light.',
            paywallPrefill: null,
          }],
        }),
      });

      render(<NewPostClient />);
      const titleInput = screen.getByRole('textbox', { name: /^title/i });
      await waitFor(() => expect(titleInput).toHaveValue('The creation title'));
      // Its Made with takes the creation's model a render later, and the guard
      // listens only from an effect: flush both before asking.
      await waitFor(() => expect(screen.getByRole('button', { name: /^made with/i })).toHaveTextContent('Nano Banana 2.0'));
      await act(async () => {});
      expect(leaveWouldPrompt()).toBe(false);

      fireEvent.change(titleInput, { target: { value: 'A title of my own' } });
      expect(leaveWouldPrompt()).toBe(true);
    });

    it('lets go once an edit is saved', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-guarded', visibility: 'public' }),
      });

      render(<NewPostClient initialPost={createSavedPost()} />);
      fireEvent.change(screen.getByRole('textbox', { name: /^story/i }), {
        target: { value: 'An edited caption.' },
      });
      expect(leaveWouldPrompt()).toBe(true);

      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
      expect(leaveWouldPrompt()).toBe(false);
    });

    it('asks before the Back link leaves unsaved changes, and only then', async () => {
      const linkRouter = {
        push: vi.fn(),
        replace: vi.fn(),
        prefetch: vi.fn(async () => undefined),
      };
      render(
        <RouterContext.Provider value={linkRouter as unknown as NextRouter}>
          <NewPostClient />
          <FeedbackViewport />
        </RouterContext.Provider>
      );
      const back = screen.getByRole('link', { name: /back to explore/i });

      // Nothing typed: the link just goes.
      fireEvent.click(back);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(linkRouter.push).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByRole('textbox', { name: /^story/i }), {
        target: { value: 'Words not yet published.' },
      });
      fireEvent.click(back);
      const question = await screen.findByRole('alertdialog', { name: 'Leave this post?' });
      expect(question).toHaveAccessibleDescription('Your changes haven’t been saved and will be lost.');
      expect(linkRouter.push).toHaveBeenCalledTimes(1);

      fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(mockPush).not.toHaveBeenCalled();

      // The click was held for the answer, so "leave" goes by the router.
      fireEvent.click(back);
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave without saving' }));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/showcase'));
      expect(linkRouter.push).toHaveBeenCalledTimes(1);
    });

    // Decision D4 (2026-10-24): the shell's links, outside the composer, ask too.
    it('asks before a link elsewhere on the page leaves unsaved changes', async () => {
      render(
        <>
          <a href="/home">Home</a>
          <NewPostClient />
          <FeedbackViewport />
        </>
      );
      fireEvent.change(screen.getByRole('textbox', { name: /^story/i }), {
        target: { value: 'Words not yet published.' },
      });

      fireEvent.click(screen.getByRole('link', { name: 'Home' }));
      const question = await screen.findByRole('alertdialog', { name: 'Leave this post?' });
      expect(mockPush).not.toHaveBeenCalled();

      fireEvent.click(within(question).getByRole('button', { name: 'Leave without saving' }));
      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/home'));
    });

    it('puts a guard entry on the browser history only while there is unsaved work', () => {
      render(<NewPostClient />);
      expect(window.history.state?.postComposerLeaveGuard).toBeUndefined();

      const story = screen.getByRole('textbox', { name: /^story/i });
      fireEvent.change(story, { target: { value: 'Words not yet published.' } });
      expect(window.history.state?.postComposerLeaveGuard).toBeTruthy();
    });
  });

  // The app's step 1 order and names (decision D1, 2026-10-24).
  describe('the app’s order and names', () => {
    function expectInOrder(elements: HTMLElement[]) {
      elements.slice(1).forEach((element, index) => {
        expect(
          elements[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
          `${elements[index].textContent || elements[index].getAttribute('aria-label')} comes before ${element.textContent || element.getAttribute('aria-label')}`,
        ).toBeTruthy();
      });
    }

    it('puts media first, then the title, Made with, the story, NSFW, the recipe and publishing', () => {
      render(<NewPostClient />);

      expectInOrder([
        screen.getByRole('heading', { name: /^media$/i }),
        screen.getByRole('button', { name: /^media$/i }),
        screen.getByRole('textbox', { name: /^title/i }),
        screen.getByRole('button', { name: /^made with/i }),
        screen.getByRole('textbox', { name: /^story/i }),
        screen.getByRole('checkbox', { name: /mark as nsfw/i }),
        screen.getByRole('heading', { name: /^recipe$/i }),
        screen.getByRole('heading', { name: /^publish$/i }),
      ]);
      expect(screen.queryByRole('heading', { name: /proof/i })).not.toBeInTheDocument();
    });

    it('asks what the creation is about, and names the text Story or Post text', () => {
      render(<NewPostClient />);

      expect(screen.getByRole('textbox', { name: /^title/i })).toHaveAttribute('placeholder', 'What is this creation about?');
      expect(screen.getByRole('textbox', { name: /^story, optional/i })).toHaveAttribute(
        'placeholder',
        'Share the idea, process, or story behind it…',
      );
      expect(screen.queryByRole('textbox', { name: /caption/i })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
      expect(screen.getByRole('textbox', { name: /^post text, required/i })).toHaveAttribute(
        'placeholder',
        'Share a prompt, idea, breakdown, or useful note…',
      );
      const titleInput = screen.getByRole('textbox', { name: /^title/i });
      expect(
        titleInput.compareDocumentPosition(screen.getByRole('textbox', { name: /^post text/i })) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^made with/i })).not.toBeInTheDocument();
    });

    it('folds Made with into one row that sums it up', async () => {
      render(<NewPostClient />);

      const madeWith = screen.getByRole('button', { name: /^made with/i });
      expect(madeWith).toHaveAttribute('aria-expanded', 'false');
      expect(madeWith).toHaveTextContent(/add tool and model/i);
      expect(screen.queryByRole('combobox', { name: 'Tool 1' })).not.toBeInTheDocument();

      fireEvent.click(madeWith);
      expect(madeWith).toHaveAttribute('aria-expanded', 'true');
      const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
      fireEvent.focus(toolPicker);
      fireEvent.click(await screen.findByRole('option', { name: 'Higgsfield' }));
      const modelPicker = screen.getByRole('combobox', { name: /model for higgsfield/i });
      fireEvent.focus(modelPicker);
      fireEvent.click(await screen.findByRole('option', { name: 'Soul' }));

      fireEvent.click(madeWith);
      expect(screen.queryByRole('combobox', { name: 'Tool 1' })).not.toBeInTheDocument();
      expect(madeWith).toHaveTextContent('Higgsfield · Soul');
    });

    // A creation's Made with is locked to the row publishing stores: the app,
    // then the creation's model by the name its post prints, or none where
    // that name is missing. The row was seeded with the app alone and never
    // took the model, so it read "magicbooklet" until the post was edited.
    it('sums up a creation’s Made with as the row its post stores', async () => {
      searchParamsState.value = new URLSearchParams('generationId=gen-made-with');
      enqueueResponse({
        ok: true,
        json: async () => ({
          generations: [{
            id: 'gen-made-with',
            output_url: 'https://proxy.example.com/generated_images/user-1/gen-made-with.png',
            category: 'image',
            title: 'Neon still life',
            prompt: 'neon still life, soft rim light',
            model: 'nano-banana-pro',
          }],
        }),
      });
      render(<NewPostClient />);

      await waitFor(() => (
        expect(screen.getByRole('button', { name: /^made with/i })).toHaveTextContent('magicbooklet · Nano Banana Pro')
      ));
    });

    // /api/generations names a template result's model `template-workflow`:
    // its real one is the template author's.
    it('names no model in a template result’s Made with', async () => {
      searchParamsState.value = new URLSearchParams('generationId=gen-template-result');
      enqueueResponse({
        ok: true,
        json: async () => ({
          generations: [{
            id: 'gen-template-result',
            output_url: 'https://proxy.example.com/generated_images/user-1/gen-template-result.png',
            category: 'image',
            title: 'Rider transformation',
            model: 'template-workflow',
            origin: 'template',
          }],
        }),
      });
      render(<NewPostClient />);

      await waitFor(() => expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Rider transformation'));
      const madeWith = screen.getByRole('button', { name: /^made with/i });
      expect(madeWith).toHaveTextContent('magicbooklet');
      expect(madeWith).not.toHaveTextContent('·');
      expect(madeWith).not.toHaveTextContent('template-workflow');
    });

    it('opens Made with when the server refuses a tool in it', async () => {
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'You reached the source tool creation limit of 10 per 24 hours.',
          field: 'sourceTools',
        }),
      });

      const { container } = render(<NewPostClient />);
      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: { files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })] },
      });
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      expect(await screen.findByRole('alert')).toHaveTextContent(/creation limit/i);
      expect(screen.getByRole('button', { name: /^made with/i })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('combobox', { name: 'Tool 1' })).toBeInTheDocument();
    });

    it('lists media in the checklist, and a text post’s text once it meets the public rule', () => {
      render(<NewPostClient />);
      const checklist = screen.getByLabelText(/publish checklist/i);
      expect(checklist).toHaveTextContent(/media added/i);
      expect(checklist).not.toHaveTextContent(/proof/i);

      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
      const isTicked = () => Boolean(
        within(checklist).getByText(/^post text added$/i).parentElement?.parentElement?.querySelector('.lucide-check'),
      );
      const text = screen.getByRole('textbox', { name: /^post text/i });
      // getPublicPostQualityError asks a post without media for 18 characters.
      fireEvent.change(text, { target: { value: 'Seventeen letters' } });
      expect(isTicked()).toBe(false);
      fireEvent.change(text, { target: { value: 'Eighteen letters!!' } });
      expect(isTicked()).toBe(true);
    });
  });

  // A template run's Publish to Explore and Publish & share open the composer
  // for the result, as the app's do (owner, 2026-10-31).
  describe('a template run’s result', () => {
    const RUN_RESULT = {
      id: 'gen-run-result',
      output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
      category: 'image',
      model: 'nano-banana-2',
      title: 'Rider transformation',
      prompt: 'A rider in neon rain.',
      origin: 'template',
      paywallPrefill: null,
    };
    const PUBLISHED = {
      success: true,
      postId: 'post-run-result',
      showcasePath: '/showcase/post-run-result',
      ownerPath: '/post/post-run-result/edit',
      resourceBundlePath: null,
      visibility: 'public',
      resourceBundleStatus: null,
    };
    // The post in the composer's place, its own way back naming the run.
    const POST_FROM_RUN = '/showcase/post-run-result?returnTo=%2Ftemplate-runs%2Frun-1';
    const answerCreation = (creation: Record<string, unknown> = RUN_RESULT) => enqueueResponse({
      ok: true,
      json: async () => ({ generations: [creation] }),
    });
    const answerPublish = (visibility: 'public' | 'private') => enqueueResponse({
      ok: true,
      json: async () => ({
        ...PUBLISHED,
        visibility,
        showcasePath: visibility === 'public' ? PUBLISHED.showcasePath : null,
      }),
    });
    const openFromRun = (extra: Record<string, string> = {}) => {
      searchParamsState.value = new URLSearchParams({
        generationId: 'gen-run-result',
        from: 'template-run',
        returnTo: '/template-runs/run-1',
        ...extra,
      });
    };
    const waitForCreation = () => waitFor(() => (
      expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Rider transformation')
    ));
    const publishBody = () => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/showcase/publish');
      return call ? JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown> : null;
    };
    const toastMessages = () => readFeedbackSnapshot().toasts.map((toast) => toast.message);

    beforeEach(() => {
      resetFeedbackState();
      window.sessionStorage.clear();
    });

    it('goes back to the run it was opened from', async () => {
      openFromRun();
      answerCreation();
      render(<NewPostClient />);

      expect(screen.getByRole('link', { name: 'Back to template run' })).toHaveAttribute('href', '/template-runs/run-1');
      await waitForCreation();
    });

    // Its recipe cards are up until the creation says it is a template result,
    // whose recipe the server refuses.
    it('sends the post with no recipe, whatever was picked while the result loaded', async () => {
      let finishCreation: (value: unknown) => void = () => {};
      const creationAnswer = new Promise((resolve) => {
        finishCreation = resolve;
      });
      openFromRun();
      enqueueResponse({ ok: true, json: () => creationAnswer });
      answerPublish('public');
      render(<NewPostClient />);

      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(screen.getByRole('radio', { name: /free recipe/i })).toBeChecked();
      await act(async () => finishCreation({ generations: [RUN_RESULT] }));

      expect(await screen.findByText(/This template result shares final media only/)).toBeInTheDocument();
      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(POST_FROM_RUN));
      expect(publishBody()).toMatchObject({ generationId: 'gen-run-result', resourceBundle: { accessMode: 'none' } });
      expect(publishBody()).not.toHaveProperty('includeGenerationReferences');
    });

    it('records the post, shares its own address, and leaves for it only after the share', async () => {
      let finishShare = () => {};
      sharePublicGenerationMock.mockImplementation(() => new Promise<null>((resolve) => {
        finishShare = () => resolve(null);
      }));
      openFromRun({ shareAfterPublish: '1' });
      answerCreation();
      answerPublish('public');
      render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(sharePublicGenerationMock).toHaveBeenCalledWith({
        generationId: 'post-run-result',
        title: 'Rider transformation',
        sourceSurface: 'my-creations',
        accessToken: 'test-token',
        viewerIsOwner: true,
      }));
      // The share sheet is up: the post is already recorded, and the page does
      // not leave from under the sheet.
      expect(screen.getByText('Post published')).toBeInTheDocument();
      expect(routerMock.replace).not.toHaveBeenCalled();
      await act(async () => finishShare());
      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(POST_FROM_RUN));
      expect(mockPush).not.toHaveBeenCalled();
      expect(toastMessages()).toEqual([]);
    });

    it('says so when the link was copied for a browser with no share sheet', async () => {
      sharePublicGenerationMock.mockResolvedValue('copy-link');
      openFromRun({ shareAfterPublish: '1' });
      answerCreation();
      answerPublish('public');
      render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(POST_FROM_RUN));
      expect(toastMessages()).toEqual(['Post link copied.']);
    });

    it('leaves for the post when the share fails, says where to share it, and never calls the publish failed', async () => {
      sharePublicGenerationMock.mockRejectedValue(new Error('Clipboard sharing is not supported in this browser'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      openFromRun({ shareAfterPublish: '1' });
      answerCreation();
      answerPublish('public');
      render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(POST_FROM_RUN));
      expect(sharePublicGenerationMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(toastMessages()).toEqual(['Your post is published. Share it from its page.']);
      expect(consoleError).toHaveBeenCalledWith('Published the post, but sharing was unavailable:', expect.any(Error));
    });

    it('shares nothing for a private post, and opens its editor with the way back to the run', async () => {
      openFromRun({ shareAfterPublish: '1' });
      answerCreation();
      answerPublish('private');
      render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(
        '/post/post-run-result/edit?returnTo=%2Ftemplate-runs%2Frun-1&from=template-run',
      ));
      expect(sharePublicGenerationMock).not.toHaveBeenCalled();
    });

    it('shares nothing unless the run asked for it', async () => {
      openFromRun();
      answerCreation();
      answerPublish('public');
      render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(POST_FROM_RUN));
      expect(sharePublicGenerationMock).not.toHaveBeenCalled();
    });

    // Back and the page's own Back link stay live while the post is sent.
    it('takes nobody anywhere, and shares nothing, once they left while the post was sent', async () => {
      let finishPublish: (value: unknown) => void = () => {};
      const publishAnswer = new Promise((resolve) => {
        finishPublish = resolve;
      });
      openFromRun({ shareAfterPublish: '1' });
      answerCreation();
      enqueueResponse({ ok: true, json: () => publishAnswer });
      const view = render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/showcase/publish', expect.anything()));
      view.unmount();
      await act(async () => finishPublish(PUBLISHED));

      expect(routerMock.replace).not.toHaveBeenCalled();
      expect(sharePublicGenerationMock).not.toHaveBeenCalled();
    });

    it('opens the editor of a post the result already has, keeping the way back', async () => {
      openFromRun({ shareAfterPublish: '1' });
      answerCreation({ ...RUN_RESULT, linked_post_id: 'post-linked' });
      render(<NewPostClient />);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(
        '/post/post-linked/edit?from=template-run&returnTo=%2Ftemplate-runs%2Frun-1',
      ));
    });

    // Studio drew its copy first and would show the creation as not published.
    it('has Studio read its creations afresh once the post is out', async () => {
      window.sessionStorage.setItem(
        'magicbooklet:creations-cache:v1:user-1',
        JSON.stringify({ fetchedAt: Date.now(), generations: [], posts: [] }),
      );
      openFromRun();
      answerCreation();
      answerPublish('public');
      render(<NewPostClient />);

      await waitForCreation();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith(POST_FROM_RUN));
      expect(window.sessionStorage.getItem('magicbooklet:creations-cache:v1:user-1')).toBeNull();
    });
  });

  // Decision D2: the web's Explore description is gone, and nothing sends one.
  describe('no Explore description', () => {
    it('offers no Explore description and sends none with a new post', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({
          postId: 'post-no-description',
          showcasePath: '/showcase/post-no-description',
          resourceBundlePath: null,
          visibility: 'public',
          resourceBundleStatus: null,
        }),
      });

      render(<NewPostClient />);
      expect(screen.queryByRole('button', { name: /explore description/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/explore description/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
        target: { value: 'A note that stands on its own for the community.' },
      });
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect((fetchMock.mock.calls[1][1] as { body: FormData }).body.has('description')).toBe(false);
      // A new post takes the composer's place in history, whatever it is made of.
      await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/showcase/post-no-description?returnTo=%2Fshowcase'));
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('sends no description when publishing a creation that has one', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-described-1' });
      enqueueResponse({
        ok: true,
        json: async () => ({
          generations: [{
            id: 'gen-described-1',
            output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
            category: 'image',
            model: 'nano-banana-2',
            title: 'A described creation',
            description: 'The creation’s own description.',
            prompt: 'A still life in morning light.',
            paywallPrefill: null,
          }],
        }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-described-1',
          showcasePath: '/showcase/post-described-1',
          resourceBundlePath: null,
          visibility: 'public',
          resourceBundleStatus: null,
        }),
      });

      render(<NewPostClient />);
      await waitFor(() => expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('A described creation'));
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      const payload = JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body));
      expect(payload).toMatchObject({ generationId: 'gen-described-1', title: 'A described creation' });
      expect(payload).not.toHaveProperty('description');
    });

    it('leaves a stored description alone when an edit is saved', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-described-2', visibility: 'public' }),
      });

      render(<NewPostClient initialPost={{
        id: 'post-described-2',
        generationId: null,
        title: 'A described text post',
        description: 'A description written before the field went away.',
        prompt: '',
        body: 'A text post long enough to pass the public quality rule.',
        visibility: 'public',
        category: 'text',
        postFormat: 'text',
        sourceKind: 'manual',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      }} />);
      expect(screen.queryByDisplayValue('A description written before the field went away.')).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body))).not.toHaveProperty('description');
    });
  });

  // Decision D3: an edit saves with "Save changes" and keeps the post's
  // visibility; the other button is the one that changes it.
  describe('saving an edit keeps its visibility', () => {
    function createEditablePost(visibility: 'public' | 'private'): EditablePostDraft {
      return {
        id: `post-${visibility}-edit`,
        generationId: null,
        title: 'A text post with a real title',
        description: '',
        prompt: '',
        body: 'A text post long enough to pass the public quality rule.',
        visibility,
        category: 'text',
        postFormat: 'text',
        sourceKind: 'manual',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      };
    }

    function enqueueSaved(visibility: 'public' | 'private') {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: `post-${visibility}-edit`, visibility }),
      });
    }

    function sentVisibility() {
      return JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body)).visibility;
    }

    it('saves a public post as public, and makes it private only when asked', async () => {
      enqueueSaved('public');
      render(<NewPostClient initialPost={createEditablePost('public')} />);

      expect(screen.queryByRole('button', { name: /save private|publish public/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /^make private/i })).not.toHaveLength(0);
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(sentVisibility()).toBe('public');
    });

    it('makes a public post private with Make private', async () => {
      enqueueSaved('private');
      render(<NewPostClient initialPost={createEditablePost('public')} />);

      fireEvent.click(screen.getAllByRole('button', { name: /^make private/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(sentVisibility()).toBe('private');
      // Saved now as private, so the buttons speak from there.
      fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), { target: { value: 'A renamed text post' } });
      expect(screen.getAllByRole('button', { name: /^publish publicly/i })).not.toHaveLength(0);
      expect(screen.queryByRole('button', { name: /^make private/i })).not.toBeInTheDocument();
    });

    it('saves a private post as private, and publishes it only when asked', async () => {
      enqueueSaved('private');
      enqueueSaved('public');
      render(<NewPostClient initialPost={createEditablePost('private')} />);

      expect(screen.queryByRole('button', { name: /make private/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(sentVisibility()).toBe('private');

      fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), { target: { value: 'A renamed text post' } });
      fireEvent.click(screen.getAllByRole('button', { name: /^publish publicly/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body)).visibility).toBe('public');
    });

    // Enter in a field presses the form's default button: the first submit
    // button in document order whose form is the composer's (the phone bar
    // comes before the form). jsdom does not submit on Enter, so this reads
    // which button that is.
    it('makes Enter do nothing on a new post, and save changes on an edit', () => {
      const defaultButtonOf = (form: HTMLFormElement) => Array.from(document.querySelectorAll('button'))
        .find((button) => button.type === 'submit' && button.form === form);

      const created = render(<NewPostClient />);
      const newPostForm = document.getElementById('post-composer-form') as HTMLFormElement;
      expect(defaultButtonOf(newPostForm)?.disabled).toBe(true);
      created.unmount();

      render(<NewPostClient initialPost={createEditablePost('public')} />);
      const editForm = document.getElementById('post-composer-form') as HTMLFormElement;
      expect(defaultButtonOf(editForm)).toHaveAccessibleName(/^save changes/i);
    });

    it('says what the pressed button is doing until the save answers', async () => {
      let answer: (value: unknown) => void = () => {};
      enqueueResponse({ ok: true, json: () => new Promise((resolve) => { answer = resolve; }) });
      render(<NewPostClient initialPost={createEditablePost('private')} />);

      fireEvent.click(screen.getAllByRole('button', { name: /^publish publicly/i })[0]);
      expect(await screen.findAllByRole('button', { name: /^publishing…/i })).not.toHaveLength(0);
      expect(screen.queryByRole('button', { name: /^saving…/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /^save changes/i }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

      await act(async () => {
        answer({ success: true, postId: 'post-private-edit', visibility: 'public' });
      });
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
    });

    it('says Saving… on Save changes, and Publishing… on a new post’s Publish public', async () => {
      let answerEdit: (value: unknown) => void = () => {};
      enqueueResponse({ ok: true, json: () => new Promise((resolve) => { answerEdit = resolve; }) });
      const { unmount } = render(<NewPostClient initialPost={createEditablePost('public')} />);
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);
      expect(await screen.findAllByRole('button', { name: /^saving…/i })).not.toHaveLength(0);
      await act(async () => {
        answerEdit({ success: true, postId: 'post-public-edit', visibility: 'public' });
      });
      unmount();

      let answerNew: (value: unknown) => void = () => {};
      enqueueResponse({ ok: true, json: () => new Promise((resolve) => { answerNew = resolve; }) });
      render(<NewPostClient />);
      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
        target: { value: 'A note that stands on its own for the community.' },
      });
      fillRequiredTitle();
      fireEvent.click(screen.getAllByRole('button', { name: /^publish public/i })[0]);
      expect(await screen.findAllByRole('button', { name: /^publishing…/i })).not.toHaveLength(0);
      await act(async () => {
        answerNew({ postId: 'post-new-pending', showcasePath: '/showcase/post-new-pending', visibility: 'public' });
      });
    });
  });

  describe('the publish answer and the saved panel', () => {
    it('says the publish failed, not how its answer failed to parse, when the answer is an error page', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-error-page-1' });
      enqueueResponse({
        ok: true,
        json: async () => ({
          generations: [{
            id: 'gen-error-page-1',
            output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
            category: 'image',
            model: 'nano-banana-2',
            title: 'A creation behind a gateway',
            description: '',
            prompt: 'A still life in morning light.',
            paywallPrefill: null,
          }],
        }),
      });
      enqueueResponse({
        ok: false,
        status: 504,
        json: async () => {
          throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON');
        },
      });

      render(<NewPostClient />);
      await waitFor(() => expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('A creation behind a gateway'));
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Failed to publish post.');
      expect(alert).not.toHaveTextContent(/unexpected token|not valid json/i);
    });

    it('leaves the editor link out of the saved panel when the editor is this page', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-private-saved',
          visibility: 'private',
          showcasePath: null,
          ownerPath: '/post/post-private-saved/edit',
          resourceBundlePath: null,
          resourceBundleStatus: null,
        }),
      });

      render(<NewPostClient initialPost={{
        id: 'post-private-saved',
        generationId: null,
        title: 'A private text post',
        description: '',
        prompt: '',
        body: 'A private note kept for later.',
        visibility: 'private',
        category: 'text',
        postFormat: 'text',
        sourceKind: 'manual',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      }} />);
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /open editor|continue editing/i })).not.toBeInTheDocument();
    });
  });

  // The edit route re-inserts a post's media rows on every save that sends
  // them (replace_post_media), so the ids the page was rendered with name
  // nothing after the first save, and a picture added in that save is in the
  // post under its key: sending it again as a new upload was refused.
  describe('saving an edit more than once', () => {
    function createMediaPost(): EditablePostDraft {
      return {
        id: 'post-saved-twice',
        generationId: null,
        title: 'A post saved more than once',
        description: '',
        prompt: '',
        body: 'The saved story.',
        visibility: 'public',
        category: 'image',
        postFormat: 'mixed',
        sourceKind: 'external',
        sourceTool: null,
        mediaUrl: '/proof.png',
        mediaKind: 'image',
        mediaItems: [{
          id: 'row-as-rendered',
          mediaKey: 'proof-a',
          url: '/proof.png',
          mediaKind: 'image',
          contentType: 'image/png',
          originalName: 'proof.png',
          width: null,
          height: null,
          durationSeconds: null,
          sortOrder: 0,
        }],
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      };
    }

    function postRouteBodies() {
      return fetchMock.mock.calls
        .filter(([url, init]) => String(url) === '/api/posts/post-saved-twice' && (init as RequestInit | undefined)?.method === 'PUT')
        .map(([, init]) => JSON.parse(String((init as { body: string }).body)) as { mediaItems?: unknown[] });
    }

    /** The key the composer minted for the picture added before the first save. */
    function addedMediaKey() {
      const [firstSave] = postRouteBodies();
      return (firstSave.mediaItems?.[1] as { mediaKey: string }).mediaKey;
    }

    // A public post keeps its visibility through the button that saves it.
    function saveButton() {
      return screen.getAllByRole('button', { name: /^save changes/i })[0];
    }

    async function addPictureAndSave(container: HTMLElement) {
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(fileInput, {
          target: { files: [new File(['added'], 'added.png', { type: 'image/png' })] },
        });
      });
      fireEvent.click(saveButton());
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
      expect(postRouteBodies()[0].mediaItems).toEqual([
        { existingId: 'row-as-rendered' },
        expect.objectContaining({ storagePath: 'uploads/user-1/added.png', originalName: 'added.png' }),
      ]);
    }

    async function editTitleAndSaveAgain() {
      fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), {
        target: { value: 'A post saved more than once, typo fixed' },
      });
      fireEvent.click(saveButton());
      await waitFor(() => expect(postRouteBodies()).toHaveLength(2));
    }

    it('names every saved picture by the id the last save answered with, the one it added included', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-saved-twice',
          visibility: 'public',
          showcasePath: '/showcase/post-saved-twice',
          mediaItems: [
            { id: 'row-a-after-first-save', mediaKey: 'proof-a' },
            { id: 'row-b-after-first-save', mediaKey: addedMediaKey() },
          ],
        }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-saved-twice', visibility: 'public', mediaItems: [] }),
      });

      const { container } = render(<NewPostClient initialPost={createMediaPost()} />);
      await addPictureAndSave(container);
      await editTitleAndSaveAgain();

      expect(postRouteBodies()[1].mediaItems).toEqual([
        { existingId: 'row-a-after-first-save' },
        { existingId: 'row-b-after-first-save' },
      ]);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    // A server from before the save answer listed its rows: the page reads the
    // post back before the next save instead of sending ids that name nothing.
    it('reads the saved rows back before the next save when the answer does not list them', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-saved-twice', visibility: 'public' }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          post: {
            ...createMediaPost(),
            mediaItems: [
              { ...createMediaPost().mediaItems![0], id: 'row-a-read-back' },
              { ...createMediaPost().mediaItems![0], id: 'row-b-read-back', mediaKey: addedMediaKey(), sortOrder: 1 },
            ],
          },
        }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-saved-twice', visibility: 'public' }),
      });

      const { container } = render(<NewPostClient initialPost={createMediaPost()} />);
      await addPictureAndSave(container);
      // One save, one request: nothing is read back until another save needs it.
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/posts/post-saved-twice')).toHaveLength(1);

      await editTitleAndSaveAgain();

      const readBack = fetchMock.mock.calls.find(([url, init]) => (
        String(url) === '/api/posts/post-saved-twice' && !(init as RequestInit | undefined)?.method
      ));
      expect(readBack?.[1]).toEqual({ headers: { Authorization: 'Bearer test-token' } });
      expect(postRouteBodies()[1].mediaItems).toEqual([
        { existingId: 'row-a-read-back' },
        { existingId: 'row-b-read-back' },
      ]);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
    });

    // The rows were re-inserted since the page last named them (an earlier save
    // that finished late, or an edit from the app): the server refuses the old
    // ids with `field: 'mediaItems'`, and the next save reads the rows back.
    it('reads the rows back after a refusal that says its media ids are stale', async () => {
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({ error: 'An existing media item no longer belongs to this post.', field: 'mediaItems' }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          post: { ...createMediaPost(), mediaItems: [{ ...createMediaPost().mediaItems![0], id: 'row-a-read-back' }] },
        }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-saved-twice', visibility: 'public' }),
      });

      render(<NewPostClient initialPost={createMediaPost()} />);
      fireEvent.change(screen.getByRole('textbox', { name: /^title/i }), {
        target: { value: 'A post saved more than once, typo fixed' },
      });
      fireEvent.click(saveButton());
      await waitFor(() => expect(postRouteBodies()).toHaveLength(1));
      expect(postRouteBodies()[0].mediaItems).toEqual([{ existingId: 'row-as-rendered' }]);

      fireEvent.click(saveButton());
      await waitFor(() => expect(postRouteBodies()).toHaveLength(2));
      expect(fetchMock.mock.calls.some(([url, init]) => (
        String(url) === '/api/posts/post-saved-twice' && !(init as RequestInit | undefined)?.method
      ))).toBe(true);
      expect(postRouteBodies()[1].mediaItems).toEqual([{ existingId: 'row-a-read-back' }]);
    });

    it('keeps the upload of a picture added while the save was on its way', async () => {
      let answerFirstSave: (value: unknown) => void = () => {};
      enqueueResponse({ ok: true, json: () => new Promise((resolve) => { answerFirstSave = resolve; }) });
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-saved-twice', visibility: 'public', mediaItems: [] }),
      });

      const { container } = render(<NewPostClient initialPost={createMediaPost()} />);
      fireEvent.click(saveButton());
      await waitFor(() => expect(postRouteBodies()).toHaveLength(1));

      await act(async () => {
        fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
          target: { files: [new File(['late'], 'late.png', { type: 'image/png' })] },
        });
      });
      await act(async () => {
        answerFirstSave({
          success: true,
          postId: 'post-saved-twice',
          visibility: 'public',
          mediaItems: [{ id: 'row-a-after-first-save', mediaKey: 'proof-a' }],
        });
      });
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();

      await editTitleAndSaveAgain();
      expect(postRouteBodies()[1].mediaItems).toEqual([
        { existingId: 'row-a-after-first-save' },
        expect.objectContaining({ storagePath: 'uploads/user-1/late.png', originalName: 'late.png' }),
      ]);
      expect(temporaryUploadMock).toHaveBeenCalledTimes(1);
    });

    // An empty list is refused ("Media posts need at least one image or
    // video."), so a text post sends none, as the app's edit does.
    it('sends no media list for a text post', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-text-edit', visibility: 'public' }),
      });

      render(<NewPostClient initialPost={{
        id: 'post-text-edit',
        generationId: null,
        title: 'A text post with a real title',
        description: '',
        prompt: '',
        body: 'A text post long enough to pass the public quality rule.',
        visibility: 'public',
        category: 'text',
        postFormat: 'text',
        sourceKind: 'manual',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      }} />);

      fireEvent.click(saveButton());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      const payload = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body));
      expect(payload).not.toHaveProperty('mediaItems');
    });
  });

  // Below 1024px people save from the bar fixed to the bottom of the screen,
  // and both a refusal and the saved panel are drawn far from it, at the end
  // of the form: the spinner stopped and nothing visible changed.
  describe('where a save’s outcome shows', () => {
    function createTextPost(): EditablePostDraft {
      return {
        id: 'post-outcome',
        generationId: null,
        title: 'A text post with a real title',
        description: '',
        prompt: '',
        body: 'A text post long enough to pass the public quality rule.',
        visibility: 'public',
        category: 'text',
        postFormat: 'text',
        sourceKind: 'manual',
        sourceTool: null,
        mediaUrl: null,
        mediaKind: null,
        archivedAt: null,
        resourceBundle: { accessMode: 'none' },
        hasPaidOrders: false,
      };
    }

    it('focuses the section a refusal is written in when the phone bar pressed publish', async () => {
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
          field: 'profile',
        }),
      });

      render(<NewPostClient />);
      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
        target: { value: 'A note that stands on its own for the community.' },
      });
      fillRequiredTitle();
      // The phone bar comes first in the page.
      const phoneBarPublish = screen.getAllByRole('button', { name: /publish public/i })[0];
      phoneBarPublish.focus();
      fireEvent.click(phoneBarPublish);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/custom handle/i);
      await waitFor(() => expect(alert.closest('[data-composer-section]')).toHaveFocus());
    });

    it('writes a refusal of the recipe’s text in the Recipe section, and focuses it', async () => {
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'This content cannot be shared publicly because it may violate the community safety rules. Revise it or keep the post private.',
          field: 'resourceCards',
        }),
      });

      render(<NewPostClient initialPost={createTextPost()} />);
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/community safety rules/i);
      const section = alert.closest('[data-composer-section]');
      expect(section).toHaveAttribute('data-composer-section', 'resources');
      await waitFor(() => expect(section).toHaveFocus());
    });

    it('focuses the saved panel after an edit is saved', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-outcome', visibility: 'public' }),
      });

      render(<NewPostClient initialPost={createTextPost()} />);
      fireEvent.click(screen.getAllByRole('button', { name: /^save changes/i })[0]);

      const saved = await screen.findByText('Changes saved');
      await waitFor(() => expect(saved.closest('[tabindex="-1"]')).toHaveFocus());
    });

    it('saves again after a change to NSFW alone', async () => {
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-outcome', visibility: 'public' }),
      });
      enqueueResponse({
        ok: true,
        json: async () => ({ success: true, postId: 'post-outcome', visibility: 'public' }),
      });

      render(<NewPostClient initialPost={createTextPost()} />);
      const saveButtons = () => screen.getAllByRole('button', { name: /^save changes/i });
      fireEvent.click(saveButtons()[0]);
      expect(await screen.findByText('Changes saved')).toBeInTheDocument();
      expect(saveButtons().every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

      fireEvent.click(screen.getByRole('checkbox', { name: /mark as nsfw/i }));
      expect(screen.queryByText('Changes saved')).not.toBeInTheDocument();
      expect(saveButtons()[0]).toBeEnabled();

      fireEvent.click(saveButtons()[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body))).toMatchObject({ isNsfw: true });
    });
  });

  describe('from this creation', () => {
    function enqueueCreation(overrides: Record<string, unknown> = {}) {
      enqueueResponse({
        ok: true,
        json: async () => ({
          generations: [{
            id: 'gen-recipe-1',
            output_url: 'https://proxy.example.com/generated_images/user-1/output.jpg',
            category: 'image',
            model: 'nano-banana-2',
            title: 'Window display still',
            description: '',
            prompt: 'A product still lit like a window display.',
            origin: 'creation',
            input_media: [{
              id: 'input-1',
              generationId: 'gen-recipe-1',
              mediaType: 'image',
              role: 'reference',
              label: 'Product',
              url: 'https://proxy.example.com/generation_inputs/user-1/product.png',
              storagePath: 'generation_inputs/user-1/product.png',
              sourceGenerationId: null,
              sortOrder: 0,
              metadata: {},
            }],
            paywallPrefill: null,
            ...overrides,
          }],
        }),
      });
    }

    // Most creations have no title, and typing one was the step people
    // stopped at. The prompt may suggest it unless a paid recipe sells it; a
    // free one hands it to anyone with one tap (owner, 2026-10-29).
    it('starts an untitled creation from a title its prompt suggests, and swaps it while a paid recipe keeps the prompt private', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation({ title: null });

      render(<NewPostClient />);
      const titleInput = screen.getByRole('textbox', { name: /^title/i });
      await waitFor(() => expect(titleInput).toHaveValue('Product still lit like a window display'));
      expect(screen.getByText('Suggested from your prompt. Edit it if you like.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(titleInput).toHaveValue('Product still lit like a window display');
      expect(screen.getByText('Suggested from your prompt. Edit it if you like.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
      expect(titleInput).toHaveValue('Image recipe');
      expect(screen.getByText('Suggested. A paid recipe keeps your prompt off the post.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: /no recipe/i }));
      expect(titleInput).toHaveValue('Product still lit like a window display');
    });

    it('keeps a title the creator typed when a recipe is turned on', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation({ title: null });

      render(<NewPostClient />);
      const titleInput = screen.getByRole('textbox', { name: /^title/i });
      await waitFor(() => expect(titleInput).toHaveValue('Product still lit like a window display'));
      fireEvent.change(titleInput, { target: { value: 'Window still, morning light' } });
      expect(screen.queryByText(/^Suggested/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(titleInput).toHaveValue('Window still, morning light');
    });

    it('takes a template’s name as the creation’s own title', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation({
        title: null,
        origin: 'template',
        prompt: '',
        model: 'template-workflow',
        template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Ghost rider' },
      });

      render(<NewPostClient />);
      await waitFor(() => expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Ghost rider'));
      expect(screen.queryByText(/^Suggested/)).not.toBeInTheDocument();
      // The server refuses a recipe on a template result: no cards, the notice.
      expect(screen.queryByRole('radio', { name: /free recipe/i })).not.toBeInTheDocument();
      expect(screen.getByText(/shares final media only/i)).toBeInTheDocument();
    });

    // A motion prompt says how to move ("No distortion, …"), not what is shown.
    it('names a motion transfer by its kind, never by its motion prompt', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation({
        title: null,
        category: 'video',
        model: 'kling-3.0',
        creationMode: 'motion',
        prompt: 'No distortion, the character’s movements are consistent with the video.',
        output_url: 'https://proxy.example.com/generated_videos/user-1/output.mp4',
      });

      render(<NewPostClient />);
      await waitFor(() => expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Motion transfer'));
      expect(screen.getByText('Suggested. Edit it if you like.')).toBeInTheDocument();
    });

    // A post saved with the prompt's opening as its title would otherwise carry
    // it into a recipe's public post when the recipe is added later.
    it('swaps a title cut from the prompt for a paid recipe’s in an edit too, without calling it a suggestion', async () => {
      enqueueCreation({ title: null });
      render(<NewPostClient initialPost={{
        ...createGenerationRecipePost(),
        id: 'post-gen-plain-1',
        generationId: 'gen-recipe-1',
        title: 'Product still lit like a window display',
        rawTitle: 'Product still lit like a window display',
        prompt: 'A product still lit like a window display.',
        visibility: 'private',
        resourceBundle: { accessMode: 'none' } as EditablePostDraft['resourceBundle'],
      }} />);
      const titleInput = screen.getByRole('textbox', { name: /^title/i });
      expect(titleInput).toHaveValue('Product still lit like a window display');
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/generations'))).toBe(true));
      expect(screen.queryByText(/^Suggested/)).not.toBeInTheDocument();

      // A free recipe leaves it; a paid one, which sells the prompt, swaps it.
      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      expect(titleInput).toHaveValue('Product still lit like a window display');
      fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
      expect(titleInput).toHaveValue('Image recipe');
      expect(screen.queryByText(/^Suggested/)).not.toBeInTheDocument();
    });

    it('adds the exact prompt as a card and sends the saved references with the recipe', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation();
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-recipe-1',
          showcasePath: '/showcase/post-recipe-1',
          resourceBundlePath: '/showcase/post-recipe-1#recipe',
          visibility: 'public',
          resourceBundleStatus: 'published',
        }),
      });

      render(<NewPostClient />);
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Window display still');
      });
      // Offered inside a recipe only.
      expect(screen.queryByRole('checkbox', { name: /include exact prompt/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));

      const includePrompt = screen.getByRole('checkbox', { name: /include exact prompt/i });
      expect(includePrompt).not.toBeChecked();
      fireEvent.click(includePrompt);
      expect(includePrompt).toBeChecked();
      expect(screen.getByText('Exact generation prompt')).toBeInTheDocument();
      fireEvent.click(includePrompt);
      expect(screen.queryByText('Exact generation prompt')).not.toBeInTheDocument();
      fireEvent.click(includePrompt);

      fireEvent.click(screen.getByRole('checkbox', { name: /include creation references/i }));
      fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
        target: { value: 'The exact prompt and the product reference behind this still.' },
      });
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      const payload = JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body));
      expect(payload).toMatchObject({
        generationId: 'gen-recipe-1',
        includeGenerationReferences: true,
        resourceBundle: { accessMode: 'free' },
      });
      expect(payload.resourceBundle.resources.items).toMatchObject([
        { type: 'prompt', textContent: 'A product still lit like a window display.' },
      ]);
    });

    it('sends no references unless asked, and offers none for a creation without saved inputs', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation({ input_media: [] });
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-recipe-2',
          showcasePath: '/showcase/post-recipe-2',
          resourceBundlePath: '/showcase/post-recipe-2#recipe',
          visibility: 'public',
          resourceBundleStatus: 'published',
        }),
      });

      render(<NewPostClient />);
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Window display still');
      });
      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      fireEvent.click(screen.getByRole('checkbox', { name: /include exact prompt/i }));
      expect(screen.queryByRole('checkbox', { name: /include creation references/i })).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
        target: { value: 'The exact prompt behind this window display still.' },
      });
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      const payload = JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body));
      expect(payload).not.toHaveProperty('includeGenerationReferences');
    });

    // A-F16: the app's exact-prompt item, and the preview written from it.
    it('makes the exact prompt the app’s item and writes the preview from it', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation({ input_media: [] });
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-recipe-3',
          showcasePath: '/showcase/post-recipe-3',
          resourceBundlePath: '/showcase/post-recipe-3#recipe',
          visibility: 'public',
          resourceBundleStatus: 'published',
        }),
      });

      render(<NewPostClient />);
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Window display still');
      });
      fireEvent.click(screen.getByRole('radio', { name: /free recipe/i }));
      fireEvent.click(screen.getByRole('checkbox', { name: /include exact prompt/i }));
      expect(screen.getByText('Add the original generation prompt to the recipe.')).toBeInTheDocument();
      expect(screen.getByText('Exact generation prompt')).toBeInTheDocument();
      expect(screen.getByLabelText(/recipe preview, required/i)).toHaveValue('Includes the prompt.');
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      const payload = JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body));
      expect(payload.resourceBundle).toMatchObject({
        accessMode: 'free',
        summary: 'Includes the prompt.',
        previewText: 'Includes the prompt.',
        resources: { allowRemix: false },
      });
      expect(payload.resourceBundle.resources.sections).toMatchObject([
        { title: 'Exact generation prompt', publicTitle: 'Exact generation prompt', resourceType: 'prompt' },
      ]);
    });

    // A-F9: the creation's saved inputs are what some recipes sell. Ticked on
    // their own they count as the recipe's item, listed where the items are.
    it('counts the creation’s references as an item and lists them with the items', async () => {
      searchParamsState.value = new URLSearchParams({ generationId: 'gen-recipe-1' });
      enqueueCreation();
      enqueueResponse({
        ok: true,
        json: async () => ({
          success: true,
          postId: 'post-recipe-4',
          showcasePath: '/showcase/post-recipe-4',
          resourceBundlePath: '/showcase/post-recipe-4#recipe',
          visibility: 'public',
          resourceBundleStatus: 'published',
        }),
      });

      render(<NewPostClient />);
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^title/i })).toHaveValue('Window display still');
      });
      fireEvent.click(screen.getByRole('radio', { name: /paid recipe/i }));
      expect(screen.queryByText('Creation references · 1 file')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: /include creation references/i }));
      expect(screen.getByText('Creation references · 1 file')).toBeInTheDocument();
      expect(screen.getByText('1 item ready')).toBeInTheDocument();
      // They read as reference media in the suggestion, as the app writes it.
      expect(screen.getByLabelText(/recipe preview, required/i)).toHaveValue('Includes reference media.');
      fireEvent.change(screen.getByLabelText(/recipe preview, required/i), {
        target: { value: 'The product reference behind this window display still.' },
      });
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      const payload = JSON.parse(String((fetchMock.mock.calls[2][1] as { body: string }).body));
      expect(payload).toMatchObject({
        generationId: 'gen-recipe-1',
        includeGenerationReferences: true,
        resourceBundle: {
          accessMode: 'paid',
          priceUsdCents: 900,
          previewText: 'The product reference behind this window display still.',
          resources: { allowRemix: false, items: [] },
        },
      });
    });
  });

  // A-F4/A-F5: a creator prices in credits, the buyers' unit, and sees what a
  // price is in money, their 85% of it and when it can be paid out.
  it('prices a recipe in credits and says what buyers pay and the creator earns', () => {
    render(<NewPostClient />);
    const recipe = within(document.getElementById('recipe')!);

    expect(recipe.getByRole('radio', { name: /paid recipe/i })).toHaveAccessibleName(/set a credit price/i);
    fireEvent.click(recipe.getByRole('radio', { name: /paid recipe/i }));
    const price = recipe.getByRole('spinbutton', { name: 'Price in credits' });
    expect(price).toHaveValue(900);
    expect(recipe.getByText('Buyers pay $9.00 · You earn ~$7.65 (85%) · Payouts from $100')).toBeInTheDocument();
    expect(recipe.getByText('Before buying, people see your recipe preview and item titles — never what’s inside.')).toBeInTheDocument();
    fireEvent.change(price, { target: { value: '50' } });
    expect(recipe.getByText('Buyers pay $0.50 · You earn ~$0.43 (85%) · Payouts from $100')).toBeInTheDocument();
    expect(recipe.getByText(/under 100 credits, buyers unlock with credits/i)).toBeInTheDocument();
    expect(recipe.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it('shows its own price rule instead of leaving an off-step price to the browser', async () => {
    searchParamsState.value = new URLSearchParams({ resourceMode: 'paid' });
    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
      target: { value: 'A text post long enough to pass the public quality rule.' },
    });
    fillRequiredTitle();
    fireEvent.click(screen.getByRole('button', { name: /add your first item/i }));
    fireEvent.click(screen.getByRole('button', { name: /prompt or script/i }));
    fireEvent.change(screen.getByLabelText(/item title, required/i), { target: { value: 'The prompt' } });
    fireEvent.change(screen.getByLabelText(/^protected content$/i), {
      target: { value: 'The exact prompt behind this post.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save item/i }));
    // 95 fails the input's own step=10, which blocked submit with a browser
    // bubble before the composer could say what it wants.
    fireEvent.change(screen.getByRole('spinbutton', { name: /price in credits/i }), { target: { value: '95' } });
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    expect(await screen.findByText('Paid recipes start at 10 credits, in steps of 10.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Every new account starts with the placeholder handle and no name, which a
  // public post is refused for. The composer asks beside the buttons and saves
  // them first, instead of the server refusing the post once all is uploaded.
  describe('a name and handle before a public post', () => {
    const placeholderProfile = {
      id: 'user-1',
      username: 'creator-a1b2c3d4',
      suggestedUsername: 'creator-a1b2c3d4',
      displayName: null,
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
    };
    const createdPost = {
      ok: true,
      json: async () => ({
        postId: 'post-identity-1',
        showcasePath: '/showcase/post-identity-1',
        ownerPath: '/post/post-identity-1/edit',
        visibility: 'public',
        resourceBundleStatus: null,
      }),
    };
    const postsCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/posts');

    function writeTextPost() {
      fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /^post text/i }), {
        target: { value: 'A note that stands on its own for the community.' },
      });
      fillRequiredTitle();
    }

    it('asks for them beside the buttons and publishes nothing until they are given', async () => {
      loadOwnProfileMock.mockResolvedValue(placeholderProfile);
      render(<NewPostClient />);
      writeTextPost();

      expect(await screen.findByRole('textbox', { name: /^display name$/i })).toHaveValue('');
      expect(screen.getByText('Name and handle')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      expect(await screen.findByText('Add your name and handle to publish publicly.')).toBeInTheDocument();
      expect(screen.getByText('Add a display name for your public profile.')).toBeInTheDocument();
      expect(claimPublicIdentityMock).not.toHaveBeenCalled();
      expect(postsCalls()).toHaveLength(0);
    });

    it('saves them first, then publishes the post', async () => {
      loadOwnProfileMock.mockResolvedValue(placeholderProfile);
      claimPublicIdentityMock.mockResolvedValue({
        ok: true,
        profile: { ...placeholderProfile, username: 'maya-k', displayName: 'Maya K' },
      });
      enqueueResponse(createdPost);
      render(<NewPostClient />);
      writeTextPost();

      fireEvent.change(await screen.findByRole('textbox', { name: /^display name$/i }), { target: { value: 'Maya K' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^handle$/i }), { target: { value: '@Maya-K!' } });
      expect(screen.getByRole('textbox', { name: /^handle$/i })).toHaveValue('maya-k');
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(postsCalls()).toHaveLength(1));
      expect(claimPublicIdentityMock).toHaveBeenCalledWith({ displayName: 'Maya K', username: 'maya-k' }, 'test-token');
      const postCallIndex = fetchMock.mock.calls.findIndex(([url]) => String(url) === '/api/posts');
      expect(claimPublicIdentityMock.mock.invocationCallOrder[0])
        .toBeLessThan(fetchMock.mock.invocationCallOrder[postCallIndex]);
      // Saved: the fields give way to the post.
      await waitFor(() => expect(screen.queryByRole('textbox', { name: /^display name$/i })).not.toBeInTheDocument());
    });

    it('shows a taken handle on its field, counts the attempt as failed and publishes nothing', async () => {
      loadOwnProfileMock.mockResolvedValue(placeholderProfile);
      claimPublicIdentityMock.mockResolvedValue({
        ok: false,
        errors: { username: 'That username is already taken.' },
        message: 'That username is already taken.',
      });
      const events: Array<{ eventName: string; parameters: Record<string, unknown> }> = [];
      const recordEvent = (event: Event) => events.push((event as CustomEvent).detail);
      window.addEventListener('magicbooklet:product-event', recordEvent);
      render(<NewPostClient />);
      writeTextPost();

      fireEvent.change(await screen.findByRole('textbox', { name: /^display name$/i }), { target: { value: 'Maya K' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^handle$/i }), { target: { value: 'maya' } });
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(claimPublicIdentityMock).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('textbox', { name: /^handle$/i })).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getAllByText('That username is already taken.').length).toBeGreaterThanOrEqual(1);
      expect(postsCalls()).toHaveLength(0);
      // The server's refusal for the profile used to be counted; the save's refusal is too.
      expect(events.find((event) => event.eventName === 'post_publish_failed')?.parameters)
        .toMatchObject({ visibility: 'public', error_section: 'publish' });
      window.removeEventListener('magicbooklet:product-event', recordEvent);
    });

    it('asks nothing of a private post or a profile that can already publish', async () => {
      loadOwnProfileMock.mockResolvedValue(placeholderProfile);
      enqueueResponse(createdPost);
      const { unmount } = render(<NewPostClient />);
      writeTextPost();
      await screen.findByRole('textbox', { name: /^display name$/i });
      fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);
      await waitFor(() => expect(postsCalls()).toHaveLength(1));
      expect(claimPublicIdentityMock).not.toHaveBeenCalled();
      unmount();

      loadOwnProfileMock.mockResolvedValue({ ...placeholderProfile, username: 'maya-k', displayName: 'Maya K' });
      render(<NewPostClient />);
      writeTextPost();
      await waitFor(() => expect(loadOwnProfileMock).toHaveBeenCalledTimes(2));
      // The read's answer has landed: the page drawn after it shows no fields either.
      await act(async () => {
        await loadOwnProfileMock.mock.results[1].value;
      });
      expect(screen.queryByRole('textbox', { name: /^display name$/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Name and handle')).not.toBeInTheDocument();
    });

    // The pages read the two fields with the rest of the server render, so the
    // fields are there from the first paint and nothing is fetched for them.
    it('starts from what the server render read and does not read the profile again', () => {
      const { unmount } = render(
        <NewPostClient initialPublicIdentity={{ username: 'creator-a1b2c3d4', displayName: null }} />,
      );
      writeTextPost();
      expect(screen.getByRole('textbox', { name: /^display name$/i })).toBeInTheDocument();
      expect(screen.getByText('Name and handle')).toBeInTheDocument();
      unmount();

      render(<NewPostClient initialPublicIdentity={{ username: 'maya-k', displayName: 'Maya K' }} />);
      writeTextPost();
      expect(screen.queryByRole('textbox', { name: /^display name$/i })).not.toBeInTheDocument();
      expect(loadOwnProfileMock).not.toHaveBeenCalled();
    });

    // A profile that could not be read here is the server's to judge, and when
    // it refuses the post for it, the same fields take the creator through.
    it('asks for them after the server refuses a post for the profile', async () => {
      enqueueResponse({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
          field: 'profile',
          actionHref: '/profile',
        }),
      });
      claimPublicIdentityMock.mockResolvedValue({
        ok: true,
        profile: { ...placeholderProfile, username: 'maya-k', displayName: 'Maya K' },
      });
      enqueueResponse(createdPost);
      render(<NewPostClient />);
      writeTextPost();
      expect(screen.queryByRole('textbox', { name: /^display name$/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      fireEvent.change(await screen.findByRole('textbox', { name: /^display name$/i }), { target: { value: 'Maya K' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^handle$/i }), { target: { value: 'maya-k' } });
      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

      await waitFor(() => expect(postsCalls()).toHaveLength(2));
      expect(claimPublicIdentityMock).toHaveBeenCalledWith({ displayName: 'Maya K', username: 'maya-k' }, 'test-token');
      await waitFor(() => expect(screen.queryByRole('textbox', { name: /^display name$/i })).not.toBeInTheDocument());
    });
  });
});
