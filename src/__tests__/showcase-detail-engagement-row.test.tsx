import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailEngagementRow from '@/app/showcase/[id]/ShowcaseDetailEngagementRow';

const pushMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/app/components/PublicShareButton', () => ({
  default: () => <button type="button">Share</button>,
}));

vi.mock('@/lib/showcase-remix-client', () => ({
  requestShowcaseRemix: vi.fn(async () => ({ redirectTo: '/create-image?remix=1' })),
}));

function rowProps(overrides: Partial<Parameters<typeof ShowcaseDetailEngagementRow>[0]> = {}) {
  return {
    postId: 'post-1',
    generationId: 'gen-1',
    title: 'Shared creation',
    shareDescription: 'A description.',
    canRemix: true,
    saveCount: 4,
    commentCount: 0,
    remixCount: 2,
    shareVisitCount: 9,
    showComments: true,
    ...overrides,
  };
}

describe('ShowcaseDetailEngagementRow', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      user: { id: 'viewer-1' },
      session: { access_token: 'token-1' },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ success: true, isSaved: true, saveCount: 5 }) } as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the verbs with compact counts and the comment anchor', () => {
    render(<ShowcaseDetailEngagementRow {...rowProps()} />);

    expect(screen.getByRole('button', { name: /remix · 2/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save shared creation/i })).toHaveTextContent('4');
    expect(screen.getByRole('link', { name: /comment/i })).toHaveAttribute('href', '#comments');
    expect(screen.getByTitle('9 visits')).toBeInTheDocument();
  });

  it('saves optimistically through the showcase save endpoint', async () => {
    render(<ShowcaseDetailEngagementRow {...rowProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /save shared creation/i }));

    // Optimistic flip lands before the network settles.
    expect(screen.getByRole('button', { name: /remove save from shared creation/i })).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/showcase/save', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ postId: 'post-1', shouldSave: true, sourceSurface: 'detail-page' }),
      }));
    });

    // The server's authoritative count replaces the optimistic one.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove save from shared creation/i })).toHaveTextContent('5');
    });
  });

  it('sends a signed-out viewer to login instead of saving', () => {
    useAuthMock.mockReturnValue({ user: null, session: null });

    render(<ShowcaseDetailEngagementRow {...rowProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /save shared creation/i }));

    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('/login?returnUrl='));
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith('/api/showcase/save', expect.anything());
  });
});
