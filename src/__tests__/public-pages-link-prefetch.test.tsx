import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BlogIndex from '@/app/blog/page';
import Contact from '@/app/contact/page';
import ModelPage from '@/app/models/[slug]/page';

// Public pages whose links drew with Next's default prefetch (production, 2026-11-24): the blog
// list fetched 13-15 route payloads (about 120 KB) a view, `/contact` 11, and a link to `/pricing`
// or `/invite` is a function run for each (both are drawn per request). They prefetch on intent
// now (`IntentLink`, #886/#890): a resting mouse pointer or the keyboard's focus.

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }));
const linkProps = vi.hoisted(() => [] as Array<{ href: unknown; prefetch: unknown }>);

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/',
}));

vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children?: ReactNode }) => {
    linkProps.push({ href, prefetch });
    return <a href={href} {...rest}>{children}</a>;
  },
}));

beforeEach(() => {
  router.prefetch.mockClear();
  linkProps.length = 0;
});

afterEach(cleanup);

describe('public pages prefetch their links on intent', () => {
  it('the contact page draws every page link with prefetch off, pricing included', () => {
    render(<Contact />);
    const internal = linkProps.filter((link) => typeof link.href === 'string' && link.href.startsWith('/'));
    expect(internal.map((link) => link.href)).toEqual(expect.arrayContaining(['/pricing', '/terms', '/privacy']));
    expect(internal.filter((link) => link.prefetch !== false)).toEqual([]);
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('the blog list draws its articles with prefetch off', () => {
    render(<BlogIndex />);
    const articles = linkProps.filter((link) => typeof link.href === 'string' && link.href.startsWith('/blog/'));
    expect(articles.length).toBeGreaterThan(3);
    expect(linkProps.filter((link) => link.prefetch !== false)).toEqual([]);
    expect(router.prefetch).not.toHaveBeenCalled();
  });

  // Its Generate and See credit packs buttons open a creator and /pricing, both drawn per request.
  it('a model page draws its page links, Generate and credit packs included, with prefetch off', async () => {
    render(await ModelPage({ params: Promise.resolve({ slug: 'nano-banana-pro' }) }));
    const internal = linkProps.filter((link) => typeof link.href === 'string' && link.href.startsWith('/'));
    expect(internal.map((link) => link.href)).toEqual(expect.arrayContaining(['/pricing', '/models']));
    expect(internal.filter((link) => link.prefetch !== false)).toEqual([]);
  });
});
