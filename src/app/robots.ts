import { MetadataRoute } from 'next';

import { siteConfig } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
    const baseUrl = siteConfig.siteUrl;

    return {
        rules: {
            userAgent: '*',
            allow: '/',
            disallow: [
                '/api/',
                '/auth/',
                '/create',
                '/create-image',
                '/create-video',
                '/create-motion',
                '/create-workflow',
                '/creations',
                '/login',
            ],
        },
        sitemap: `${baseUrl}/sitemap.xml`,
        host: baseUrl,
    };
}
