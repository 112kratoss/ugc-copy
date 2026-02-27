import Link from 'next/link';
import { getSortedPostsData } from '@/lib/blog';
import { Metadata } from 'next';
import { ArrowLeft, ArrowRight, Calendar } from 'lucide-react';

export const metadata: Metadata = {
    title: 'Blog | UGC copy',
    description: 'Read the latest resources, tutorials, and updates on AI video generation and UGC creation.',
    alternates: {
        canonical: '/blog',
    }
};

export default function BlogIndex() {
    const posts = getSortedPostsData();

    return (
        <div className="min-h-screen bg-black text-white py-24 px-6 md:px-12">
            <div className="max-w-4xl mx-auto space-y-12">
                <div className="space-y-4">
                    <Link href="/" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-4">
                        <ArrowLeft className="w-4 h-4" /> Back to Home
                    </Link>
                    <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Blog & Resources</h1>
                    <p className="text-xl text-zinc-400">Insights, tutorials, and strategies for creating high-converting UGC.</p>
                </div>

                <div className="grid gap-8">
                    {posts.map((post) => (
                        <Link key={post.slug} href={`/blog/${post.slug}`} className="group block">
                            <article className="p-8 rounded-3xl bg-zinc-900/40 border border-white/5 backdrop-blur-sm transition-all hover:bg-zinc-900/80 hover:border-purple-500/30">
                                <div className="flex items-center gap-2 text-sm text-zinc-500 mb-3">
                                    <Calendar className="w-4 h-4" />
                                    <time dateTime={post.date}>{new Date(post.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</time>
                                </div>
                                <h2 className="text-2xl font-semibold mb-3 group-hover:text-purple-400 transition-colors">{post.title}</h2>
                                <p className="text-zinc-400 leading-relaxed max-w-2xl mb-6">{post.excerpt}</p>
                                <div className="inline-flex items-center gap-2 text-purple-400 font-medium">
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
