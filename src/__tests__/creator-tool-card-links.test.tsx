import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateHubPage from '@/app/create/page';

const getServerAuthStateMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();

vi.mock('@/app/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a
      {...props}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
    />
  ),
}));

vi.mock('@/app/components/HoverVideo', () => ({
  HoverVideo: ({ src, className }: { src: string; className?: string }) => (
    <video data-testid="hover-video" src={src} className={className} />
  ),
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: (...args: unknown[]) => getShowcaseFeedPageMock(...args),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

/**
 * The creator tool card is one link wrapping the whole card — title, summary,
 * and call to action — so a keyboard user lands on a single stop and assistive
 * tech announces one target instead of three nested ones. The launchpad
 * (`/create`) is the surface that renders these cards; the home page now
 * renders the community feed with a compact quick-starts rail instead
 * (see anonymous-home-page-cache.test.tsx).
 */
function expectCardToUseSingleLink({
  title,
  summary,
  cta,
  href,
}: {
  title: string;
  summary: string;
  cta: string;
  href: string;
}) {
  const titleLink = screen.getByText(title).closest('a');
  expect(titleLink).not.toBeNull();
  expect(titleLink).toHaveAttribute('href', href);
  expect(within(titleLink as HTMLAnchorElement).getByText(summary)).toBeInTheDocument();
  expect(within(titleLink as HTMLAnchorElement).getByText(cta)).toBeInTheDocument();
  expect(titleLink?.querySelectorAll('a')).toHaveLength(0);

  (titleLink as HTMLAnchorElement).focus();
  expect(titleLink).toHaveFocus();
}

describe('creator tool card links', () => {
  beforeEach(() => {
    const imageItem = {
      id: 'image-1',
      mediaUrl: 'https://example.com/image.jpg',
      mediaKind: 'image' as const,
      model: 'nano-banana-2',
      title: 'Image Preview',
      prompt: 'Image prompt',
      body: '',
      category: 'image' as const,
      postFormat: 'media' as const,
      saveCount: 8,
      remixCount: 2,
      createdAt: '2026-04-01T00:00:00.000Z',
      creator: {
        id: 'creator-1',
        username: 'creator-one',
        name: 'Creator One',
        avatar: null,
      },
      isSaved: false,
      sourceKind: 'magicbooklet' as const,
      sourceTool: null,
      generationId: 'image-1',
      asset: null,
      canRemix: true,
    };
    const videoItem = {
      ...imageItem,
      id: 'video-1',
      mediaUrl: 'https://example.com/video.mp4',
      mediaKind: 'video' as const,
      model: 'kling-3.0-video',
      title: 'Video Preview',
      prompt: 'Video prompt',
      category: 'video' as const,
      generationId: 'video-1',
    };
    const motionItem = {
      ...videoItem,
      id: 'motion-1',
      mediaUrl: 'https://example.com/motion.mp4',
      model: 'kling-3.0',
      title: 'Motion Preview',
      prompt: 'Motion prompt',
      category: 'motion' as const,
      generationId: 'motion-1',
    };

    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      credits: 12,
    });

    getShowcaseFeedPageMock.mockImplementation(async (options?: { category?: string }) => {
      const category = options?.category ?? 'all';

      if (category === 'image') return { items: [imageItem] };
      if (category === 'video') return { items: [videoItem] };
      if (category === 'motion') return { items: [motionItem] };

      return { items: [imageItem, videoItem, motionItem] };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses one full-card link for each creator path on the launchpad page', async () => {
    render(await CreateHubPage());

    expectCardToUseSingleLink({
      title: 'Create Image',
      summary: 'Polished stills, hooks, and product frames in minutes.',
      cta: 'Start with image',
      href: '/create-image',
    });
    expectCardToUseSingleLink({
      title: 'Create Video',
      summary: 'Prompt-to-clip scenes for launches, explainers, and teasers.',
      cta: 'Start with video',
      href: '/create-video',
    });
    expectCardToUseSingleLink({
      title: 'Create Motion',
      summary: 'Animate still talent into UGC-style movement and delivery.',
      cta: 'Start with motion',
      href: '/create-motion',
    });
    expectCardToUseSingleLink({
      title: 'Workflow Canvas',
      summary: 'Turn one-off prompting into a repeatable creative system.',
      cta: 'Open workflow canvas',
      href: '/create-workflow',
    });

    const launchpadVideoCardLink = screen.getByText('Create Video').closest('a');
    expect(within(launchpadVideoCardLink as HTMLAnchorElement).getByTestId('hover-video')).toBeInTheDocument();
    expect(screen.getByText('Try this image setup').closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/create-image?')
    );
    expect(screen.getByText('Explore showcase').closest('a')).toHaveAttribute('href', '/showcase');
  });
});
