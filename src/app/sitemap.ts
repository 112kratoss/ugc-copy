import { MetadataRoute } from 'next';

import { getSortedPostsData } from '@/lib/blog';
import { siteConfig } from '@/lib/seo';
import {
    getIndexableCreators,
    getIndexableShowcasePosts,
    getIndexableTemplates,
} from '@/lib/sitemap-entries';

const INDEXABLE_ROUTES: Array<{
    path: string;
    changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
    priority: number;
}> = [
    { path: '/', changeFrequency: 'weekly', priority: 1 },
    { path: '/pricing', changeFrequency: 'weekly', priority: 0.9 },
    { path: '/showcase', changeFrequency: 'daily', priority: 0.85 },
    { path: '/blog', changeFrequency: 'weekly', priority: 0.85 },
    { path: '/ai-image-generator', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/ai-video-generator', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/ai-motion-transfer', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/ai-workflow-builder', changeFrequency: 'weekly', priority: 0.8 },
    { path: '/templates', changeFrequency: 'daily', priority: 0.75 },
    { path: '/contact', changeFrequency: 'monthly', priority: 0.55 },
    { path: '/child-safety', changeFrequency: 'yearly', priority: 0.4 },
    { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
    { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
];

/**
 * Regenerated hourly rather than per request. The generated corpus changes
 * continuously, so a static sitemap goes stale immediately, but rebuilding it
 * on every crawler hit would run four unbounded queries against `posts` for a
 * file whose contents barely move minute to minute.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const baseUrl = siteConfig.siteUrl;
    const now = new Date();
    const posts = getSortedPostsData();

    // Independent reads; one round trip rather than three sequential ones. Each
    // resolves to an empty list on failure, so a database problem degrades the
    // sitemap to its static routes instead of failing the response.
    const [showcasePosts, creators, templates] = await Promise.all([
        getIndexableShowcasePosts(),
        getIndexableCreators(),
        getIndexableTemplates(),
    ]);

    return [
        ...INDEXABLE_ROUTES.map((route) => ({
            url: `${baseUrl}${route.path === '/' ? '' : route.path}`,
            lastModified: now,
            changeFrequency: route.changeFrequency,
            priority: route.priority,
        })),
        ...posts.map((post) => ({
            url: `${baseUrl}/blog/${post.slug}`,
            lastModified: new Date(post.date),
            changeFrequency: 'monthly' as const,
            priority: 0.7,
        })),
        ...showcasePosts.map((post) => ({
            url: `${baseUrl}/showcase/${post.id}`,
            lastModified: new Date(post.updated_at ?? post.created_at),
            changeFrequency: 'monthly' as const,
            priority: 0.6,
        })),
        ...creators.map((creator) => ({
            url: `${baseUrl}/creators/${creator.username}`,
            lastModified: creator.updated_at ? new Date(creator.updated_at) : now,
            changeFrequency: 'weekly' as const,
            priority: 0.5,
        })),
        ...templates.map((template) => ({
            url: `${baseUrl}/templates/${template.slug}`,
            lastModified: template.updated_at ? new Date(template.updated_at) : now,
            changeFrequency: 'weekly' as const,
            priority: 0.55,
        })),
    ];
}
