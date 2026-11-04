import type { MetadataRoute } from 'next';

import { siteConfig } from '@/lib/seo';

/**
 * Crawlers that cost renders and bring no visitors: the SEO tools' indexes
 * (Semrush, Ahrefs, Majestic's MJ12bot, Moz's DotBot) and two search engines
 * whose markets send nobody here (Huawei's PetalBot, Baidu). Each obeys its own
 * group alone, so `Disallow: /` keeps it off the whole site. Search engines,
 * link previews and AI assistants' crawlers (Googlebot, Bingbot, Applebot,
 * facebookexternalhit, ClaudeBot, GPTBot) read the `*` group: the product
 * wants to be found.
 */
const BLOCKED_CRAWLERS = [
    'SemrushBot',
    'AhrefsBot',
    'PetalBot',
    'MJ12bot',
    'DotBot',
    'Baiduspider',
];

export default function robots(): MetadataRoute.Robots {
    const baseUrl = siteConfig.siteUrl;

    return {
        rules: [
            {
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
                    // Internal rewrite target for signed-in `/` (middleware
                    // redirects direct hits back to `/`); never index it.
                    '/home',
                    '/login',
                    // Every filtered, sorted or searched list renders on request
                    // (it reads its query and the visitor's country), and each
                    // card links back to one: crawlers walked thousands a week.
                    // `/marketplace` itself stays open, as do the recipe pages.
                    '/marketplace?',
                    // Results render on request and carry noindex.
                    '/search',
                ],
            },
            {
                userAgent: BLOCKED_CRAWLERS,
                disallow: '/',
            },
        ],
        sitemap: `${baseUrl}/sitemap.xml`,
        host: baseUrl,
    };
}
