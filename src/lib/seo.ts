import type { Metadata } from 'next';

type CreateMetadataOptions = {
    title: string;
    description: string;
    path: string;
    absoluteTitle?: string;
    keywords?: string[];
    type?: 'website' | 'article';
    image?: string;
    noIndex?: boolean;
    publishedTime?: string;
    modifiedTime?: string;
};

type SoftwareApplicationSchemaOptions = {
    name: string;
    path: string;
    description: string;
    applicationCategory?: string;
    featureList?: string[];
    offers?: Array<{
        name: string;
        price: number;
        priceCurrency: string;
        url?: string;
    }>;
};

type ArticleSchemaOptions = {
    path: string;
    title: string;
    description: string;
    publishedTime: string;
    modifiedTime?: string;
    image?: string;
};

const fallbackSiteUrl = 'https://magicbooklet.com';
const legacySiteHosts = new Set([
    'emptybooklet.com',
    'www.emptybooklet.com',
    'ugccreator.com',
    'www.ugccreator.com',
    'ugccopy.com',
    'www.ugccopy.com',
    'ugc-app.vercel.app',
]);

function resolveSiteUrl() {
    const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (!envUrl) {
        return fallbackSiteUrl;
    }

    try {
        const parsed = new URL(envUrl);
        if (legacySiteHosts.has(parsed.hostname)) {
            return fallbackSiteUrl;
        }

        return parsed.toString().replace(/\/$/, '');
    } catch {
        return fallbackSiteUrl;
    }
}

export const siteConfig = {
    name: 'magicbooklet',
    title: 'magicbooklet',
    defaultTitle: 'magicbooklet: AI UGC Ad Generator & Motion Transfer',
    description:
        'Create AI images, videos, motion-transfer UGC ads, and reusable content workflows in one production-ready studio.',
    siteUrl: resolveSiteUrl(),
    ogImage: '/opengraph-image.png',
    supportEmail: 'support@magicbooklet.com',
    helloEmail: 'hello@magicbooklet.com',
    privacyEmail: 'privacy@magicbooklet.com',
    googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || undefined,
};

export function absoluteUrl(path = '/') {
    return new URL(path, `${siteConfig.siteUrl}/`).toString();
}

function resolveTitle(title: string, absoluteTitle?: string) {
    if (absoluteTitle) {
        return absoluteTitle;
    }

    if (title === siteConfig.name) {
        return title;
    }

    return `${title} | ${siteConfig.name}`;
}

export const noIndexRobots: NonNullable<Metadata['robots']> = {
    index: false,
    follow: true,
    googleBot: {
        index: false,
        follow: true,
    },
};

export function createMetadata({
    title,
    description,
    path,
    absoluteTitle,
    keywords,
    type = 'website',
    image = siteConfig.ogImage,
    noIndex = false,
    publishedTime,
    modifiedTime,
}: CreateMetadataOptions): Metadata {
    const fullTitle = resolveTitle(title, absoluteTitle);
    const metadataTitle = absoluteTitle || title === siteConfig.name
        ? { absolute: fullTitle }
        : title;

    return {
        title: metadataTitle,
        description,
        keywords,
        alternates: {
            canonical: path,
        },
        robots: noIndex ? noIndexRobots : undefined,
        openGraph: {
            title: fullTitle,
            description,
            url: path,
            siteName: siteConfig.name,
            type,
            images: [
                {
                    url: image,
                    width: 1200,
                    height: 630,
                    alt: `${siteConfig.name} preview`,
                },
            ],
            ...(type === 'article'
                ? {
                    publishedTime,
                    modifiedTime,
                }
                : {}),
        },
        twitter: {
            card: 'summary_large_image',
            title: fullTitle,
            description,
            images: [image],
        },
    };
}

export function createNoIndexMetadata(title: string, description: string): Metadata {
    return {
        title,
        description,
        robots: noIndexRobots,
    };
}

export function buildOrganizationSchema() {
    return {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: siteConfig.name,
        url: siteConfig.siteUrl,
        logo: absoluteUrl('/icon.png'),
        email: siteConfig.supportEmail,
    };
}

export function buildSoftwareApplicationSchema({
    name,
    path,
    description,
    applicationCategory = 'BusinessApplication',
    featureList,
    offers,
}: SoftwareApplicationSchemaOptions) {
    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name,
        applicationCategory,
        operatingSystem: 'Web',
        url: absoluteUrl(path),
        description,
        ...(featureList && featureList.length > 0 ? { featureList } : {}),
        ...(offers && offers.length > 0
            ? {
                offers: offers.map((offer) => ({
                    '@type': 'Offer',
                    name: offer.name,
                    price: offer.price,
                    priceCurrency: offer.priceCurrency,
                    availability: 'https://schema.org/InStock',
                    url: absoluteUrl(offer.url ?? '/pricing'),
                })),
            }
            : {}),
    };
}

export function buildArticleSchema({
    path,
    title,
    description,
    publishedTime,
    modifiedTime,
    image = siteConfig.ogImage,
}: ArticleSchemaOptions) {
    return {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: title,
        description,
        datePublished: publishedTime,
        dateModified: modifiedTime ?? publishedTime,
        author: {
            '@type': 'Organization',
            name: siteConfig.name,
        },
        publisher: {
            '@type': 'Organization',
            name: siteConfig.name,
            logo: {
                '@type': 'ImageObject',
                url: absoluteUrl('/icon.png'),
            },
        },
        mainEntityOfPage: absoluteUrl(path),
        image: absoluteUrl(image),
    };
}
