import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://ugccreator.com';

    return {
        rules: {
            userAgent: '*',
            allow: '/',
            disallow: ['/creations', '/api/', '/login', '/auth/'], // private and utility routes
        },
        sitemap: `${baseUrl}/sitemap.xml`,
    };
}
