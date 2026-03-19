import { MetadataRoute } from 'next';

import { getSortedPostsData } from '@/lib/blog';

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
    { path: '/contact', changeFrequency: 'monthly', priority: 0.55 },
    { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
    { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://ugccreator.com';
    const now = new Date();
    const posts = getSortedPostsData();

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
    ];
}
