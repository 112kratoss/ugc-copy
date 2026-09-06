import { getPostData, getSortedPostsData } from '@/lib/blog';
import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calendar } from 'lucide-react';

import { JsonLd } from '@/app/components/JsonLd';
import { buildArticleSchema, createMetadata, siteConfig } from '@/lib/seo';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const resolvedParams = await params;
    try {
        const post = await getPostData(resolvedParams.slug);
        // Every post's `coverImage` is the site-wide card, so passing it made
        // four different articles share one preview — and an explicit
        // `openGraph.images` also suppresses the generated per-article card in
        // `opengraph-image.tsx`. Only a genuinely distinct cover is passed
        // through now; anything else falls through to the generated one.
        const hasDistinctCover = Boolean(
            post.coverImage && post.coverImage !== siteConfig.ogImage
        );

        return createMetadata({
            title: post.seoTitle ?? post.title,
            absoluteTitle: post.seoTitle,
            description: post.seoDescription ?? post.excerpt,
            path: `/blog/${resolvedParams.slug}`,
            // null hands the card to `opengraph-image.tsx` for this route.
            image: hasDistinctCover ? post.coverImage : null,
            type: 'article',
            publishedTime: post.date,
            modifiedTime: post.date,
        });
    } catch {
        return { title: 'Post Not Found' };
    }
}

export async function generateStaticParams() {
    const posts = getSortedPostsData();
    return posts.map((post) => ({
        slug: post.slug,
    }));
}

async function getPost(slug: string) {
    try {
        return await getPostData(slug);
    } catch {
        notFound();
    }
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
    const resolvedParams = await params;
    const post = await getPost(resolvedParams.slug);

    if (!post) notFound();

    return (
        <div className="min-h-screen bg-black text-white py-24 px-6 md:px-12">
            <article className="max-w-3xl mx-auto">
                <JsonLd
                    data={buildArticleSchema({
                        path: `/blog/${resolvedParams.slug}`,
                        title: post.seoTitle ?? post.title,
                        description: post.seoDescription ?? post.excerpt,
                        publishedTime: post.date,
                        modifiedTime: post.date,
                        image: post.coverImage,
                    })}
                />
                <Link href="/blog" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-12">
                    <ArrowLeft className="w-4 h-4" /> Back to Blog
                </Link>

                <header className="mb-12">
                    <div className="mb-6 flex items-center gap-2 text-sm text-[var(--ui-primary)]">
                        <Calendar className="w-4 h-4" />
                        <time dateTime={post.date}>{new Date(post.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
                    </div>
                    <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-6 leading-tight text-white">{post.title}</h1>
                    <p className="text-xl text-zinc-400 font-light max-w-2xl">{post.excerpt}</p>
                </header>

                <div
                    className="markdown-content text-lg"
                    dangerouslySetInnerHTML={{ __html: post.content }}
                />
            </article>
        </div>
    );
}
