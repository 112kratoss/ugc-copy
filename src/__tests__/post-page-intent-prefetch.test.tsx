import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import IntentLink from '@/components/IntentLink';
import ShowcaseDetailActions from '@/app/showcase/[id]/ShowcaseDetailActions';

// A post page prefetched its creator's page and /create (a redirect, so a function run) for every
// view of every post, with every link in view (speed loop, 2026-11-20). They are secondary links
// most readers pass by, so they prefetch on intent now, as the side navigation's places do.

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }));
const linkProps = vi.hoisted(() => [] as Array<{ href: unknown; prefetch: unknown }>);

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/showcase/post-1',
}));

vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children?: ReactNode }) => {
    linkProps.push({ href, prefetch });
    return <a href={href} {...rest}>{children}</a>;
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: null, user: null, isLoading: false }),
}));

beforeEach(() => {
  router.prefetch.mockClear();
  linkProps.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('a link that prefetches on intent', () => {
  it('fetches nothing as it paints, and prefetches for a resting mouse pointer', () => {
    render(<IntentLink href="/creators/mira">@mira</IntentLink>);

    expect(linkProps).toEqual([{ href: '/creators/mira', prefetch: false }]);
    expect(router.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(screen.getByRole('link', { name: '@mira' }), { pointerType: 'mouse' });
    expect(router.prefetch).toHaveBeenCalledWith('/creators/mira');
  });

  it("does not prefetch for a finger, whose pointer arrives with the press", () => {
    render(<IntentLink href="/creators/mira">@mira</IntentLink>);

    fireEvent.pointerEnter(screen.getByRole('link', { name: '@mira' }), { pointerType: 'touch' });
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it("keeps the link's own handlers", () => {
    const onPointerEnter = vi.fn();
    render(<IntentLink href="/create" onPointerEnter={onPointerEnter}>Create your own</IntentLink>);

    fireEvent.pointerEnter(screen.getByRole('link', { name: 'Create your own' }), { pointerType: 'mouse' });
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(router.prefetch).toHaveBeenCalledWith('/create');
  });
});

describe("a post page's secondary links", () => {
  it('draw "View creator" and "Create your own" without a prefetch', () => {
    render(
      <ShowcaseDetailActions
        postId="post-1"
        generationId="gen-1"
        title="Sunset study"
        creatorUsername="mira"
        visibility="public"
        ownerTools={null}
        hasResourceBundle={false}
      />,
    );

    expect(screen.getByRole('link', { name: 'View creator' })).toHaveAttribute('href', '/creators/mira');
    expect(screen.getByRole('link', { name: /Create your own/ })).toHaveAttribute('href', '/create');
    expect(linkProps).toEqual(expect.arrayContaining([
      { href: '/creators/mira', prefetch: false },
      { href: '/create', prefetch: false },
    ]));
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it("draws the header's creator link as an intent link", () => {
    // The page body needs a whole post to draw; its header's creator link is read from the source.
    const body = readFileSync(join(process.cwd(), 'src/app/showcase/[id]/ShowcaseDetailBody.tsx'), 'utf8');
    expect(body).toMatch(/<IntentLink\s+href=\{`\/creators\/\$\{detail\.creator\.username\}`\}/);
    expect(body).not.toMatch(/<Link\s+href=\{`\/creators\//);
  });
});
