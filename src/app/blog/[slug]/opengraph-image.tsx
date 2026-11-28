import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';

import { getSortedPostsData } from '@/lib/blog';
import { siteConfig } from '@/lib/seo';

/**
 * A social card per article.
 *
 * Every post shared the site-wide card, so four different articles produced four
 * identical previews in a feed or a chat — the least informative thing a shared
 * link can do. Drawn rather than fetched: no network at render, no font
 * download, nothing that can fail after deploy.
 *
 * Brand treatment is deliberately minimal and matches the product's own dark
 * surface: the brand's icon (the app icon, the file the site's BrandMark draws)
 * beside the wordmark. The wordmark is `siteConfig.name` so it cannot drift from
 * the brand spelling used everywhere else.
 */

/**
 * The icon as a data URL, read from disk once, as Next's docs read a local
 * image for a card. A card whose icon cannot be read keeps the orange dot it
 * had before, rather than failing.
 */
const brandIconSrc = await readFile(join(process.cwd(), 'src/components/brand/magic-booklet-icon.png'), 'base64')
    .then((data) => `data:image/png;base64,${data}`)
    .catch(() => null);

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = `${siteConfig.name} article`;

export function generateStaticParams() {
    return getSortedPostsData().map((post) => ({ slug: post.slug }));
}

export default async function OpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const post = getSortedPostsData().find((entry) => entry.slug === slug);
    const title = post?.title ?? siteConfig.name;
    // Long titles need to step down a size or they wrap past the card.
    const titleSize = title.length > 68 ? 58 : title.length > 44 ? 68 : 80;

    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    backgroundColor: '#0b0c10',
                    padding: '72px 80px',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    {brandIconSrc ? (
                        // A card is an image drawn on the server: next/image has no place here.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={brandIconSrc} width={48} height={48} alt="" style={{ borderRadius: 12 }} />
                    ) : (
                        <div
                            style={{
                                width: 14,
                                height: 14,
                                borderRadius: 999,
                                backgroundColor: '#ff7a59',
                            }}
                        />
                    )}
                    {/*
                        Rendered exactly as the brand is written — lowercase, one
                        word. No textTransform here: the wordmark is lowercase
                        everywhere else in the product, and an uppercased card
                        would be the only place it is not.
                    */}
                    <div
                        style={{
                            color: '#ff7a59',
                            fontSize: 30,
                            fontWeight: 700,
                            letterSpacing: 2,
                        }}
                    >
                        {siteConfig.name}
                    </div>
                </div>

                <div
                    style={{
                        display: 'flex',
                        color: '#f4f4f5',
                        fontSize: titleSize,
                        fontWeight: 800,
                        lineHeight: 1.1,
                        letterSpacing: -2,
                        maxWidth: 1000,
                    }}
                >
                    {title}
                </div>

                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        color: '#8b8b93',
                        fontSize: 26,
                    }}
                >
                    <div style={{ display: 'flex' }}>magicbooklet.com/blog</div>
                    {post?.date ? (
                        <div style={{ display: 'flex' }}>
                            {new Date(post.date).toLocaleDateString('en-US', {
                                month: 'long',
                                year: 'numeric',
                            })}
                        </div>
                    ) : null}
                </div>
            </div>
        ),
        size
    );
}
