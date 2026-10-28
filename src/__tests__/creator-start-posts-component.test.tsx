import type { ComponentPropsWithoutRef } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Video } from 'lucide-react';

import { CreatorEmptyCanvas, CreatorStartPostsStrip, CreatorWhileYouWait } from '@/components/CreatorStartPosts';
import type { CreatorStartPost, StartPostRemixForecast } from '@/lib/creator-start-posts';

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));

// The clip player's own playback is not under test: whether one is mounted is.
vi.mock('@/components/HoverVideo', () => ({
  HoverVideo: ({ src }: { src: string }) => <video data-testid="clip" data-src={src} />,
}));

// next/image needs the Next runtime; the poster's own markup is not under test.
vi.mock('@/components/OptimizedPreviewImage', () => ({
  OptimizedPreviewImage: ({ previewSrc }: { previewSrc: string }) => <span data-testid="poster" data-src={previewSrc} />,
}));

/**
 * "Start from a post" and "While you wait" (owner, 2026-10-28; artboards Main and
 * Generating): the shelf's posts on the creator pages, each Remix priced on the balance.
 */

const FORECAST: StartPostRemixForecast = {
  original: { modelId: 'kling-3.0-video', cost: 42, durationSeconds: 5 },
  candidates: [{ modelId: 'seedance-2-mini', cost: 19, durationSeconds: 5, takesInputs: true }],
  shorter: null,
  preferredModelId: 'seedance-2-mini',
  modelNames: { 'seedance-2-mini': 'Seedance 2 Mini' },
};

function post(id: string, overrides: Partial<CreatorStartPost> = {}): CreatorStartPost {
  return {
    kind: 'creation',
    id,
    title: `Post ${id}`,
    tool: 'video',
    posterUrl: `https://cdn.example/${id}.webp`,
    posterThumbhash: null,
    clipUrl: null,
    modelName: 'Kling 3.0 Cinematic',
    price: { kind: 'credits', credits: 42 },
    fitsWelcomeCredits: false,
    badge: null,
    creator: { id: 'creator-1', username: 'fluffy', name: 'Fluffy' },
    makeHref: `/create-video?remix=gen-${id}&remixPost=${id}`,
    remix: FORECAST,
    ...overrides,
  };
}

const IMAGE = post('giraffe', { tool: 'image', modelName: 'Nano Banana 2.0', price: { kind: 'credits', credits: 8 }, remix: null, makeHref: '/create-image?remix=gen-g&remixPost=giraffe' });
const FRAME = <div data-testid="empty-frame">Your video will appear here</div>;

async function renderSettled(element: React.ReactElement) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(element);
  });
  return view;
}

describe('the empty canvas\'s start posts', () => {
  it('lists the shelf\'s posts, the creator\'s own tool first, each Remix priced on the balance', async () => {
    await renderSettled(
      <CreatorEmptyCanvas
        source={Promise.resolve([IMAGE, post('cats')])}
        tool="video"
        balance={25}
        icon={Video}
        title="Your video will appear here"
        hint="Write a prompt, then Generate. Or remix a post below."
        frame={FRAME}
      />,
    );

    const section = screen.getByRole('region', { name: 'Start from a post' });
    const titles = within(section).getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/showcase/'));
    expect(titles.map((link) => link.getAttribute('href'))).toEqual(['/showcase/cats', '/showcase/giraffe']);
    // Fitted to the 25 credits: Seedance 2 Mini first, at 19.
    const remixCats = within(section).getByRole('link', { name: 'Remix “Post cats” by @fluffy on Seedance 2 Mini, 19 credits' });
    expect(remixCats).toHaveTextContent('Remix · 19');
    expect(remixCats).toHaveAttribute('href', '/create-video?remix=gen-cats&remixPost=cats');
    expect(within(section).getByText('On Seedance 2 Mini')).toBeInTheDocument();
    // An image keeps its own price, and opens its own creator.
    expect(within(section).getByRole('link', { name: 'Remix “Post giraffe” by @fluffy, 8 credits' }))
      .toHaveAttribute('href', '/create-image?remix=gen-g&remixPost=giraffe');
    expect(within(section).getByRole('link', { name: 'See all in Explore' })).toHaveAttribute('href', '/showcase');
    expect(screen.getByRole('link', { name: 'Browse templates' })).toHaveAttribute('href', '/templates');
  });

  it('opens on the original where the balance covers it', async () => {
    await renderSettled(
      <CreatorEmptyCanvas source={Promise.resolve([post('cats')])} tool="video" balance={50} icon={Video} title="t" hint="h" frame={FRAME} />,
    );
    expect(screen.getByRole('link', { name: 'Remix “Post cats” by @fluffy, 42 credits' })).toHaveTextContent('Remix · 42');
    expect(screen.queryByText(/^On /)).not.toBeInTheDocument();
  });

  it('keeps the frame alone where the shelf has no posts, and for a remix', async () => {
    const view = await renderSettled(
      <CreatorEmptyCanvas source={Promise.resolve([])} tool="video" balance={25} icon={Video} title="t" hint="h" frame={FRAME} />,
    );
    expect(screen.getByTestId('empty-frame')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start from a post' })).not.toBeInTheDocument();
    view.unmount();

    await renderSettled(<CreatorEmptyCanvas source={null} tool="video" balance={25} icon={Video} title="t" hint="h" frame={FRAME} />);
    expect(screen.getByTestId('empty-frame')).toBeInTheDocument();
  });
});

describe('the posts the page could not get', () => {
  // A stream cut off on the way rejects the posts: each place draws what it draws without them.
  it('leaves the empty canvas its frame, and the strip and the posts to watch nothing', async () => {
    const lost = () => Promise.reject(new Error('Connection closed.'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await renderSettled(
        <>
          <CreatorEmptyCanvas source={lost()} tool="video" balance={25} icon={Video} title="t" hint="h" frame={FRAME} />
          <CreatorStartPostsStrip source={lost()} tool="video" balance={25} />
          <CreatorWhileYouWait source={lost()} tool="video" />
        </>,
      );
    } finally {
      errors.mockRestore();
    }
    expect(screen.getByTestId('empty-frame')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Start from a post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'While you wait' })).not.toBeInTheDocument();
  });
});

describe('a post\'s clip', () => {
  const reducedMotion = window.matchMedia;
  afterEach(() => {
    window.matchMedia = reducedMotion;
  });

  const clipPost = post('cats', { clipUrl: 'https://cdn.example/cats.mp4' });
  const card = () => screen.getByRole('link', { name: 'Post cats, by @fluffy' }).closest('li')!;

  it('plays under a pointer, and is never fetched for a finger on its way to a link', async () => {
    await renderSettled(<CreatorWhileYouWait source={Promise.resolve([clipPost])} tool="video" />);
    fireEvent.pointerEnter(card(), { pointerType: 'touch' });
    expect(screen.queryByTestId('clip')).not.toBeInTheDocument();
    fireEvent.pointerEnter(card(), { pointerType: 'mouse' });
    expect(screen.getByTestId('clip')).toHaveAttribute('data-src', 'https://cdn.example/cats.mp4');
    fireEvent.pointerLeave(card(), { pointerType: 'mouse' });
    expect(screen.queryByTestId('clip')).not.toBeInTheDocument();
  });

  it('stays still for a viewer who asked for less motion, its play mark kept', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    await renderSettled(<CreatorWhileYouWait source={Promise.resolve([clipPost])} tool="video" />);
    fireEvent.pointerEnter(card(), { pointerType: 'mouse' });
    expect(screen.queryByTestId('clip')).not.toBeInTheDocument();
    expect(card().querySelector('svg.lucide-play')).not.toBeNull();
  });
});

describe('the column\'s strip of start posts', () => {
  it('holds the posts\' places while they come, so the prompt under it does not move', async () => {
    await renderSettled(<CreatorStartPostsStrip source={new Promise(() => {})} tool="video" balance={25} />);
    const strip = screen.getByRole('region', { name: 'Start from a post' });
    expect(strip.querySelector('ul[aria-hidden]')).not.toBeNull();
    expect(within(strip).queryByRole('link', { name: /^Remix/ })).not.toBeInTheDocument();
  });

  it('shows the posts with the price alone on each Remix, and nothing where there are none', async () => {
    const view = await renderSettled(<CreatorStartPostsStrip source={Promise.resolve([post('cats')])} tool="video" balance={25} />);
    const strip = screen.getByRole('region', { name: 'Start from a post' });
    expect(within(strip).getByRole('link', { name: /^Remix “Post cats”/ })).toHaveTextContent(/^Remix · 19$/);
    view.unmount();

    const empty = await renderSettled(<CreatorStartPostsStrip source={Promise.resolve([])} tool="video" balance={25} />);
    expect(empty.container).toBeEmptyDOMElement();
  });
});

describe('the posts to watch while a run works', () => {
  it('lists the posts to open, with no Remix under them', async () => {
    await renderSettled(<CreatorWhileYouWait source={Promise.resolve([post('cats')])} tool="video" />);
    const section = screen.getByRole('region', { name: 'While you wait' });
    expect(within(section).getByRole('link', { name: /Post cats/ })).toHaveAttribute('href', '/showcase/cats');
    expect(within(section).queryByRole('link', { name: /^Remix/ })).not.toBeInTheDocument();
  });
});
