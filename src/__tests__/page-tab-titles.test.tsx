import type { Metadata } from 'next';
import { describe, expect, it, vi } from 'vitest';

import { getSortedPostsData } from '@/lib/blog';
import { siteConfig } from '@/lib/seo';

// The pages' own modules are not under test, only what their files name the tab.
vi.mock('@/app/post/new/NewPostClient', () => ({ default: () => null }));
vi.mock('@/app/profile/DeferredCreatorProfileCard', () => ({ default: () => null }));
vi.mock('@/app/profile/edit/ConnectedApps', () => ({ default: () => null }));
vi.mock('@/app/profile/load-owner-profile', () => ({
  loadOwnerProfile: async () => ({ initialProfile: null, loadError: null }),
}));
vi.mock('@/components/RouteAuthBoundary', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: async () => ({ session: null, credits: null }),
  getServerPublicIdentity: () => null,
}));

/**
 * The tab's title as Next draws it: a page's own title inside the root layout's template,
 * `%s | Magic Booklet` (src/app/layout.tsx), or an absolute one as it is. A page that names
 * none inherits its layout's, or the bare "Magic Booklet".
 */
function tabTitle(title: Metadata['title'] | undefined): string {
  if (typeof title === 'string') return `${title} | ${siteConfig.name}`;
  if (title && typeof title === 'object' && 'absolute' in title && title.absolute) return title.absolute;
  throw new Error(`The page names no title of its own: ${JSON.stringify(title)}`);
}

/**
 * Every page heads its tab "<its heading> | Magic Booklet", as Recipe Marketplace and Credit
 * history do. The web sweep of 2026-11-17 found four that did not: Alerts and Create post were
 * the bare "Magic Booklet", Edit profile was its layout's "Profile | Magic Booklet", and two of
 * the four blog posts were their title alone.
 */
describe('the tab titles', () => {
  it('names Alerts by its heading, kept out of search as the other inboxes are', async () => {
    const { metadata } = await import('@/app/notifications/layout');

    expect(tabTitle(metadata.title)).toBe('Alerts | Magic Booklet');
    expect(metadata.robots).toMatchObject({ index: false, googleBot: { index: false } });
  });

  it('names the composer by its heading', async () => {
    const { metadata } = await import('@/app/post/new/page');

    expect(tabTitle(metadata.title)).toBe('Create post | Magic Booklet');
    expect(metadata.robots).toMatchObject({ index: false, googleBot: { index: false } });
  });

  it('names the profile editor by its heading, not its layout\'s "Profile"', async () => {
    const { metadata } = await import('@/app/profile/edit/page');

    expect(tabTitle(metadata.title)).toBe('Edit profile | Magic Booklet');
    expect(metadata.robots).toMatchObject({ index: false, googleBot: { index: false } });
  });

  // A post's `seoTitle` chooses the words search shows, as #151 used it; it does not take the
  // brand off, which only its use as an absolute title did (two posts' seoTitle repeats their
  // title word for word, so the brand was all it changed).
  it('names every blog post by its title and the brand, in the tab and on its card', async () => {
    const { generateMetadata } = await import('@/app/blog/[slug]/page');
    const posts = getSortedPostsData();
    expect(posts.length).toBeGreaterThanOrEqual(4);

    for (const post of posts) {
      const metadata = await generateMetadata({ params: Promise.resolve({ slug: post.slug }) });
      const expected = `${post.seoTitle ?? post.title} | Magic Booklet`;

      expect(tabTitle(metadata.title), post.slug).toBe(expected);
      expect(metadata.openGraph?.title, post.slug).toBe(expected);
      expect(metadata.twitter?.title, post.slug).toBe(expected);
    }
  });
});
