import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewPostClient from '@/app/post/new/NewPostClient';
import { TITLE_MAX_LENGTH } from '@/lib/posts-server';

const mockPush = vi.fn();
const fetchMock = vi.fn();
const temporaryUploadMock = vi.hoisted(() => vi.fn());
const directResourceUploadMock = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const searchParamsState = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => searchParamsState.value,
}));

vi.mock('@/app/components/AuthProvider', () => ({
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

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        uploadToSignedUrl: directResourceUploadMock,
      }),
    },
  },
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

describe('NewPostClient', () => {
  beforeEach(() => {
    mockPush.mockReset();
    fetchMock.mockReset();
    temporaryUploadMock.mockReset();
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

  it('puts the public post hierarchy in the main composer path', () => {
    render(<NewPostClient />);

    expect(screen.getByRole('heading', { name: /create post/i })).toBeInTheDocument();
    expect(screen.getByText(/Share your work/i)).toBeInTheDocument();

    const titleInput = screen.getByRole('textbox', { name: /^title/i });
    const captionInput = screen.getByRole('textbox', { name: /caption/i });
    const proofHeading = screen.getByRole('heading', { name: /^proof$/i });
    const mediaToggle = screen.getByRole('button', { name: /^media$/i });

    expect(titleInput).toBeInTheDocument();
    expect(captionInput).toBeInTheDocument();
    expect(
      titleInput.compareDocumentPosition(proofHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      titleInput.compareDocumentPosition(mediaToggle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      titleInput.compareDocumentPosition(captionInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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

  it('keeps the minimal composer chrome quiet and focused', () => {
    render(<NewPostClient />);

    expect(screen.queryByText(/community post composer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/one post, one optional recipe/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /browse recipes/i })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: /^media$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^text$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add media/i })).toBeInTheDocument();

    const checklist = screen.getByLabelText(/publish checklist/i);
    expect(checklist).toHaveTextContent(/proof added/i);
    expect(checklist).toHaveTextContent(/caption optional/i);
    expect(checklist).toHaveTextContent(/recipe optional/i);
  });

  it('keeps optional description hidden until the user asks for it', () => {
    render(<NewPostClient />);

    expect(screen.queryByPlaceholderText(/optional: give the post a short one-line setup/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add showcase description/i }));

    expect(screen.getByPlaceholderText(/optional: give the post a short one-line setup/i)).toBeInTheDocument();
  });

  it('shows section-local validation feedback near the failing composer section', () => {
    render(<NewPostClient />);

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
    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.change(toolPicker, { target: { value: 'Pika Labs' } });
    fireEvent.click(await screen.findByRole('option', { name: /create “pika labs”/i }));

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })],
      },
    });
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

    const toolPicker = screen.getByRole('combobox', { name: 'Tool 1' });
    fireEvent.change(toolPicker, { target: { value: 'Pika Studio' } });
    fireEvent.blur(toolPicker);

    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

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
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'Lead with a concrete before-and-after in the first line.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add a reusable recipe/i }));

    expect(screen.getByText(/resource types to include/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the exact prompt included in the recipe/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/https:\/\//i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^workflow \/ setup$/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt included in the recipe/i), {
      target: { value: 'Use a before\/after hook and keep the CTA visible in frame.' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: 'https://ugc.example.com/workflow' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(resourceBundle).toMatchObject({
      accessMode: 'free',
      resources: {
        promptText: 'Use a before/after hook and keep the CTA visible in frame.',
        workflowShareUrl: 'https://ugc.example.com/workflow',
        notesMarkdown: null,
        attachments: [],
        allowRemix: false,
      },
    });
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
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'Keep the hook direct and make the benefit visible instantly.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add a reusable recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /^paid \(\$\)$/i }));

    expect(screen.queryByText(/public post required/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /files \/ links/i }));
    fireEvent.change(screen.getByPlaceholderText(/label 1/i), {
      target: { value: 'Prompt doc' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: 'https://ugc.example.com/doc' },
    });
    // Prices are entered in tokens now, and price_usd_cents stores the token
    // count directly, so 1200 tokens is what the payload should carry.
    fireEvent.change(screen.getByRole('spinbutton', { name: /price in tokens/i }), {
      target: { value: '1200' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(String(request.body.get('visibility'))).toBe('private');
    expect(resourceBundle).toMatchObject({
      accessMode: 'paid',
      priceUsdCents: 1200,
      resources: {
        attachments: [
          {
            label: 'Prompt doc',
            url: 'https://ugc.example.com/doc',
          },
        ],
      },
    });
    expect(await screen.findByRole('link', { name: /continue editing/i })).toHaveAttribute(
      'href',
      '/post/post-2/edit'
    );
  });

  it('serializes optional resource sections and section-scoped items', async () => {
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
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'A compact breakdown for a multi-part creative.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add a reusable recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enable section layout/i }));

    fireEvent.change(screen.getByLabelText(/section title 1/i), {
      target: { value: 'Hook' },
    });
    fireEvent.change(screen.getByLabelText(/section kind 1/i), {
      target: { value: 'scene' },
    });
    fireEvent.change(screen.getByLabelText(/section prompt 1/i), {
      target: { value: 'Open with the before state, then reveal the product.' },
    });
    fireEvent.change(screen.getByLabelText(/section notes 1/i), {
      target: { value: 'Keep this first section under seven seconds.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));
    const [section] = resourceBundle.resources.sections;

    expect(section).toMatchObject({
      title: 'Hook',
      kind: 'scene',
      description: null,
      sortOrder: 0,
    });
    expect(resourceBundle.resources.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'prompt',
        title: 'Hook prompt',
        textContent: 'Open with the before state, then reveal the product.',
        sectionId: section.id,
      }),
      expect.objectContaining({
        type: 'note',
        title: 'Hook notes',
        textContent: 'Keep this first section under seven seconds.',
        sectionId: section.id,
      }),
    ]));
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
    return () => Array.from(screen.getByLabelText('Post media order').children) as HTMLElement[];
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

    expect(screen.getByText('2 of 5 media added')).toBeInTheDocument();
    expect(screen.getByLabelText('Post media order')).toBeInTheDocument();

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

    expect(await screen.findByDisplayValue('A creator-style product image with warm natural light.')).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/saved generation setup/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/generations?includeArchived=true&id=gen-paid-1&limit=1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(screen.getByText(/saved prompt, reusable setup notes, and remix access are ready/i)).toBeInTheDocument();
    expect(screen.getByText(/remix access is included in this recipe/i)).toBeInTheDocument();

    const priceInput = screen.getByRole('spinbutton', { name: /price in tokens/i });
    await waitFor(() => {
      expect(priceInput).toHaveFocus();
    });

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
        resources: {
          promptText: 'A creator-style product image with warm natural light.',
          notesMarkdown: 'Saved generation setup\nModel: Nano Banana 2.0',
          allowRemix: true,
        },
      },
    });
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
    expect(screen.getByPlaceholderText(/paste the exact prompt included in the recipe/i)).toHaveValue('');
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

    const priceInput = screen.getByRole('spinbutton', { name: /price in tokens/i });
    await waitFor(() => {
      expect(priceInput).toHaveFocus();
    });
    expect(priceInput).not.toBeDisabled();
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
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'A private draft note.' },
    });
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
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'A public note for the community.' },
    });
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
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add a reusable recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /^paid \(\$\)$/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt included in the recipe/i), {
      target: { value: 'Use a simple private-only setup.' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /save private/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: FormData };
    expect(String(request.body.get('visibility'))).toBe('private');
  });

  it('shows the make public button for unlisted paid posts and attempts submit', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /make public/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[1][1].body).toContain('"visibility":"public"');
  });

  it('shows unlisted management options when editing an unlisted post', () => {
    render(
      <NewPostClient
        initialPost={{
          id: 'post-unlisted-1',
          generationId: null,
          title: 'Unlisted link post',
          description: '',
          prompt: '',
          body: 'Shareable by link only.',
          visibility: 'unlisted',
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

    expect(screen.getByRole('heading', { name: /update post/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save unlisted changes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /make public/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /make private/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish public/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save private/i })).not.toBeInTheDocument();
  });

  it('preserves unlisted visibility when saving unlisted changes', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-unlisted-1',
        showcasePath: null,
        ownerPath: '/post/post-unlisted-1/edit',
        resourceBundlePath: null,
        visibility: 'unlisted',
        resourceBundleStatus: null,
      }),
    });

    render(
      <NewPostClient
        initialPost={{
          id: 'post-unlisted-1',
          generationId: null,
          title: 'Unlisted link post',
          description: '',
          prompt: '',
          body: 'Shareable by link only.',
          visibility: 'unlisted',
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

    fireEvent.click(screen.getByRole('button', { name: /save unlisted changes/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const call = fetchMock.mock.calls[1];
    const body = JSON.parse(call[1].body);
    expect(body.visibility).toBe('unlisted');
  });

  describe('media upload progress', () => {
    function attachFile(container: HTMLElement, file: File) {
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, { target: { files: [file] } });
    }

    it('reports real byte progress while the upload is in flight', async () => {
      // Uploads happen at submit, so this banner is the only feedback during the
      // one stretch where the user is waiting on bytes.
      let reportProgress: ((progress: { bytesSent: number; totalBytes: number; fraction: number }) => void) | null = null;
      let finishUpload: ((value: { signedUrl: string; storagePath: string }) => void) | null = null;

      temporaryUploadMock.mockImplementation(async (
        file: File,
        _ownerUserId: string,
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
        _ownerUserId: string,
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

    it('re-uploads after a server-side publish failure, because the server deleted the staged media', async () => {
      // Every server-side failure path runs cleanupUploadedMedia, which deletes
      // the staged objects the composer still holds paths to. Keeping them would
      // make every retry skip the upload and fail on "Failed to load uploaded
      // media" forever, with no way out but removing and re-adding the file.
      enqueueResponse({
        ok: false,
        json: async () => ({ error: 'Failed to create post.' }),
      });

      const { container } = render(<NewPostClient />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, {
        target: { files: [new File(['png-bytes'], 'proof.png', { type: 'image/png' })] },
      });

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

      fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      // Re-staged rather than reusing the path the server just deleted.
      expect(temporaryUploadMock).toHaveBeenCalledTimes(2);
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
});
