import Link from 'next/link';
import { getSortedPostsData } from '@/lib/blog';
import { Metadata } from 'next';
import { ArrowLeft, ArrowRight, Calendar } from 'lucide-react';
import { JsonLd } from '@/app/components/JsonLd';
import {
    buildBreadcrumbSchema,
    buildItemListSchema,
    createMetadata,
} from '@/lib/seo';

/**
 * The feature pages each own a topic; the index links to all of them so the
 * clusters are connected in both directions rather than only from feature page
 * to article.
 */
const TOPIC_LINKS = [
    { href: '/ai-motion-transfer', label: 'AI motion transfer' },
    { href: '/ai-video-generator', label: 'AI video generation' },
    { href: '/ai-image-generator', label: 'AI image generation' },
    { href: '/ai-workflow-builder', label: 'AI workflows' },
];

export const metadata: Metadata = createMetadata({
    title: 'Blog',
    description:
        'Read tutorials, comparisons, and tactical guides for AI image generation, AI video creation, motion transfer, and high-converting UGC ads.',
    path: '/blog',
});

export default function BlogIndex() {
    const posts = getSortedPostsData();

    return (
        <div className="min-h-screen bg-black text-white py-24 px-6 md:px-12">
            <JsonLd
                data={[
                    buildItemListSchema(
                        'magicbooklet blog',
                        '/blog',
                        posts.map((post) => ({ name: post.title, path: `/blog/${post.slug}` }))
                    ),
                    buildBreadcrumbSchema([
                        { name: 'Home', path: '/' },
                        { name: 'Blog', path: '/blog' },
                    ]),
                ]}
            />
            <div className="max-w-4xl mx-auto space-y-12">
                <div className="space-y-4">
                    <Link href="/" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-4">
                        <ArrowLeft className="w-4 h-4" /> Back to Home
                    </Link>
                    <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Blog & Resources</h1>
                    <p className="text-xl text-zinc-400">Insights, tutorials, and strategies for creating high-converting UGC.</p>
                    <p className="max-w-2xl leading-relaxed text-zinc-400">
                        Practical guides to producing ad creative with AI — choosing between motion
                        transfer and text-to-video, writing prompts that behave like shot lists,
                        building persona libraries, and turning a result that worked once into a
                        workflow that runs again.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                        <span className="text-sm text-zinc-500">Topics:</span>
                        {TOPIC_LINKS.map((topic) => (
                            <Link
                                key={topic.href}
                                href={topic.href}
                                className="ui-focus-ring rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-3 py-1 text-sm text-zinc-300 transition-colors hover:border-[var(--ui-primary)]/40 hover:text-white"
                            >
                                {topic.label}
                            </Link>
                        ))}
                    </div>
                </div>

                <div className="grid gap-8">
                    {posts.map((post) => (
                        <Link key={post.slug} href={`/blog/${post.slug}`} className="group block">
                            <article className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-8 transition-all hover:border-[var(--ui-primary)]/30 hover:bg-[var(--ui-surface-raised)]">
                                <div className="flex items-center gap-2 text-sm text-zinc-500 mb-3">
                                    <Calendar className="w-4 h-4" />
                                    <time dateTime={post.date}>{new Date(post.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
                                </div>
                                <h2 className="mb-3 text-2xl font-semibold transition-colors group-hover:text-[var(--ui-primary-strong)]">{post.title}</h2>
                                <p className="text-zinc-400 leading-relaxed max-w-2xl mb-6">{post.excerpt}</p>
                                <div className="inline-flex items-center gap-2 font-medium text-[var(--ui-primary)]">
                                    Read Article <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                </div>
                            </article>
                        </Link>
                    ))}
                    {posts.length === 0 && (
                        <div className="text-zinc-500 py-12 text-center border border-dashed border-zinc-800 rounded-3xl">
                            No posts published yet. Check back soon!
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
