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

describe('NewPostClient', () => {
  beforeEach(() => {
    mockPush.mockReset();
    fetchMock.mockReset();
    storageUploadMock.mockReset();
    storageUploadMock.mockResolvedValue({ error: null });
    searchParamsState.value = new URLSearchParams();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('puts the public post hierarchy in the main composer path', () => {
    render(<NewPostClient />);

    expect(screen.getByRole('heading', { name: /create post/i })).toBeInTheDocument();
    expect(screen.getByText(/share the result first/i)).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole('button', { name: /share post/i }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/upload an image or video/i);
    expect(alert.closest('[data-composer-section]')).toHaveAttribute('data-composer-section', 'post');
  });

  it('keeps custom source tool suggestions inside the composer instead of using a native datalist', () => {
    render(<NewPostClient />);

    const customSourceToolInput = screen.getByRole('combobox', { name: /custom source tool/i });
    fireEvent.focus(customSourceToolInput);
    fireEvent.change(customSourceToolInput, { target: { value: 'Ru' } });

    const sourceToolSuggestions = screen.getByRole('listbox', { name: /source tool suggestions/i });
    expect(sourceToolSuggestions).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Runway' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Higgsfield' })).not.toBeInTheDocument();
  });

  it('reveals only the selected resource sections and submits a resource bundle', async () => {
    fetchMock.mockResolvedValueOnce({
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
    fireEvent.change(screen.getByPlaceholderText(/share the tactic, lesson, or idea/i), {
      target: { value: 'Lead with a concrete before-and-after in the first line.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^free unlock$/i }));

    expect(screen.getByText(/custom package contents/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/https:\/\//i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^workflow \/ setup$/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i), {
      target: { value: 'Use a before\/after hook and keep the CTA visible in frame.' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: 'https://ugc.example.com/workflow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /publish post \+ unlock/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const request = fetchMock.mock.calls[0][1] as { body: FormData };
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
    fetchMock.mockResolvedValueOnce({
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
    fireEvent.change(screen.getByPlaceholderText(/share the tactic, lesson, or idea/i), {
      target: { value: 'Keep the hook direct and make the benefit visible instantly.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^paid unlock$/i }));

    expect(screen.queryByText(/public post required/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^private$/i }));

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
    fireEvent.click(screen.getByRole('button', { name: /save draft/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const request = fetchMock.mock.calls[0][1] as { body: FormData };
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

  it('uploads media to Supabase before posting metadata to the API', async () => {
    fetchMock.mockResolvedValueOnce({
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
    fireEvent.click(screen.getByRole('button', { name: /share post/i }));

    await waitFor(() => {
      expect(storageUploadMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const request = fetchMock.mock.calls[0][1] as { body: FormData };

    expect(String(request.body.get('mediaStoragePath'))).toMatch(/^uploads\/user-1\/.+\.png$/);
    expect(String(request.body.get('mediaOriginalName'))).toBe('proof.png');
    expect(String(request.body.get('mediaContentType'))).toBe('image/png');
    expect(request.body.get('media')).toBeNull();
  });

  it('prefills generated paid unlocks and focuses the price field', async () => {
    searchParamsState.value = new URLSearchParams({
      generationId: 'gen-paid-1',
      publishIntent: 'paid-generation',
      resourceMode: 'paid',
      focus: 'price',
    });

    fetchMock
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
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
    expect(screen.getByText(/saved prompt, reusable setup notes, and remix access are ready/i)).toBeInTheDocument();
    expect(screen.getByText(/remix access is included in this unlock/i)).toBeInTheDocument();

    const priceInput = screen.getByRole('textbox', { name: /price/i });
    await waitFor(() => {
      expect(priceInput).toHaveFocus();
    });

    fireEvent.click(screen.getByRole('button', { name: /publish post \+ unlock/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const request = fetchMock.mock.calls[1][1] as { body: string };
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

    fetchMock.mockResolvedValueOnce({
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
});
