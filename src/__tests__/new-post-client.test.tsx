import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewPostClient from '@/app/post/new/NewPostClient';

const mockPush = vi.fn();
const fetchMock = vi.fn();
const storageUploadMock = vi.hoisted(() => vi.fn());
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

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: storageUploadMock,
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
    { slug: 'sora', label: 'Sora', models: [], supportedMediaKinds: ['video'] },
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
    storageUploadMock.mockReset();
    storageUploadMock.mockResolvedValue({ error: null });
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

  it('keeps the minimal composer chrome quiet and focused', () => {
    render(<NewPostClient />);

    expect(screen.queryByText(/community post composer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/one post, one optional unlock/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /browse unlocks/i })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: /^media$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^text$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add media/i })).toBeInTheDocument();

    const checklist = screen.getByLabelText(/publish checklist/i);
    expect(checklist).toHaveTextContent(/proof added/i);
    expect(checklist).toHaveTextContent(/story ready/i);
    expect(checklist).toHaveTextContent(/unlock optional/i);
  });

  it('keeps optional description hidden until the user asks for it', () => {
    render(<NewPostClient />);

    expect(screen.queryByPlaceholderText(/optional: give the post a short one-line setup/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add feed description/i }));

    expect(screen.getByPlaceholderText(/optional: give the post a short one-line setup/i)).toBeInTheDocument();
  });

  it('shows section-local validation feedback near the failing composer section', () => {
    render(<NewPostClient />);

    fireEvent.click(screen.getAllByRole('button', { name: /publish public/i })[0]);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/upload an image or video/i);
    expect(alert.closest('[data-composer-section]')).toHaveAttribute('data-composer-section', 'post');
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
        resourceBundlePath: '/showcase/post-1#resources',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'Lead with a concrete before-and-after in the first line.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add references & unlockable resources/i }));

    expect(screen.getByText(/resource types to include/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/https:\/\//i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^workflow \/ setup$/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i), {
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
    expect(await screen.findByRole('link', { name: /open unlock section/i })).toHaveAttribute(
      'href',
      '/showcase/post-1#resources'
    );
  });

  it('keeps visibility choices available for paid unlock drafts and serializes structured links', async () => {
    enqueueResponse({
      ok: true,
      json: async () => ({
        postId: 'post-2',
        showcasePath: null,
        ownerPath: '/post/post-2/edit',
        resourceBundlePath: '/post/post-2/edit#resources',
        visibility: 'private',
        resourceBundleStatus: 'draft',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'Keep the hook direct and make the benefit visible instantly.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add references & unlockable resources/i }));
    fireEvent.click(screen.getByRole('button', { name: /^paid \(\$\)$/i }));

    expect(screen.queryByText(/public post required/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /files \/ links/i }));
    fireEvent.change(screen.getByPlaceholderText(/label 1/i), {
      target: { value: 'Prompt doc' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: 'https://ugc.example.com/doc' },
    });
    fireEvent.change(screen.getByDisplayValue('9'), {
      target: { value: '12' },
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
        resourceBundlePath: '/showcase/post-sectioned-1#resources',
        visibility: 'public',
        resourceBundleStatus: 'published',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'A compact breakdown for a multi-part creative.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add references & unlockable resources/i }));
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
      expect(storageUploadMock).toHaveBeenCalledTimes(1);
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
      expect(storageUploadMock).toHaveBeenCalledTimes(2);
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
        resourceBundlePath: '/showcase/post-paywall-1#resources',
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
    expect(screen.getByText(/remix access is included in this unlock/i)).toBeInTheDocument();

    const priceInput = screen.getByRole('textbox', { name: /price/i });
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

    expect(await screen.findByText(/does not have enough saved inputs to auto-fill a paid unlock yet/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i)).toHaveValue('');
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

    expect(screen.getByRole('heading', { name: /manage the unlock behind this post/i })).toBeInTheDocument();
    expect(screen.getAllByText(/you came from my studio/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/this unlock will save as a draft/i).length).toBeGreaterThan(0);

    const priceInput = screen.getByRole('textbox', { name: /price/i });
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
        resourceBundlePath: '/post/post-private-paid-1/edit#resources',
        visibility: 'private',
        resourceBundleStatus: 'draft',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /^text$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Write the post content.../i), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /add references & unlockable resources/i }));
    fireEvent.click(screen.getByRole('button', { name: /^paid \(\$\)$/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i), {
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
        resourceBundlePath: '/showcase/post-unlisted-paid-1#resources',
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
});
