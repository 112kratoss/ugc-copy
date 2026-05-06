'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Archive, ArrowLeft, CheckCircle2, Clock, Copy, Download, ExternalLink, Eye, Film, Globe, Loader2, PencilLine, RotateCcw, Share2, Trash2, UserRound, Volume2, Wand2, X, Zap } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAuth } from '@/app/components/AuthProvider';
import MediaDetailsPreviewModal, { type MediaDetailsType } from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import {
    resolveCreationWorkspaceCardState,
    type CreationWorkspaceCardState,
    type CreationWorkspaceMonetizationKind,
    type CreationWorkspacePublishBadge,
} from '@/lib/creation-workspace';
import { formatDurationShort, formatTimeAgoShort } from '@/lib/generation-timing';
import { isAudioModel, isImageModel } from '@/lib/models';
import type { ProfileApiResponse } from '@/lib/profile';
import { formatUsdCents, getPostResourceKindLabel } from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath, supportsPublicCreationSharing } from '@/lib/share';
import { supabase } from '@/lib/supabase';

interface Generation {
    id: string;
    output_url: string | null;
    output_urls?: string[] | null;
    status: string;
    created_at: string;
    completed_at?: string | null;
    duration: number | null;
    cost: number | null;
    model: string;
    category?: string | null;
    is_public?: boolean;
    title?: string | null;
    description?: string | null;
    prompt?: string | null;
    archived_at?: string | null;
    linked_post_id?: string | null;
    linked_post_title?: string | null;
    linked_post_visibility?: 'public' | 'unlisted' | 'private' | null;
    linked_post_archived_at?: string | null;
}

type FilterType = 'all' | 'images' | 'videos' | 'audio';
type WorkspaceView = 'creations' | 'posts';
type OwnerPostVisibilityFilter = 'all' | 'public' | 'unlisted' | 'private' | 'archived';

interface OwnerPost {
    id: string;
    generationId: string | null;
    visibility: 'public' | 'unlisted' | 'private';
    archivedAt: string | null;
    mediaUrl: string | null;
    mediaKind: 'image' | 'video' | null;
    title: string;
    description: string;
    prompt: string;
    body: string;
    category: 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
    postFormat: 'text' | 'media' | 'mixed';
    sourceKind: 'magicbooklet' | 'external' | 'manual';
    sourceTool: string | null;
    sourceLabel: string;
    createdAt: string;
    updatedAt: string;
    publicPath: string | null;
    ownerPath: string;
    resourcePath: string | null;
    canShare: boolean;
    bundle: {
        id: string;
        accessMode: 'free' | 'paid';
        status: 'draft' | 'published';
        priceUsdCents: number;
        salesCount: number;
        earningsUsdCents: number;
        resourceKinds: Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>;
    } | null;
}

export default function CreationsPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { session } = useAuth();
    const initialView = searchParams.get('view') === 'posts' ? 'posts' : 'creations';
    const initialPostVisibility = (() => {
        const value = searchParams.get('visibility');
        if (value === 'public' || value === 'unlisted' || value === 'private' || value === 'archived') {
            return value;
        }
        return 'all';
    })();
    const [generations, setGenerations] = useState<Generation[]>([]);
    const [posts, setPosts] = useState<OwnerPost[]>([]);
    const [profile, setProfile] = useState<ProfileApiResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [filter, setFilter] = useState<FilterType>('all');
    const [activeView, setActiveView] = useState<WorkspaceView>(initialView);
    const [postVisibilityFilter, setPostVisibilityFilter] = useState<OwnerPostVisibilityFilter>(initialPostVisibility);
    const [previewGen, setPreviewGen] = useState<Generation | null>(null);
    const [publishTarget, setPublishTarget] = useState<Generation | null>(null);
    const [shareAfterPublish, setShareAfterPublish] = useState(false);
    const [showPaidShortcutInPublishModal, setShowPaidShortcutInPublishModal] = useState(true);
    const creationsReturnPath = searchParams.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
    const buildStudioDetailPath = (postId: string, section?: string) =>
        buildShowcaseDetailPath(postId, {
            from: 'studio',
            returnTo: creationsReturnPath,
            section,
        });

    useEffect(() => {
        const nextView = searchParams.get('view') === 'posts' ? 'posts' : 'creations';
        const nextVisibility = (() => {
            const value = searchParams.get('visibility');
            if (value === 'public' || value === 'unlisted' || value === 'private' || value === 'archived') {
                return value;
            }
            return 'all';
        })();

        setActiveView(nextView);
        setPostVisibilityFilter(nextVisibility);
    }, [searchParams]);

    const fetchCreations = useCallback(async () => {
        const { data: { session: clientSession } } = await supabase.auth.getSession();
        const activeSession = clientSession ?? session;
        if (!activeSession) {
            router.push('/login');
            return;
        }

        try {
            const [generationsRes, postsRes, profileRes] = await Promise.all([
                fetch('/api/generations?includeArchived=true', {
                    headers: { 'Authorization': `Bearer ${activeSession.access_token}` },
                }),
                fetch('/api/posts?scope=owner&includeArchived=true', {
                    headers: { 'Authorization': `Bearer ${activeSession.access_token}` },
                }),
                fetch('/api/profile', {
                    headers: { 'Authorization': `Bearer ${activeSession.access_token}` },
                }),
            ]);

            const generationsData = await generationsRes.json();
            if (generationsRes.ok) {
                setGenerations(generationsData.generations || []);
            }

            const postsData = await postsRes.json();
            if (postsRes.ok) {
                setPosts(postsData.posts || []);
            }

            if (profileRes.ok) {
                setProfile(await profileRes.json());
            } else {
                setProfile(null);
            }
        } catch (err) {
            console.error('Failed to fetch creations:', err);
        } finally {
            setIsLoading(false);
        }
    }, [router, session]);

    useEffect(() => {
        void fetchCreations();

        const intervalId = window.setInterval(() => {
            if (document.visibilityState === 'hidden') {
                return;
            }

            void fetchCreations();
        }, 30000);

        return () => {
            window.clearInterval(intervalId);
        };
    }, [fetchCreations]);

    const openPublishModal = (generation: Generation, options?: { shareAfterPublish?: boolean; showPaidShortcut?: boolean }) => {
        setPublishTarget(generation);
        setShareAfterPublish(Boolean(options?.shareAfterPublish));
        setShowPaidShortcutInPublishModal(options?.showPaidShortcut ?? true);
    };

    const closePublishModal = () => {
        setPublishTarget(null);
        setShareAfterPublish(false);
        setShowPaidShortcutInPublishModal(true);
    };

    const handlePublished = () => {
        void fetchCreations();
    };

    const handleUnpublish = async (generationId: string) => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch('/api/showcase/publish', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({
                    generationId,
                    isPublic: false
                })
            });

            const data = await res.json();
            if (data.success) {
                await fetchCreations();
            }
        } catch (err) {
            console.error(err);
        }
    };

    const copyPostLink = async (path: string) => {
        try {
            await navigator.clipboard.writeText(`${window.location.origin}${path}`);
        } catch (error) {
            console.error('Failed to copy post link:', error);
        }
    };

    const handlePostArchive = async (postId: string) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations?view=posts');
            return;
        }

        const confirmed = window.confirm('Archive this post? It will disappear from public surfaces until you restore it.');
        if (!confirmed) {
            return;
        }

        try {
            const response = await fetch(`/api/posts/${postId}/archive`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to archive post.');
            }

            await fetchCreations();
            setActiveView('posts');
            setPostVisibilityFilter('archived');
        } catch (error) {
            console.error('Failed to archive post:', error);
        }
    };

    const handlePostRestore = async (postId: string) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations?view=posts&visibility=archived');
            return;
        }

        try {
            const response = await fetch(`/api/posts/${postId}/restore`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to restore post.');
            }

            await fetchCreations();
            setActiveView('posts');
            setPostVisibilityFilter('all');
        } catch (error) {
            console.error('Failed to restore post:', error);
        }
    };

    const handlePostDelete = async (postId: string) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations?view=posts');
            return;
        }

        const confirmed = window.confirm(
            'Delete this post permanently? If it has paid unlocks, you will get a second confirmation so you can still choose archive instead.'
        );
        if (!confirmed) {
            return;
        }

        try {
            let response = await fetch(`/api/posts/${postId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ force: false }),
            });
            let data = await response.json();

            if (response.status === 409 && data?.requiresForceDelete) {
                const forceConfirmed = window.confirm(
                    'This post already has paid unlocks. Archive is safer, but you can still force delete it. Do you want to continue?'
                );

                if (!forceConfirmed) {
                    return;
                }

                response = await fetch(`/api/posts/${postId}`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${session.access_token}`,
                    },
                    body: JSON.stringify({ force: true }),
                });
                data = await response.json();
            }

            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to delete post.');
            }

            await fetchCreations();
            setActiveView('posts');
        } catch (error) {
            console.error('Failed to delete post:', error);
        }
    };

    const handleGenerationArchive = async (generationId: string) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations');
            return;
        }

        const confirmed = window.confirm('Archive this creation? It will leave the active workspace until you restore it.');
        if (!confirmed) {
            return;
        }

        try {
            const response = await fetch(`/api/generations/${generationId}/archive`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to archive creation.');
            }

            await fetchCreations();
        } catch (error) {
            console.error('Failed to archive creation:', error);
        }
    };

    const handleGenerationRestore = async (generationId: string) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations');
            return;
        }

        try {
            const response = await fetch(`/api/generations/${generationId}/restore`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to restore creation.');
            }

            await fetchCreations();
        } catch (error) {
            console.error('Failed to restore creation:', error);
        }
    };

    const handleGenerationDelete = async (generationId: string) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations');
            return;
        }

        const confirmed = window.confirm(
            'Delete this raw creation from your workspace? Any linked post will stay intact, but generation-based remix linkage may stop working.'
        );
        if (!confirmed) {
            return;
        }

        try {
            const response = await fetch(`/api/generations/${generationId}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to delete creation.');
            }

            await fetchCreations();
        } catch (error) {
            console.error('Failed to delete creation:', error);
        }
    };

    const formatDate = (dateStr: string) =>
        new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

    const parseTimestampMs = (value?: string | null): number | null => {
        if (!value) {
            return null;
        }

        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    };

    const getStartedAgoLabel = (generation: Generation): string | null => {
        const startedAtMs = parseTimestampMs(generation.created_at);
        return startedAtMs === null ? null : `Started ${formatTimeAgoShort(startedAtMs)}`;
    };

    const getCompletedInLabel = (generation: Generation): string | null => {
        const startedAtMs = parseTimestampMs(generation.created_at);
        const completedAtMs = parseTimestampMs(generation.completed_at);

        if (startedAtMs === null || completedAtMs === null) {
            return null;
        }

        return `Completed in ${formatDurationShort(Math.max(0, completedAtMs - startedAtMs))}`;
    };

    const getGenerationCategory = (generation: Generation): 'image' | 'video' | 'audio' | 'motion' | 'ugc-ad' => {
        if (generation.category === 'audio' || generation.category === 'image' || generation.category === 'motion' || generation.category === 'ugc-ad') {
            return generation.category;
        }

        if (generation.category === 'video') {
            return 'video';
        }

        if (isImageModel(generation.model)) {
            return 'image';
        }

        if (isAudioModel(generation.model)) {
            return 'audio';
        }

        return 'video';
    };

    const getMediaKind = (generation: Generation): 'image' | 'video' | 'audio' => {
        const category = getGenerationCategory(generation);
        if (category === 'image') return 'image';
        if (category === 'audio') return 'audio';
        return 'video';
    };

    const inferDownloadExtension = (generation: Generation): string => {
        const mediaKind = getMediaKind(generation);
        const fallback = mediaKind === 'image' ? 'jpg' : mediaKind === 'audio' ? 'mp3' : 'mp4';
        if (!generation.output_url) return fallback;

        try {
            const pathname = new URL(generation.output_url, 'http://localhost').pathname;
            const extension = pathname.split('.').pop();
            return extension && extension.length <= 5 ? extension : fallback;
        } catch {
            return fallback;
        }
    };

    const getPreviewTitle = (generation: Generation): string => {
        if (generation.title?.trim()) {
            return generation.title.trim();
        }

        const mediaKind = getMediaKind(generation);
        const mediaLabel = mediaKind === 'audio' ? 'Audio' : mediaKind === 'image' ? 'Image' : 'Video';
        const shortDate = new Date(generation.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });

        return `${mediaLabel} · ${generation.model} · ${shortDate}`;
    };

    const getPreviewSummary = (generation: Generation): string => {
        const source = generation.description?.trim() || generation.prompt?.trim();
        if (!source) {
            const mediaKind = getMediaKind(generation);
            return `${mediaKind === 'audio' ? 'Audio' : mediaKind === 'image' ? 'Image' : 'Video'} is ready to publish, share, or turn into an unlock.`;
        }

        return source.length > 118 ? `${source.slice(0, 115).trim()}...` : source;
    };

    const getPreviewMediaType = (generation: Generation): MediaDetailsType => {
        const mediaKind = getMediaKind(generation);
        if (mediaKind === 'audio') {
            return 'audio';
        }

        return mediaKind === 'image' ? 'image' : 'video';
    };

    const isShareSupported = (generation: Generation): boolean =>
        supportsPublicCreationSharing({
            category: getGenerationCategory(generation),
            model: generation.model,
        });

    const renderShareAction = (generation: Generation, compact = false) => {
        const baseClass = compact
            ? 'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white'
            : 'flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-medium transition-all';

        if (!isShareSupported(generation)) {
            return (
                <button
                    type="button"
                    disabled
                    title="Audio creations cannot be shared publicly yet."
                    className={compact
                        ? `${baseClass} cursor-not-allowed opacity-50`
                        : `${baseClass} cursor-not-allowed border border-white/5 bg-zinc-900/50 text-zinc-500 opacity-60`}
                >
                    <Share2 className="h-4 w-4" />
                    Share unavailable
                </button>
            );
        }

        if (generation.is_public) {
            return (
                <PublicShareButton
                    generationId={generation.id}
                    title={getPreviewTitle(generation)}
                    description={generation.description ?? generation.prompt ?? null}
                    sourceSurface="my-creations"
                    accessToken={session?.access_token ?? null}
                    label="Share link"
                    className={compact
                        ? baseClass
                        : `${baseClass} border border-white/10 bg-white/[0.04] text-zinc-100 hover:border-white/20 hover:bg-white/[0.08] hover:text-white`}
                />
            );
        }

        return (
            <button
                type="button"
                onClick={() => openPublishModal(generation, { shareAfterPublish: true })}
                className={compact
                    ? `${baseClass} border border-purple-500/20 bg-purple-500/10 text-purple-100 hover:border-purple-400/40 hover:bg-purple-500/15`
                    : `${baseClass} border border-purple-500/25 bg-purple-500/10 text-purple-100 hover:border-purple-400/40 hover:bg-purple-500/15`}
            >
                <Share2 className="h-4 w-4" />
                Publish & share
            </button>
        );
    };

    const archivedGenerations = generations.filter((generation) => Boolean(generation.archived_at));
    const activeGenerations = generations.filter((generation) => !generation.archived_at);
    const successfulGenerations = activeGenerations.filter(g => g.status === 'succeeded' && g.output_url);
    const processingGenerations = activeGenerations.filter(g => g.status === 'processing' || g.status === 'waiting');
    const failedGenerations = activeGenerations.filter(g => g.status === 'failed');

    const filteredSuccessful = successfulGenerations.filter(g => {
        const mediaKind = getMediaKind(g);
        if (filter === 'images') return mediaKind === 'image';
        if (filter === 'videos') return mediaKind === 'video';
        if (filter === 'audio') return mediaKind === 'audio';
        return true;
    });

    const imageCount = successfulGenerations.filter(g => getMediaKind(g) === 'image').length;
    const videoCount = successfulGenerations.filter(g => getMediaKind(g) === 'video').length;
    const audioCount = successfulGenerations.filter(g => getMediaKind(g) === 'audio').length;
    const visiblePosts = useMemo(() => {
        if (postVisibilityFilter === 'archived') {
            return posts.filter((post) => Boolean(post.archivedAt));
        }

        if (postVisibilityFilter === 'all') {
            return posts.filter((post) => !post.archivedAt);
        }

        return posts.filter((post) => !post.archivedAt && post.visibility === postVisibilityFilter);
    }, [postVisibilityFilter, posts]);

    const successfulCreationCards = useMemo(
        () =>
            filteredSuccessful.map((generation) => ({
                generation,
                workspaceState: resolveCreationWorkspaceCardState(generation, posts),
            })),
        [filteredSuccessful, posts]
    );
    const publicProfileUsername = profile?.username?.trim() || null;
    const activePortfolioPostCount = posts.filter((post) => !post.archivedAt).length;
    const isProfileIncomplete = !profile?.displayName?.trim() || !profile?.bio?.trim() || !profile?.avatarUrl || !profile?.coverUrl;
    const shouldShowPortfolioStarter = activeView === 'creations' && !isLoading && (
        successfulGenerations.length === 0 ||
        activePortfolioPostCount === 0 ||
        isProfileIncomplete
    );

    const getPublishBadgeClass = (badge: CreationWorkspacePublishBadge): string => {
        switch (badge) {
            case 'Public':
                return 'border-sky-400/20 bg-sky-500/10 text-sky-100';
            case 'Unlisted':
                return 'border-indigo-400/20 bg-indigo-500/10 text-indigo-100';
            case 'Private':
                return 'border-violet-400/20 bg-violet-500/10 text-violet-100';
            case 'Archived':
                return 'border-amber-400/20 bg-amber-500/10 text-amber-100';
            case 'Not published':
            default:
                return 'border-white/10 bg-white/[0.04] text-zinc-200';
        }
    };

    const getMonetizationBadgeClass = (kind: CreationWorkspaceMonetizationKind): string => {
        switch (kind) {
            case 'free':
                return 'border-sky-400/20 bg-sky-500/10 text-sky-100';
            case 'paid':
                return 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100';
            case 'draft':
                return 'border-amber-400/20 bg-amber-500/10 text-amber-100';
            case 'none':
            default:
                return 'border-white/10 bg-white/[0.04] text-zinc-200';
        }
    };

    const getMonetizationBadgeLabel = (workspaceState: CreationWorkspaceCardState): string =>
        workspaceState.monetizationKind === 'paid' && workspaceState.monetizationPriceUsdCents !== null
            ? `${formatUsdCents(workspaceState.monetizationPriceUsdCents)} unlock`
            : workspaceState.monetizationLabel;

    return (
        <div className="min-h-screen bg-black text-white">
            {/* Background effects */}
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-purple-900/15 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-pink-900/10 blur-[120px] rounded-full mix-blend-screen" />
            </div>

            <div className="studio-shell relative z-10 py-8">
                {/* Header */}
                <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-4">
                        <Link href="/" className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md">
                            <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                        </Link>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">
                                My Creations
                            </h1>
                            <p className="text-sm text-zinc-500 font-medium tracking-wide">
                                {successfulGenerations.length} CREATION{successfulGenerations.length !== 1 ? 'S' : ''} TOTAL
                            </p>
                        </div>
                    </div>

                    <Link
                        href="/profile"
                        className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-zinc-200 transition-all hover:border-purple-500/40 hover:bg-purple-500/10 hover:text-white"
                    >
                        <UserRound className="h-4 w-4" />
                        Manage profile
                    </Link>
                </div>

                <div className="mb-6 flex flex-wrap items-center gap-3">
                    {([
                        { key: 'creations', label: 'Creations', description: 'Outputs, posts, and unlocks' },
                        { key: 'posts', label: 'Post Library', description: 'Owner view for posts and unlocks' },
                    ] as Array<{ key: WorkspaceView; label: string; description: string }>).map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setActiveView(tab.key)}
                            className={`rounded-full border px-4 py-2.5 text-sm font-semibold transition ${
                                activeView === tab.key
                                    ? 'border-white/20 bg-white/10 text-white'
                                    : 'border-white/8 bg-zinc-900/50 text-zinc-400 hover:border-white/14 hover:bg-zinc-800 hover:text-zinc-200'
                            }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                    <div className="text-sm text-zinc-500">
                        {activeView === 'creations'
                            ? 'Manage creations, posts, and unlocks without leaving the workspace.'
                            : 'Use Post Library for full post edits, archive state, and cleanup after publishing.'}
                    </div>
                </div>

                {shouldShowPortfolioStarter ? (
                    <section className="mb-8 rounded-[28px] border border-purple-400/15 bg-[linear-gradient(135deg,rgba(88,28,135,0.22),rgba(2,6,23,0.78)_48%,rgba(15,118,110,0.16))] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-md sm:p-6">
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
                                    <UserRound className="h-3.5 w-3.5 text-purple-200" />
                                    Portfolio setup
                                </div>
                                <h2 className="mt-4 max-w-2xl text-2xl font-semibold tracking-tight text-white">
                                    Turn the first output into a profile-ready portfolio piece.
                                </h2>
                                <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300">
                                    New creators have three jobs here: shape the profile, create proof, then publish the strongest result with an optional unlock.
                                </p>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row lg:justify-end">
                                <Link
                                    href="/profile"
                                    className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200"
                                >
                                    <UserRound className="h-4 w-4" />
                                    Set up profile
                                </Link>
                                <Link
                                    href={publicProfileUsername ? `/creators/${publicProfileUsername}` : '/profile'}
                                    className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                    {publicProfileUsername ? 'View portfolio' : 'Preview profile setup'}
                                </Link>
                            </div>
                        </div>
                        <div className="mt-5 grid gap-3 md:grid-cols-3">
                            {[
                                {
                                    title: isProfileIncomplete ? 'Finish creator identity' : 'Creator identity ready',
                                    body: 'Add a name, bio, avatar, and cover so published work feels intentional.',
                                    ready: !isProfileIncomplete,
                                },
                                {
                                    title: successfulGenerations.length > 0 ? 'Creation ready' : 'Create one proof piece',
                                    body: 'Use image, video, motion, or workflow to make the first visual result.',
                                    ready: successfulGenerations.length > 0,
                                },
                                {
                                    title: activePortfolioPostCount > 0 ? 'Portfolio has posts' : 'Publish to portfolio',
                                    body: 'Use Publish to add the result publicly, or attach a paid unlock for the reusable process.',
                                    ready: activePortfolioPostCount > 0,
                                },
                            ].map((item) => (
                                <div
                                    key={item.title}
                                    className="rounded-[22px] border border-white/8 bg-black/25 p-4"
                                >
                                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                                        <CheckCircle2 className={`h-4 w-4 ${item.ready ? 'text-emerald-300' : 'text-zinc-500'}`} />
                                        {item.title}
                                    </div>
                                    <p className="mt-2 text-sm leading-6 text-zinc-400">{item.body}</p>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}

                {/* Filter Tabs */}
                {activeView === 'creations' && !isLoading && successfulGenerations.length > 0 && (
                    <div className="flex gap-2 mb-8">
                        {([
                            { key: 'all', label: `All (${successfulGenerations.length})` },
                            { key: 'images', label: `🖼 Images (${imageCount})` },
                            { key: 'videos', label: `🎬 Videos (${videoCount})` },
                            { key: 'audio', label: `🔊 Audio (${audioCount})` },
                        ] as { key: FilterType; label: string }[]).map(tab => (
                            <button
                                key={tab.key}
                                onClick={() => setFilter(tab.key)}
                                className={`px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200 ${filter === tab.key
                                    ? 'bg-white/10 text-white border border-white/20'
                                    : 'bg-zinc-900/50 text-zinc-500 border border-white/5 hover:text-zinc-300 hover:bg-zinc-800'
                                    }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                )}

                {activeView === 'posts' && !isLoading && posts.length > 0 && (
                    <div className="mb-8 flex flex-wrap gap-2">
                        {([
                            { key: 'all', label: `All (${posts.filter((post) => !post.archivedAt).length})` },
                            { key: 'public', label: `Public (${posts.filter((post) => !post.archivedAt && post.visibility === 'public').length})` },
                            { key: 'unlisted', label: `Unlisted (${posts.filter((post) => !post.archivedAt && post.visibility === 'unlisted').length})` },
                            { key: 'private', label: `Private (${posts.filter((post) => !post.archivedAt && post.visibility === 'private').length})` },
                            { key: 'archived', label: `Archived (${posts.filter((post) => Boolean(post.archivedAt)).length})` },
                        ] as Array<{ key: OwnerPostVisibilityFilter; label: string }>).map((tab) => (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setPostVisibilityFilter(tab.key)}
                                className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                                    postVisibilityFilter === tab.key
                                        ? 'border-white/20 bg-white/10 text-white'
                                        : 'border-white/8 bg-zinc-900/50 text-zinc-400 hover:border-white/14 hover:bg-zinc-800 hover:text-zinc-200'
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                )}

                {/* Loading */}
                {isLoading && (
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6 mb-10 mt-8">
                        {[1, 2, 3, 4, 5, 6].map((i) => (
                            <div key={i} className="break-inside-avoid mb-6">
                                <SkeletonLoader className="h-48" />
                            </div>
                        ))}
                    </div>
                )}

                {/* Empty State */}
                {activeView === 'creations' && !isLoading && activeGenerations.length === 0 && archivedGenerations.length === 0 && (
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center justify-center gap-6 py-24">
                        <div className="rounded-full border border-white/5 bg-zinc-900/50 p-6">
                            <Film className="w-12 h-12 text-zinc-600" />
                        </div>
                        <div className="text-center">
                            <h2 className="mb-2 text-xl font-semibold text-zinc-200">Start your portfolio loop</h2>
                            <p className="mx-auto max-w-xl text-sm leading-6 text-zinc-400">
                                Make one strong output, publish it to your creator profile, then add an unlock when the prompt, workflow, or setup is worth sharing.
                            </p>
                        </div>
                        <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
                            {[
                                { icon: UserRound, title: 'Profile', body: 'Name, bio, avatar, cover.' },
                                { icon: Wand2, title: 'Create', body: 'Generate image, video, or motion.' },
                                { icon: Globe, title: 'Publish', body: 'Add to portfolio or attach an unlock.' },
                            ].map((item) => {
                                const Icon = item.icon;
                                return (
                                    <div key={item.title} className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-left">
                                        <Icon className="h-5 w-5 text-purple-200" />
                                        <div className="mt-3 text-sm font-semibold text-white">{item.title}</div>
                                        <p className="mt-1 text-xs leading-5 text-zinc-500">{item.body}</p>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row">
                            <Link href="/create" className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200">
                                <Wand2 className="h-4 w-4" />
                                Choose a creator tool
                            </Link>
                            <Link href="/profile" className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]">
                                <UserRound className="h-4 w-4" />
                                Set up profile
                            </Link>
                        </div>
                    </motion.div>
                )}

                {/* Processing */}
                {activeView === 'creations' && processingGenerations.length > 0 && (
                    <div className="mb-10">
                        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                                <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-yellow-400/80">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Processing ({processingGenerations.length})
                                </h2>
                                <p className="mt-2 max-w-2xl text-sm text-zinc-500">
                                    Longer provider queues keep running in the background. Each card shows when the run started, and finished outputs move into Completed automatically.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => void fetchCreations()}
                                className="inline-flex items-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                            >
                                <Loader2 className="h-3.5 w-3.5" />
                                Refresh now
                            </button>
                        </div>
                        <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                            {processingGenerations.map((gen, i) => (
                                <motion.div key={gen.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                                    className="bg-white/[0.02] rounded-2xl border border-yellow-500/20 overflow-hidden backdrop-blur-md break-inside-avoid mb-6">
                                    <div className="aspect-video bg-black/60 flex items-center justify-center">
                                        <div className="flex flex-col items-center gap-3">
                                            <Loader2 className="w-8 h-8 text-yellow-400 animate-spin" />
                                            <span className="text-xs text-zinc-400">{getStartedAgoLabel(gen) ?? 'Still processing in background...'}</span>
                                        </div>
                                    </div>
                                    <div className="p-4 flex items-center justify-between gap-3">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        <span className="text-xs text-zinc-500">{getStartedAgoLabel(gen) ?? 'Processing'}</span>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Successful Creations */}
                {activeView === 'creations' && filteredSuccessful.length > 0 && (
                    <div className="mb-10">
                        {processingGenerations.length > 0 && (
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Completed</h2>
                        )}
                        <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                            {successfulCreationCards.map(({ generation: gen, workspaceState }, i) => {
                                const mediaKind = getMediaKind(gen);
                                const isImage = mediaKind === 'image';
                                const isAudio = mediaKind === 'audio';
                                const imageOutputs = isImage
                                    ? (Array.isArray(gen.output_urls) && gen.output_urls.length > 0 ? gen.output_urls : (gen.output_url ? [gen.output_url] : []))
                                    : [];
                                const canManageFromCreation = !isAudio && isShareSupported(gen);
                                const completedInLabel = getCompletedInLabel(gen);
                                const badgeClass = isImage
                                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                                    : isAudio
                                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                        : 'bg-purple-500/20 text-purple-300 border border-purple-500/30';
                                const badgeLabel = isImage ? '🖼 Image' : isAudio ? '🔊 Audio' : '🎬 Video';
                                const publishBadgeLabel = workspaceState.publishBadge;
                                const monetizationBadgeLabel = getMonetizationBadgeLabel(workspaceState);
                                const linkedPostPublicPath = workspaceState.linkedPost?.publicPath ?? null;
                                const canCopyLinkedPost =
                                    Boolean(workspaceState.linkedPost?.canShare) &&
                                    Boolean(linkedPostPublicPath);
                                const canUnpublish =
                                    Boolean(workspaceState.linkedPost) &&
                                    !workspaceState.linkedPost?.archivedAt &&
                                    workspaceState.linkedPost?.visibility !== 'private';
                                return (
                                    <motion.div key={gen.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                                        className="group bg-white/[0.02] rounded-[1.5rem] border border-white/[0.04] overflow-hidden backdrop-blur-md hover:border-purple-500/30 hover:shadow-[0_8px_30px_rgba(0,0,0,0.5)] transition-all duration-300 break-inside-avoid mb-6">
                                        <div className="bg-black relative overflow-hidden rounded-t-[1.5rem]">
                                            {isImage ? (
                                                imageOutputs.length > 1 ? (
                                                    <div className="grid grid-cols-2 gap-1 p-1">
                                                        {imageOutputs.map((imageUrl, outputIndex) => (
                                                            <button
                                                                key={`${imageUrl}-${outputIndex}`}
                                                                type="button"
                                                                onClick={() => setPreviewGen(gen)}
                                                                className="relative overflow-hidden rounded-2xl bg-zinc-950"
                                                            >
                                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                <img src={imageUrl} alt={`Generated image ${outputIndex + 1}`} className="aspect-square w-full object-cover transition duration-300 group-hover:scale-[1.02]" />
                                                                {outputIndex === 0 ? (
                                                                    <span className="absolute bottom-2 left-2 rounded-full border border-white/10 bg-black/65 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-white backdrop-blur-md">
                                                                        Primary
                                                                    </span>
                                                                ) : null}
                                                            </button>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={gen.output_url!} alt="Generated image" className="w-full h-auto block" />
                                                )
                                            ) : isAudio ? (
                                                <div className="p-6">
                                                    <div className="mb-4 flex items-center gap-3 text-emerald-300">
                                                        <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 p-3">
                                                            <Volume2 className="w-5 h-5" />
                                                        </div>
                                                        <div>
                                                            <div className="text-sm font-semibold text-white">Audio generation</div>
                                                            <div className="text-xs text-zinc-500">{gen.model}</div>
                                                        </div>
                                                    </div>
                                                    <audio src={gen.output_url!} className="w-full" controls />
                                                </div>
                                            ) : (
                                                <video src={gen.output_url!} className="w-full h-auto block" controls muted loop playsInline
                                                    onMouseEnter={(e) => e.currentTarget.play()}
                                                    onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                                            )}
                                            <div className={`absolute top-3 left-3 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider backdrop-blur-md ${badgeClass}`}>
                                                {badgeLabel}
                                            </div>
                                            <a href={gen.output_url!} download={`creation_${gen.id}.${inferDownloadExtension(gen)}`} target="_blank" rel="noopener noreferrer"
                                                className="absolute top-3 right-3 p-2 bg-black/60 hover:bg-purple-500/80 text-white rounded-full backdrop-blur-md transition-all opacity-0 group-hover:opacity-100 shadow-lg">
                                                <Download className="w-4 h-4" />
                                            </a>
                                        </div>
                                        <div className="p-4 flex items-center justify-between">
                                            <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                            <div className="flex items-center gap-3">
                                                {completedInLabel ? (
                                                    <span className="flex items-center gap-1 text-xs text-zinc-500">
                                                        <CheckCircle2 className="w-3 h-3" />
                                                        {completedInLabel}
                                                    </span>
                                                ) : null}
                                                {gen.duration && <span className="flex items-center gap-1 text-xs text-zinc-500"><Clock className="w-3 h-3" />{Math.round(gen.duration)}s</span>}
                                                {gen.cost && <span className="flex items-center gap-1 text-xs text-zinc-500"><Zap className="w-3 h-3" />{gen.cost}</span>}
                                            </div>
                                        </div>
                                        
                                        <div className="px-4 pb-4">
                                            <div>
                                                <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-white">
                                                    {getPreviewTitle(gen)}
                                                </h3>
                                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">
                                                    {getPreviewSummary(gen)}
                                                </p>
                                            </div>
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${getPublishBadgeClass(publishBadgeLabel)}`}>
                                                    {publishBadgeLabel}
                                                </div>
                                                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${getMonetizationBadgeClass(workspaceState.monetizationKind)}`}>
                                                    {monetizationBadgeLabel}
                                                </div>
                                            </div>

                                            {workspaceState.linkedPost ? (
                                                <div className="mt-3 rounded-[22px] border border-white/8 bg-black/25 p-3">
                                                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Linked post</div>
                                                    <div className="mt-2 text-sm font-semibold text-white">{workspaceState.linkedPost.title}</div>
                                                    <p className="mt-1 text-xs leading-5 text-zinc-400">
                                                        {workspaceState.linkedPost.archivedAt
                                                            ? 'This creation is already connected to an archived owner post.'
                                                            : workspaceState.linkedPost.visibility === 'private'
                                                                ? 'This creation is already connected to a private owner post.'
                                                                : 'This creation is already connected to a post you can manage directly from here.'}
                                                    </p>
                                                </div>
                                            ) : null}

                                            {canManageFromCreation && (workspaceState.primaryAction.type !== 'none' || workspaceState.secondaryAction.type !== 'none') ? (
                                                <div className="mt-4 flex gap-2">
                                                    {workspaceState.primaryAction.type === 'publish' ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => openPublishModal(gen)}
                                                            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                                                        >
                                                            <Globe className="h-4 w-4" />
                                                            {workspaceState.primaryAction.label}
                                                        </button>
                                                    ) : workspaceState.primaryAction.href ? (
                                                        <Link
                                                            href={workspaceState.primaryAction.href}
                                                            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                                        >
                                                            <Wand2 className="h-4 w-4" />
                                                            {workspaceState.primaryAction.label}
                                                        </Link>
                                                    ) : null}

                                                    {workspaceState.secondaryAction.href ? (
                                                        <Link
                                                            href={workspaceState.secondaryAction.href}
                                                            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                                                        >
                                                            <ExternalLink className="h-4 w-4" />
                                                            {workspaceState.secondaryAction.label}
                                                        </Link>
                                                    ) : null}
                                                </div>
                                            ) : null}

                                            <div className="mt-4 flex flex-wrap gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setPreviewGen(gen)}
                                                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                                >
                                                    <Eye className="h-3.5 w-3.5" />
                                                    View details
                                                </button>
                                                {canCopyLinkedPost && workspaceState.linkedPost?.publicPath ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => linkedPostPublicPath && void copyPostLink(linkedPostPublicPath)}
                                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                                    >
                                                        <Copy className="h-3.5 w-3.5" />
                                                        Share link
                                                    </button>
                                                ) : null}
                                                {canUnpublish ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleUnpublish(gen.id)}
                                                        className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-500/15"
                                                    >
                                                        <X className="h-3.5 w-3.5" />
                                                        Unpublish
                                                    </button>
                                                ) : null}
                                                <button
                                                    type="button"
                                                    onClick={() => void handleGenerationArchive(gen.id)}
                                                    className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-500/15"
                                                >
                                                    <Archive className="h-3.5 w-3.5" />
                                                    Archive
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void handleGenerationDelete(gen.id)}
                                                    className="inline-flex items-center gap-2 rounded-full border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Failed */}
                {activeView === 'creations' && failedGenerations.length > 0 && (
                    <div className="mb-10">
                        <h2 className="text-xs font-bold text-red-400/80 uppercase tracking-widest mb-4">Failed ({failedGenerations.length})</h2>
                        <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                            {failedGenerations.map((gen, i) => (
                                <motion.div key={gen.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                                    className="bg-white/[0.02] rounded-[1.5rem] border border-red-500/20 overflow-hidden backdrop-blur-md opacity-60 break-inside-avoid mb-6">
                                    <div className={`${getMediaKind(gen) === 'audio' ? 'p-6' : 'aspect-video'} bg-black/60 flex items-center justify-center`}>
                                        <span className="text-xs text-red-400/60">Generation failed</span>
                                    </div>
                                    <div className="p-4 flex items-center justify-between">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        {gen.cost && <span className="flex items-center gap-1 text-xs text-zinc-500"><Zap className="w-3 h-3" />{gen.cost}</span>}
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}

                {activeView === 'creations' && archivedGenerations.length > 0 && (
                    <div className="mb-10">
                        <div className="mb-4">
                            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Archived creations ({archivedGenerations.length})</h2>
                            <p className="mt-2 max-w-2xl text-sm text-zinc-500">
                                Archived raw creations stay out of the active workspace until you restore them.
                            </p>
                        </div>
                        <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                            {archivedGenerations.map((gen, i) => (
                                <motion.div
                                    key={gen.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.05 }}
                                    className="break-inside-avoid mb-6 rounded-[1.5rem] border border-white/[0.08] bg-white/[0.02] p-4 backdrop-blur-md"
                                >
                                    <div className="rounded-[1.25rem] border border-white/8 bg-black/60 p-4">
                                        <div className="text-sm font-semibold text-white">{getPreviewTitle(gen)}</div>
                                        <p className="mt-2 text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        <div className="mt-4 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void handleGenerationRestore(gen.id)}
                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                            >
                                                <RotateCcw className="h-4 w-4" />
                                                Restore
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleGenerationDelete(gen.id)}
                                                className="inline-flex items-center gap-2 rounded-full border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}

                {activeView === 'posts' && !isLoading && visiblePosts.length === 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center justify-center gap-6 py-24"
                    >
                        <div className="rounded-full border border-white/8 bg-zinc-900/60 p-6">
                            <Wand2 className="h-12 w-12 text-zinc-600" />
                        </div>
                        <div className="text-center">
                            <h2 className="text-xl font-semibold text-zinc-300">No posts in this view yet</h2>
                            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
                                Publish a post from a generation or upload media in the post composer. Private and archived posts will show here once they exist.
                            </p>
                        </div>
                        <Link
                            href="/post/new"
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08]"
                        >
                            Open post composer
                            <ExternalLink className="h-4 w-4" />
                        </Link>
                    </motion.div>
                )}

                {activeView === 'posts' && visiblePosts.length > 0 && (
                    <div className="mb-10">
                        <div className="mb-4">
                            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                                {postVisibilityFilter === 'archived' ? 'Archived posts' : 'Your posts'}
                            </h2>
                            <p className="mt-2 max-w-2xl text-sm text-zinc-500">
                                Post Library is the owner view for the actual posts people can visit, unlock, archive, or clean up.
                            </p>
                        </div>
                        <div className="grid gap-5 lg:grid-cols-2">
                            {visiblePosts.map((post) => (
                                <div
                                    key={post.id}
                                    className="rounded-[28px] border border-white/[0.08] bg-white/[0.02] p-5 backdrop-blur-md"
                                >
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <div className="text-lg font-semibold text-white">{post.title}</div>
                                            <p className="mt-2 text-sm text-zinc-400">
                                                {post.sourceLabel} · {new Date(post.updatedAt).toLocaleString()}
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-2">
                                            <div className={`rounded-full border px-3 py-1 text-xs font-medium ${
                                                post.archivedAt
                                                    ? 'border-amber-400/20 bg-amber-500/10 text-amber-100'
                                                    : 'border-white/10 bg-white/[0.04] text-zinc-200'
                                            }`}>
                                                {post.archivedAt ? 'Archived' : post.visibility}
                                            </div>
                                            {post.bundle ? (
                                                <div className={`rounded-full border px-3 py-1 text-xs font-medium ${
                                                    post.bundle.status === 'published'
                                                        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                                                        : 'border-amber-400/20 bg-amber-500/10 text-amber-100'
                                                }`}>
                                                    {post.bundle.status === 'published' ? 'Unlock live' : 'Unlock draft'}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>

                                    {post.mediaUrl ? (
                                        <div className="mt-4 overflow-hidden rounded-[22px] border border-white/8 bg-black/60">
                                            {post.mediaKind === 'video' ? (
                                                <video src={post.mediaUrl} controls playsInline className="max-h-[320px] w-full object-contain" />
                                            ) : (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={post.mediaUrl} alt={post.title} className="max-h-[320px] w-full object-contain" />
                                            )}
                                        </div>
                                    ) : (
                                        <div className="mt-4 rounded-[22px] border border-white/8 bg-black/50 p-4 text-sm leading-7 text-zinc-300">
                                            {post.body || 'No post story yet.'}
                                        </div>
                                    )}

                                    <div className="mt-4 flex flex-wrap gap-2">
                                        {post.bundle ? (
                                            <>
                                                <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200">
                                                    {post.bundle.accessMode === 'free'
                                                        ? 'Free unlock'
                                                        : formatUsdCents(post.bundle.priceUsdCents)}
                                                </div>
                                                {post.bundle.resourceKinds.map((kind) => (
                                                    <div
                                                        key={`${post.id}-${kind}`}
                                                        className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200"
                                                    >
                                                        {getPostResourceKindLabel(kind)}
                                                    </div>
                                                ))}
                                            </>
                                        ) : (
                                            <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200">
                                                No unlock
                                            </div>
                                        )}
                                    </div>

                                    <div className="mt-5 flex flex-wrap gap-2">
                                        {post.publicPath ? (
                                            <Link
                                                href={buildStudioDetailPath(post.id)}
                                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                            >
                                                <ExternalLink className="h-4 w-4" />
                                                Open public page
                                            </Link>
                                        ) : null}
                                        <Link
                                            href={post.ownerPath}
                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                        >
                                            <PencilLine className="h-4 w-4" />
                                            Edit
                                        </Link>
                                        {post.resourcePath ? (
                                            <Link
                                                href={buildStudioDetailPath(post.id, 'resources')}
                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                            >
                                                <Wand2 className="h-4 w-4" />
                                                Manage unlock
                                            </Link>
                                        ) : null}
                                        {post.canShare ? (
                                            <button
                                                type="button"
                                                onClick={() => void copyPostLink(post.publicPath ?? `/showcase/${post.id}`)}
                                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                            >
                                                <Copy className="h-4 w-4" />
                                                Copy link
                                            </button>
                                        ) : null}
                                        {post.archivedAt ? (
                                            <button
                                                type="button"
                                                onClick={() => void handlePostRestore(post.id)}
                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                            >
                                                <RotateCcw className="h-4 w-4" />
                                                Restore
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => void handlePostArchive(post.id)}
                                                className="inline-flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-500/10 px-3.5 py-2 text-sm font-medium text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-500/15"
                                            >
                                                <Archive className="h-4 w-4" />
                                                Archive
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => void handlePostDelete(post.id)}
                                            className="inline-flex items-center gap-2 rounded-full border border-rose-400/25 bg-rose-500/10 px-3.5 py-2 text-sm font-medium text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <MediaDetailsPreviewModal
                isOpen={Boolean(previewGen)}
                onClose={() => setPreviewGen(null)}
                mediaType={previewGen ? getPreviewMediaType(previewGen) : 'image'}
                src={previewGen?.output_url ?? null}
                alt={previewGen ? getPreviewTitle(previewGen) : 'Creation preview'}
                title={previewGen ? getPreviewTitle(previewGen) : 'Creation preview'}
                prompt={previewGen?.prompt ?? ''}
                actions={previewGen ? (
                    <>
                        {renderShareAction(previewGen, true)}
                        {previewGen.is_public ? (
                            <Link
                                href={
                                    previewGen.linked_post_id
                                        ? previewGen.linked_post_visibility === 'private' || previewGen.linked_post_archived_at
                                            ? `/post/${previewGen.linked_post_id}/edit`
                                            : buildStudioDetailPath(previewGen.linked_post_id)
                                        : buildStudioDetailPath(previewGen.id)
                                }
                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                            >
                                {previewGen.linked_post_id ? 'Open post' : 'Open public page'}
                            </Link>
                        ) : null}
                    </>
                ) : null}
            />

            <PublishToShowcaseModal
                isOpen={Boolean(publishTarget)}
                onClose={closePublishModal}
                generationId={publishTarget?.id ?? null}
                defaultTitle={publishTarget?.title ?? ''}
                defaultDescription={publishTarget?.description ?? ''}
                showPaidShortcut={showPaidShortcutInPublishModal}
                shareAfterPublish={shareAfterPublish ? {
                    title: publishTarget ? getPreviewTitle(publishTarget) : 'Creation',
                    description: publishTarget?.description ?? publishTarget?.prompt ?? null,
                    sourceSurface: 'my-creations',
                } : undefined}
                onPublished={() => {
                    if (!publishTarget) {
                        return;
                    }

                    handlePublished();
                    closePublishModal();
                }}
            />
        </div>
    );
}
