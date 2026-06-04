import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const getOwnerPostDetailMock = vi.hoisted(() => vi.fn());
const getServerAuthStateMock = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'x-vercel-ip-country': 'US' })),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('@/lib/owner-posts', () => ({
  getOwnerPostDetail: getOwnerPostDetailMock,
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: getServerAuthStateMock,
}));

vi.mock('@/app/components/AuthProvider', () => ({
  AuthProvider: vi.fn(({ children }) => (
    <div data-testid="auth-provider">{children}</div>
  )),
}));

vi.mock('@/app/post/new/NewPostClient', () => ({
  default: vi.fn(() => <div data-testid="new-post-client" />),
}));

describe('EditPostPage', () => {
  it('wraps the editor in AuthProvider using the resolved server auth state', async () => {
    const session = {
      access_token: 'token-1',
      user: { id: 'user-1' },
    };

    getServerAuthStateMock.mockResolvedValue({
      session,
      credits: 12,
    });
    getOwnerPostDetailMock.mockResolvedValue({
      id: 'post-1',
      generationId: 'generation-1',
      title: 'Paid unlock draft',
      description: null,
      prompt: null,
      body: 'A post with an unlock draft.',
      visibility: 'private',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'generation',
      sourceTool: 'Minimax',
      sourceToolSlug: 'minimax',
      mediaUrl: 'https://example.com/image.png',
      mediaKind: 'image',
      archivedAt: null,
      resourceBundleInput: { accessMode: 'none' },
      hasPaidOrders: false,
    });

    const { default: EditPostPage } = await import('@/app/post/[id]/edit/page');
    const { AuthProvider } = await import('@/app/components/AuthProvider');

    const result = await EditPostPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({ from: 'creations', focus: 'price' }),
    });

    expect(getOwnerPostDetailMock).toHaveBeenCalledWith('post-1', 'user-1', {
      countryCode: 'US',
    });
    expect(isValidElement(result)).toBe(true);
    expect(result.type).toBe(AuthProvider);
    expect(result.props).toMatchObject({
      initialSession: session,
      initialCredits: 12,
      hasResolvedInitialState: true,
    });
  });
});
