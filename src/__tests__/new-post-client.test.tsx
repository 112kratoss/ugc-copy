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

  it('keeps optional details hidden until the user asks for them', () => {
    render(<NewPostClient />);

    expect(screen.queryByPlaceholderText(/optional: give the post a short one-line setup/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add details \(optional\)/i }));

    expect(screen.getByPlaceholderText(/optional: give the post a short one-line setup/i)).toBeInTheDocument();
    expect(screen.getByText(/buyer preview/i)).toBeInTheDocument();
  });

  it('reveals only the selected resource sections and submits a resource bundle', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        postId: 'post-1',
        showcasePath: '/showcase/post-1',
        resourceBundlePath: '/showcase/post-1#resources',
        visibility: 'public',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /share a tip/i }));
    fireEvent.change(screen.getByPlaceholderText(/share the tactic, lesson, or idea/i), {
      target: { value: 'Lead with a concrete before-and-after in the first line.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add free unlock/i }));

    expect(screen.getByText(/what does the unlock include/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/https:\/\//i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^workflow \/ setup$/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i), {
      target: { value: 'Use a before/after hook and keep the CTA visible in frame.' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: 'https://ugc.example.com/workflow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /share post/i }));

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

  it('forces resource posts to publish publicly and serializes structured links', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        postId: 'post-2',
        showcasePath: '/showcase/post-2',
        resourceBundlePath: '/showcase/post-2#resources',
        visibility: 'public',
      }),
    });

    render(<NewPostClient />);

    fireEvent.click(screen.getByRole('button', { name: /share a tip/i }));
    fireEvent.change(screen.getByPlaceholderText(/share the tactic, lesson, or idea/i), {
      target: { value: 'Keep the hook direct and make the benefit visible instantly.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add paid unlock/i }));

    expect(screen.getByText(/public post required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^private$/i })).not.toBeInTheDocument();

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
    fireEvent.click(screen.getByRole('button', { name: /share post/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const request = fetchMock.mock.calls[0][1] as { body: FormData };
    const resourceBundle = JSON.parse(String(request.body.get('resourceBundle')));

    expect(String(request.body.get('visibility'))).toBe('public');
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
  });

  it('uploads media to Supabase before posting metadata to the API', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        postId: 'post-3',
        showcasePath: '/showcase/post-3',
        resourceBundlePath: null,
        visibility: 'public',
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

    fireEvent.click(screen.getByRole('button', { name: /share post/i }));

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
    expect(screen.getByText(/public post required/i)).toBeInTheDocument();

    const priceInput = screen.getByRole('textbox', { name: /price/i });
    await waitFor(() => {
      expect(priceInput).toHaveFocus();
    });
    expect(priceInput).not.toBeDisabled();
  });
});
