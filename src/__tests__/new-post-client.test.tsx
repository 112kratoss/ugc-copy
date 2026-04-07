import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewPostClient from '@/app/post/new/NewPostClient';

const mockPush = vi.fn();
const fetchMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
  }),
}));

describe('NewPostClient', () => {
  beforeEach(() => {
    mockPush.mockReset();
    fetchMock.mockReset();
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
    expect(screen.getByText(/review what is public and what unlocks/i)).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /note only/i }));
    fireEvent.change(screen.getByPlaceholderText(/share the tactic, lesson, or idea/i), {
      target: { value: 'Lead with a concrete before-and-after in the first line.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /free resources/i }));

    expect(screen.getByText(/what are people unlocking/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/https:\/\//i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /workflow link/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the exact prompt people should unlock/i), {
      target: { value: 'Use a before/after hook and keep the CTA visible in frame.' },
    });
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), {
      target: { value: 'https://ugc.example.com/workflow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /publish post/i }));

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
    expect(await screen.findByRole('link', { name: /open resources section/i })).toHaveAttribute(
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

    fireEvent.click(screen.getByRole('button', { name: /note only/i }));
    fireEvent.change(screen.getByPlaceholderText(/share the tactic, lesson, or idea/i), {
      target: { value: 'Keep the hook direct and make the benefit visible instantly.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /paid resources/i }));

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
    fireEvent.click(screen.getByRole('button', { name: /publish post/i }));

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
});
