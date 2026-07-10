import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreateHubPage from '@/app/create/page';
import Home from '@/app/page';

const getServerAuthStateMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();
const homeShowcasePreviewGridMock = vi.fn(({
  items,
}: {
  items: unknown[];
  initialSession?: unknown;
  initialCredits?: unknown;
}) => (
  <div data-testid="home-showcase-preview-grid" data-count={items.length} />
));

vi.mock('@/app/components/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/components/DeferredHomeShowcasePreviewGrid', () => ({
  default: (props: { items: unknown[] }) => homeShowcasePreviewGridMock(props),
}));

vi.mock('@/app/components/HoverVideo', () => ({
  HoverVideo: ({ src, className }: { src: string; className?: string }) => (
    <video data-testid="hover-video" src={src} className={className} />
  ),
}));

vi.mock('@/app/components/JsonLd', () => ({
  JsonLd: () => null,
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: (...args: unknown[]) => getShowcaseFeedPageMock(...args),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

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
    homeShowcasePreviewGridMock.mockClear();
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
      id: 'video-1',
      mediaUrl: 'https://example.com/video.mp4',
      mediaKind: 'video' as const,
      model: 'kling-3.0-video',
      title: 'Video Preview',
      prompt: 'Video prompt',
      body: '',
      category: 'video' as const,
      postFormat: 'media' as const,
      saveCount: 5,
      remixCount: 1,
      createdAt: '2026-04-01T00:00:00.000Z',
      creator: {
        id: 'creator-2',
        username: 'creator-two',
        name: 'Creator Two',
        avatar: null,
      },
      isSaved: false,
      sourceKind: 'magicbooklet' as const,
      sourceTool: null,
      generationId: 'video-1',
      asset: null,
      canRemix: true,
    };
    const motionItem = {
      id: 'motion-1',
      mediaUrl: 'https://example.com/motion.mp4',
      mediaKind: 'video' as const,
      model: 'kling-3.0',
      title: 'Motion Preview',
      prompt: 'Motion prompt',
      body: '',
      category: 'motion' as const,
      postFormat: 'media' as const,
      saveCount: 4,
      remixCount: 1,
      createdAt: '2026-04-01T00:00:00.000Z',
      creator: {
        id: 'creator-3',
        username: 'creator-three',
        name: 'Creator Three',
        avatar: null,
      },
      isSaved: false,
      sourceKind: 'magicbooklet' as const,
      sourceTool: null,
      generationId: 'motion-1',
      asset: null,
      canRemix: true,
    };

    getServerAuthStateMock.mockResolvedValue({
      session: {
        user: { id: 'user-1' },
      },
      credits: 12,
    });

    getShowcaseFeedPageMock.mockImplementation(async (options?: { category?: string }) => {
      const category = options?.category ?? 'all';

      if (category === 'image') {
        return { items: [imageItem] };
      }

      if (category === 'video') {
        return { items: [videoItem] };
      }

      if (category === 'motion') {
        return { items: [motionItem] };
      }

      return {
        items: [imageItem, videoItem, motionItem],
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses one full-card link for each creator path on the home page', async () => {
    render(await Home());

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

    const videoCardLink = screen.getByText('Create Video').closest('a');
    expect(within(videoCardLink as HTMLAnchorElement).getByTestId('hover-video')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /launchpad/i })).toHaveAttribute('href', '/create');
  });

  it('passes text-only showcase posts into the home inspiration grid', async () => {
    const textItem = {
      id: 'text-1',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'Prompt strategy note',
      prompt: '',
      body: 'Lead with the product benefit before adding cinematic style words.',
      category: 'text' as const,
      postFormat: 'text' as const,
      saveCount: 6,
      remixCount: 0,
      createdAt: '2026-04-01T00:00:00.000Z',
      creator: {
        id: 'creator-4',
        username: 'creator-four',
        name: 'Creator Four',
        avatar: null,
      },
      isSaved: false,
      sourceKind: 'manual' as const,
      sourceTool: null,
      generationId: null,
      asset: null,
      canRemix: false,
    };

    getShowcaseFeedPageMock.mockImplementation(async (options?: { category?: string }) => {
      const category = options?.category ?? 'all';
      return category === 'all' ? { items: [textItem] } : { items: [] };
    });

    render(await Home());

    expect(screen.getByTestId('home-showcase-preview-grid')).toHaveAttribute('data-count', '1');
    expect(homeShowcasePreviewGridMock.mock.calls[0]?.[0]).toMatchObject({
      items: [textItem],
    });
  });

  it('loads homepage showcase content without blocking on server auth', async () => {
    getServerAuthStateMock.mockImplementation(() => {
      throw new Error('Home should not read server auth for cacheable public content');
    });

    render(await Home());

    expect(getServerAuthStateMock).not.toHaveBeenCalled();
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: null,
      countryCode: null,
    }));
    expect(homeShowcasePreviewGridMock.mock.calls[0]?.[0]).toMatchObject({
      initialSession: null,
      initialCredits: null,
    });
  });

  it('keeps the cacheable homepage renderable when showcase content is unavailable', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getShowcaseFeedPageMock.mockRejectedValue(new Error('Supabase host unavailable during build'));

    render(await Home());

    expect(screen.getByText(/What will you create/i)).toBeInTheDocument();
    expect(screen.getByText(/Could not load the creator feed/i)).toBeInTheDocument();
    expect(screen.queryByTestId('home-showcase-preview-grid')).not.toBeInTheDocument();
    expect(homeShowcasePreviewGridMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to load homepage showcase content:',
      expect.any(Error)
    );
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
