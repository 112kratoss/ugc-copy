import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { buildOrganizationSchema, siteConfig } from '@/lib/seo';

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
});

describe('organization schema', () => {
    // Ties the brand to its store listings: "Magic Booklet" collides with
    // magic-trick booklets in search, and nothing linked the two.
    it('names the App Store and Google Play listings as the same organization', () => {
        expect(buildOrganizationSchema().sameAs).toEqual([DEFAULT_APP_STORE_URL, DEFAULT_PLAY_STORE_URL]);
    });
});
