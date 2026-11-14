import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    templates: vi.fn(),
}));

vi.mock('@/lib/sitemap-entries', () => ({
    getIndexableShowcasePosts: async () => [],
    getIndexableCreators: async () => [],
    getIndexableTemplates: () => mocks.templates(),
}));

vi.mock('@/lib/model-pages', () => ({
    listPublicModels: async () => [],
    toModelSlug: (id: string) => id,
}));

vi.mock('@/lib/blog', () => ({
    getSortedPostsData: () => [],
}));

import sitemap from '@/app/sitemap';
import { DEFAULT_APP_STORE_URL, DEFAULT_PLAY_STORE_URL } from '@/lib/app-store-links';
import { buildOrganizationSchema, buildSoftwareApplicationSchema, siteConfig } from '@/lib/seo';

async function sitemapPaths() {
    return (await sitemap()).map((entry) => entry.url.replace(siteConfig.siteUrl, '') || '/');
}

describe('sitemap routes (SEO audit, 2026-11-13)', () => {
    beforeEach(() => {
        mocks.templates.mockReset();
        mocks.templates.mockResolvedValue([]);
    });

    it('lists the marketplace', async () => {
        expect(await sitemapPaths()).toContain('/marketplace');
    });

    // "/templates" showed "No templates are live yet" while the sitemap asked
    // for it daily at priority 0.75.
    it('leaves the templates catalog out while no template is live', async () => {
        expect(await sitemapPaths()).not.toContain('/templates');
    });

    it('lists the templates catalog and each template once one is live', async () => {
        mocks.templates.mockResolvedValue([{ slug: 'product-reveal', updated_at: null }]);

        const paths = await sitemapPaths();

        expect(paths).toContain('/templates');
        expect(paths).toContain('/templates/product-reveal');
    });

    // A failed read says nothing about the catalog: the page stays indexable,
    // so the sitemap keeps listing it (review of #792).
    it('keeps the templates catalog when the read fails', async () => {
        mocks.templates.mockResolvedValue(null);

        expect(await sitemapPaths()).toContain('/templates');
    });
});

describe('app schema', () => {
    // The app's store listings are where the product installs; an
    // Organization's `sameAs` is for pages about the organization itself
    // (review of #792).
    it('gives the product its store listings as install addresses', () => {
        const schema = buildSoftwareApplicationSchema({
            name: siteConfig.name,
            path: '/',
            description: 'x',
            includeMobileApps: true,
        });

        expect(schema.operatingSystem).toBe('Web, iOS, Android');
        expect(schema.installUrl).toEqual([DEFAULT_APP_STORE_URL, DEFAULT_PLAY_STORE_URL]);
    });

    it('leaves other pages\' product schema as the web app alone', () => {
        const schema = buildSoftwareApplicationSchema({ name: siteConfig.name, path: '/pricing', description: 'x' });

        expect(schema.operatingSystem).toBe('Web');
        expect(schema).not.toHaveProperty('installUrl');
    });

    it('keeps the store listings off the Organization', () => {
        expect(buildOrganizationSchema()).not.toHaveProperty('sameAs');
    });
});

describe('site name', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    // What Google prints above a result's address; it printed the domain while
    // `/` had no WebSite block (2026-11-14).
    it('names the site Magic Booklet, with the one-word spelling and the domain as fallbacks', async () => {
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com/');
        vi.resetModules();
        const { buildWebSiteSchema } = await import('@/lib/seo');

        expect(buildWebSiteSchema()).toEqual({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Magic Booklet',
            alternateName: ['Magicbooklet', 'magicbooklet.com'],
            url: 'https://magicbooklet.com/',
        });
    });
});
