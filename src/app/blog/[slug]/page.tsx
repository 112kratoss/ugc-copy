import { getPostData, getSortedPostsData } from '@/lib/blog';
import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calendar } from 'lucide-react';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const resolvedParams = await params;
    try {
        const post = await getPostData(resolvedParams.slug);
        return {
            title: `${post.title} | UGC copy Blog`,
            description: post.excerpt,
            alternates: {
                canonical: `/blog/${resolvedParams.slug}`,
            }
        };
    } catch (e) {
        return { title: 'Post Not Found | UGC copy Blog' };
    }
}

export async function generateStaticParams() {
    const posts = getSortedPostsData();
    return posts.map((post) => ({
        slug: post.slug,
    }));
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
    const resolvedParams = await params;
    try {
        const post = await getPostData(resolvedParams.slug);

        return (
            <div className="min-h-screen bg-black text-white py-24 px-6 md:px-12">
                <article className="max-w-3xl mx-auto">
                    <Link href="/blog" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-12">
                        <ArrowLeft className="w-4 h-4" /> Back to Blog
                    </Link>

                    <header className="mb-12">
                        <div className="flex items-center gap-2 text-sm text-purple-400 mb-6">
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
    } catch (e) {
        notFound();
    }
}
