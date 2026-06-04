'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Archive, ArrowLeft, CheckCircle2, Clock, Copy, Download, ExternalLink, Eye, Film, Globe, ImageIcon, Loader2, LockKeyhole, PencilLine, RotateCcw, Trash2, UserRound, Volume2, Wand2, Zap } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';
import MediaDetailsPreviewModal, { type MediaDetailsType } from '@/app/components/MediaDetailsPreviewModal';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import CreationMediaFrame from '@/app/creations/CreationMediaFrame';
import {
    resolveCreationWorkspaceCardState,
    type CreationWorkspaceCardState,
    type CreationWorkspaceMonetizationKind,
    type CreationWorkspacePublishBadge,
} from '@/lib/creation-workspace';
import { formatDurationShort, formatTimeAgoShort } from '@/lib/generation-timing';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import { getStoredMediaLocation } from '@/lib/media-urls';
import { isAudioModel, isImageModel } from '@/lib/models';
import type { ProfileApiResponse } from '@/lib/profile';
import { formatUsdCents, getPostResourceKindLabel } from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath, supportsPublicCreationSharing } from '@/lib/share';
import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';

interface Generation {
    id: string;
    output_url: string | null;
    output_urls?: string[] | null;
    input_media?: GenerationInputMediaItem[] | null;
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
    paywallPrefill?: GenerationPaywallPrefill | null;
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

interface CreationsWorkspaceCache {
    fetchedAt: number;
    generations: Generation[];
    posts: OwnerPost[];
    profile: ProfileApiResponse | null;
}

const CREATIONS_WORKSPACE_CACHE_TTL_MS = 5 * 60 * 1000;
const STUDIO_GRID_CLASS = 'grid items-stretch gap-4 xl:gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]';

function getCreationsWorkspaceCacheKey(userId: string) {
    return `magicbooklet:creations-cache:v1:${userId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function readCreationsWorkspaceCache(userId: string | null): CreationsWorkspaceCache | null {
    if (!userId || typeof window === 'undefined') {
        return null;
    }

    try {
        const raw = window.sessionStorage.getItem(getCreationsWorkspaceCacheKey(userId));
        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed) || typeof parsed.fetchedAt !== 'number') {
            return null;
        }

        if (Date.now() - parsed.fetchedAt > CREATIONS_WORKSPACE_CACHE_TTL_MS) {
            return null;
        }

        return {
            fetchedAt: parsed.fetchedAt,
            generations: Array.isArray(parsed.generations) ? parsed.generations as Generation[] : [],
            posts: Array.isArray(parsed.posts) ? parsed.posts as OwnerPost[] : [],
            profile: isRecord(parsed.profile) ? parsed.profile as unknown as ProfileApiResponse : null,
        };
    } catch {
        return null;
    }
}

function writeCreationsWorkspaceCache(
    userId: string | null,
    cache: Omit<CreationsWorkspaceCache, 'fetchedAt'>
) {
    if (!userId || typeof window === 'undefined') {
        return;
    }

    try {
        window.sessionStorage.setItem(
            getCreationsWorkspaceCacheKey(userId),
            JSON.stringify({
                ...cache,
                fetchedAt: Date.now(),
            })
        );
    } catch {
        // Ignore storage errors in private browsing or constrained mobile webviews.
    }
}

function getMediaIdentity(url: string | null | undefined): string | null {
    if (!url) {
        return null;
    }

    const storedLocation = getStoredMediaLocation(url);
    return storedLocation ? `${storedLocation.bucket}/${storedLocation.filePath}` : url;
}

function getUniqueMediaUrls(urls: Array<string | null | undefined>): string[] {
    const seenIdentities = new Set<string | null>();

    return urls.filter((url): url is string => {
        if (!url) {
            return false;
        }

        const identity = getMediaIdentity(url);
        if (seenIdentities.has(identity)) {
            return false;
        }

        seenIdentities.add(identity);
        return true;
    });
}

function preserveStableMediaUrl(
    previousUrl: string | null | undefined,
    incomingUrl: string | null | undefined
): string | null {
    if (!incomingUrl) {
        return incomingUrl ?? null;
    }

    if (previousUrl && getMediaIdentity(previousUrl) === getMediaIdentity(incomingUrl)) {
        return previousUrl;
    }

    return incomingUrl;
}

function mergeGenerationRefresh(previousGenerations: Generation[], incomingGenerations: Generation[]): Generation[] {
    const previousById = new Map(previousGenerations.map((generation) => [generation.id, generation]));

    return incomingGenerations.map((incomingGeneration) => {
        const previousGeneration = previousById.get(incomingGeneration.id);
        if (!previousGeneration) {
            return incomingGeneration;
        }

        const previousOutputUrls = [
            ...(previousGeneration.output_urls ?? []),
            previousGeneration.output_url,
        ].filter((url): url is string => Boolean(url));

        const mergedOutputUrls = Array.isArray(incomingGeneration.output_urls)
            ? incomingGeneration.output_urls.map((incomingUrl) => {
                const matchingPreviousUrl = previousOutputUrls.find(
                    (previousUrl) => getMediaIdentity(previousUrl) === getMediaIdentity(incomingUrl)
                );
                return preserveStableMediaUrl(matchingPreviousUrl, incomingUrl) ?? incomingUrl;
            })
            : incomingGeneration.output_urls;

        return {
            ...incomingGeneration,
            output_url: preserveStableMediaUrl(previousGeneration.output_url, incomingGeneration.output_url),
            output_urls: mergedOutputUrls,
        };
    });
}

export default function CreationsPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { session } = useAuth();
    const userId = session?.user?.id ?? null;
    const accessToken = session?.access_token ?? null;
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
    const generationsRef = useRef<Generation[]>([]);
    const [filter, setFilter] = useState<FilterType>('all');
    const [activeView, setActiveView] = useState<WorkspaceView>(initialView);
    const [postVisibilityFilter, setPostVisibilityFilter] = useState<OwnerPostVisibilityFilter>(initialPostVisibility);
    const [previewGen, setPreviewGen] = useState<Generation | null>(null);
    const [publishTarget, setPublishTarget] = useState<Generation | null>(null);
    const [initialSellAutoUnlockInPublishModal, setInitialSellAutoUnlockInPublishModal] = useState(false);
    const [shareAfterPublish, setShareAfterPublish] = useState(false);
    const [showPaidShortcutInPublishModal, setShowPaidShortcutInPublishModal] = useState(true);
    const [postVisibilityUpdatingKey, setPostVisibilityUpdatingKey] = useState<string | null>(null);
    const [restoreTarget, setRestoreTarget] = useState<Generation | null>(null);
    const [restoringGenerationId, setRestoringGenerationId] = useState<string | null>(null);
    const restoreInputRef = useRef<HTMLInputElement>(null);
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

    useEffect(() => {
        const cachedWorkspace = readCreationsWorkspaceCache(userId);
        if (!cachedWorkspace) {
            return;
        }

        generationsRef.current = cachedWorkspace.generations;
        setGenerations(cachedWorkspace.generations);
        setPosts(cachedWorkspace.posts);
        setProfile(cachedWorkspace.profile);
        setIsLoading(false);
    }, [userId]);

    const fetchCreations = useCallback(async () => {
        if (!accessToken || !userId) {
            router.push('/login');
            return;
        }

        try {
            const [generationsRes, postsRes, profileRes] = await Promise.all([
                fetch('/api/generations?includeArchived=true', {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
                fetch('/api/posts?scope=owner&includeArchived=true', {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
                fetch('/api/profile', {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
            ]);

            const generationsData = await generationsRes.json();
            let nextGenerations: Generation[] | null = null;
            if (generationsRes.ok) {
                const loadedGenerations = (generationsData.generations || []) as Generation[];
                nextGenerations = mergeGenerationRefresh(generationsRef.current, loadedGenerations);
                generationsRef.current = nextGenerations;
                setGenerations(nextGenerations);
            }

            const postsData = await postsRes.json();
            let nextPosts: OwnerPost[] | null = null;
            if (postsRes.ok) {
                const loadedPosts = (postsData.posts || []) as OwnerPost[];
                nextPosts = loadedPosts;
                setPosts(loadedPosts);
            }

            let nextProfile: ProfileApiResponse | null = null;
            if (profileRes.ok) {
                nextProfile = await profileRes.json();
                setProfile(nextProfile);
            } else {
                setProfile(null);
            }

            if (nextGenerations && nextPosts) {
                writeCreationsWorkspaceCache(userId, {
                    generations: nextGenerations,
                    posts: nextPosts,
                    profile: nextProfile,
                });
            }
        } catch (err) {
            console.error('Failed to fetch creations:', err);
        } finally {
            setIsLoading(false);
        }
    }, [accessToken, router, userId]);

    useEffect(() => {
        void fetchCreations();
    }, [fetchCreations]);

    const hasProcessingGenerations = generations.some(
        (generation) => !generation.archived_at && (generation.status === 'processing' || generation.status === 'waiting')
    );

    useEffect(() => {
        if (!hasProcessingGenerations) {
            return;
        }

        const intervalId = window.setInterval(() => {
            if (document.visibilityState === 'hidden') {
                return;
            }

            void fetchCreations();
        }, 30000);

        return () => {
            window.clearInterval(intervalId);
        };
    }, [fetchCreations, hasProcessingGenerations]);

    const openPublishModal = (generation: Generation, options?: {
        shareAfterPublish?: boolean;
        showPaidShortcut?: boolean;
        initialSellAutoUnlock?: boolean;
    }) => {
        setPublishTarget(generation);
        setInitialSellAutoUnlockInPublishModal(Boolean(options?.initialSellAutoUnlock));
        setShareAfterPublish(Boolean(options?.shareAfterPublish));
        setShowPaidShortcutInPublishModal(options?.showPaidShortcut ?? true);
    };

    const closePublishModal = () => {
        setPublishTarget(null);
        setInitialSellAutoUnlockInPublishModal(false);
        setShareAfterPublish(false);
        setShowPaidShortcutInPublishModal(true);
    };

    const openUnlockModalForGeneration = (generation: Generation) => {
        openPublishModal(generation, {
            showPaidShortcut: true,
            initialSellAutoUnlock: true,
        });
    };

    const openUnlockModalForPost = (post: OwnerPost) => {
        const linkedGeneration = post.generationId
            ? generationsRef.current.find((generation) => generation.id === post.generationId) ??
                generations.find((generation) => generation.id === post.generationId) ??
                null
            : null;

        if (!linkedGeneration) {
            router.push(buildStudioDetailPath(post.id, 'resources'));
            return;
        }

        openUnlockModalForGeneration({
            ...linkedGeneration,
            title: post.title || linkedGeneration.title,
            description: post.description || linkedGeneration.description,
            linked_post_id: post.id,
            linked_post_title: post.title,
            linked_post_visibility: post.visibility,
            linked_post_archived_at: post.archivedAt,
        });
    };

    const handlePublished = () => {
        void fetchCreations();
    };

    const handleCreationPostVisibilityChange = async (
        generationId: string,
        postId: string,
        nextVisibility: Extract<OwnerPost['visibility'], 'public' | 'private'>
    ) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations');
            return;
        }

        const updateKey = `${postId}:${nextVisibility}`;
        setPostVisibilityUpdatingKey(updateKey);

        try {
            const res = await fetch('/api/showcase/publish', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    generationId,
                    visibility: nextVisibility,
                })
            });

            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Failed to update post visibility.');
            }

            await fetchCreations();
        } catch (error) {
            console.error('Failed to update creation post visibility:', error);
            window.alert(error instanceof Error ? error.message : 'Failed to update post visibility.');
        } finally {
            setPostVisibilityUpdatingKey(null);
        }
    };

    const requestPreviewRestore = (generation: Generation) => {
        const mediaKind = getMediaKind(generation);
        if (mediaKind === 'audio') {
            return;
        }

        setRestoreTarget(generation);
        if (restoreInputRef.current) {
            restoreInputRef.current.accept = mediaKind === 'video' ? 'video/*' : 'image/*';
            restoreInputRef.current.value = '';
            restoreInputRef.current.click();
        }
    };

    const handlePreviewRestoreFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] ?? null;
        const generation = restoreTarget;
        event.target.value = '';

        if (!file || !generation) {
            return;
        }

        if (!session?.access_token || !session.user?.id) {
            router.push('/login?returnUrl=/creations');
            return;
        }

        setRestoringGenerationId(generation.id);
        try {
            const uploadedMedia = await uploadMediaToTemporaryStorage(file, session.user.id);
            const response = await fetch(`/api/generations/${generation.id}/restore-media`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({
                    storagePath: uploadedMedia.storagePath,
                    originalName: file.name,
                    contentType: file.type,
                }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to restore preview.');
            }

            await fetchCreations();
            setRestoreTarget(null);
        } catch (error) {
            console.error('Failed to restore creation preview:', error);
            window.alert(error instanceof Error ? error.message : 'Failed to restore preview.');
        } finally {
            setRestoringGenerationId(null);
        }
    };

    const copyPostLink = async (path: string) => {
        try {
            await navigator.clipboard.writeText(`${window.location.origin}${path}`);
        } catch (error) {
            console.error('Failed to copy post link:', error);
        }
    };

    const handlePostVisibilityChange = async (
        post: OwnerPost,
        nextVisibility: Extract<OwnerPost['visibility'], 'public' | 'private'>
    ) => {
        if (!session?.access_token) {
            router.push('/login?returnUrl=/creations?view=posts');
            return;
        }

        if (post.archivedAt) {
            return;
        }

        const updateKey = `${post.id}:${nextVisibility}`;
        setPostVisibilityUpdatingKey(updateKey);

        try {
            const isGenerationBacked = Boolean(post.generationId);
            const response = await fetch(isGenerationBacked ? '/api/showcase/publish' : `/api/posts/${post.id}`, {
                method: isGenerationBacked ? 'POST' : 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify(isGenerationBacked
                    ? {
                        generationId: post.generationId,
                        visibility: nextVisibility,
                    }
                    : {
                        visibility: nextVisibility,
                    }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to update post visibility.');
            }

            await fetchCreations();
            setActiveView('posts');
            setPostVisibilityFilter(nextVisibility);
        } catch (error) {
            console.error('Failed to update post visibility:', error);
            window.alert(error instanceof Error ? error.message : 'Failed to update post visibility.');
        } finally {
            setPostVisibilityUpdatingKey(null);
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

    const getAdditionalPreviewMedia = (generation: Generation) => {
        const outputUrls = getUniqueMediaUrls([generation.output_url, ...(generation.output_urls ?? [])]);

        return outputUrls.slice(1).map((src, index) => ({
                id: `${generation.id}-output-${index + 2}`,
                mediaType: getPreviewMediaType(generation) as Exclude<MediaDetailsType, 'text'>,
                src,
                title: `Output ${index + 2}`,
                alt: `Additional output ${index + 2}`,
            }));
    };

    const isShareSupported = (generation: Generation): boolean =>
        supportsPublicCreationSharing({
            category: getGenerationCategory(generation),
            model: generation.model,
        });

    const appendCreationsSource = (path: string): string => {
        const [pathWithoutHash, hash = ''] = path.split('#');
        const [pathnamePart, query = ''] = pathWithoutHash.split('?');
        const params = new URLSearchParams(query);
        params.set('from', 'creations');
        const nextQuery = params.toString();
        return `${pathnamePart}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
    };

    const buildCreationCustomizePath = (
        generation: Generation,
        workspaceState: CreationWorkspaceCardState
    ): string => {
        if (workspaceState.linkedPost?.ownerPath) {
            return appendCreationsSource(workspaceState.linkedPost.ownerPath);
        }

        return `/post/new?${new URLSearchParams({
            generationId: generation.id,
            from: 'creations',
        }).toString()}`;
    };

    const getPreviewMetadata = (generation: Generation): Array<{ label: string; value: string }> => {
        const mediaKind = getMediaKind(generation);
        const mediaLabel = mediaKind === 'audio' ? 'Audio' : mediaKind === 'image' ? 'Image' : 'Video';
        const createdLabel = new Date(generation.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });
        const completedLabel = getCompletedInLabel(generation);

        return [
            { label: 'Type', value: mediaLabel },
            { label: 'Model', value: generation.model },
            { label: 'Created', value: createdLabel },
            generation.cost !== null ? { label: 'Credits', value: `${generation.cost} credits` } : null,
            completedLabel ? { label: 'Render time', value: completedLabel.replace('Completed in ', '') } : null,
        ].filter((item): item is { label: string; value: string } => Boolean(item));
    };

    const renderPreviewActions = (generation: Generation) => {
        const workspaceState = resolveCreationWorkspaceCardState(generation, posts);
        const mediaKind = getMediaKind(generation);
        const canManageFromCreation = mediaKind !== 'audio' && isShareSupported(generation);
        const primaryIsPublish = workspaceState.primaryAction.type === 'publish';
        const primaryIsUnlock =
            workspaceState.primaryAction.type === 'add-paywall' ||
            workspaceState.primaryAction.type === 'manage-paywall';
        const customizeHref = canManageFromCreation
            ? buildCreationCustomizePath(generation, workspaceState)
            : null;
        const downloadHref = generation.output_url;
        const primaryClass = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 sm:w-auto sm:min-w-36';
        const secondaryClass = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white sm:w-auto';
        const quietIconClass = 'inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white';
        const dangerIconClass = 'inline-flex h-11 w-11 items-center justify-center rounded-full border border-rose-400/20 bg-rose-500/10 text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15';

        return (
            <>
                {canManageFromCreation && primaryIsPublish ? (
                    <button
                        type="button"
                        onClick={() => {
                            setPreviewGen(null);
                            openPublishModal(generation);
                        }}
                        className={primaryClass}
                    >
                        <Globe className="h-4 w-4" />
                        Publish
                    </button>
                ) : null}

                {canManageFromCreation && primaryIsUnlock ? (
                    <button
                        type="button"
                        onClick={() => {
                            setPreviewGen(null);
                            openUnlockModalForGeneration(generation);
                        }}
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 sm:w-auto sm:min-w-40"
                    >
                        <Wand2 className="h-4 w-4" />
                        {workspaceState.primaryAction.label}
                    </button>
                ) : null}

                {customizeHref ? (
                    <Link href={customizeHref} className={secondaryClass}>
                        <PencilLine className="h-4 w-4" />
                        Customize post
                    </Link>
                ) : null}

                {workspaceState.secondaryAction.href && workspaceState.linkedPost ? (
                    <Link href={workspaceState.secondaryAction.href} className={secondaryClass}>
                        <ExternalLink className="h-4 w-4" />
                        Open post
                    </Link>
                ) : null}

                {downloadHref ? (
                    <a
                        href={downloadHref}
                        download={`creation_${generation.id}.${inferDownloadExtension(generation)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={quietIconClass}
                        title="Download creation"
                        aria-label="Download creation"
                    >
                        <Download className="h-4 w-4" />
                    </a>
                ) : null}

                <button
                    type="button"
                    onClick={() => void handleGenerationArchive(generation.id)}
                    className={quietIconClass}
                    title="Archive creation"
                    aria-label="Archive creation"
                >
                    <Archive className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onClick={() => void handleGenerationDelete(generation.id)}
                    className={dangerIconClass}
                    title="Delete creation"
                    aria-label="Delete creation"
                >
                    <Trash2 className="h-4 w-4" />
                </button>
            </>
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
            <input
                ref={restoreInputRef}
                type="file"
                accept={restoreTarget && getMediaKind(restoreTarget) === 'video' ? 'video/*' : 'image/*'}
                aria-label="Restore preview media"
                className="hidden"
                onChange={(event) => void handlePreviewRestoreFile(event)}
            />
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
                    <div className="mb-8 flex gap-2 overflow-x-auto pb-1">
                        {([
                            { key: 'all', label: `All (${successfulGenerations.length})` },
                            { key: 'images', label: `Images (${imageCount})` },
                            { key: 'videos', label: `Videos (${videoCount})` },
                            { key: 'audio', label: `Audio (${audioCount})` },
                        ] as { key: FilterType; label: string }[]).map(tab => (
                            <button
                                key={tab.key}
                                onClick={() => setFilter(tab.key)}
                                className={`shrink-0 whitespace-nowrap px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200 ${filter === tab.key
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
                    <div className={`${STUDIO_GRID_CLASS} mb-10 mt-8`}>
                        {[1, 2, 3, 4, 5, 6].map((i) => (
                            <div key={i}>
                                <SkeletonLoader className="aspect-[4/5] w-full" />
                            </div>
                        ))}
                    </div>
                )}

                {/* Empty State */}
                {activeView === 'creations' && !isLoading && activeGenerations.length === 0 && archivedGenerations.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-6 py-24">
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
                    </div>
                )}

                {activeView === 'creations' && !isLoading && successfulGenerations.length > 0 && filteredSuccessful.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
                        <div className="rounded-full border border-white/8 bg-zinc-900/60 p-5">
                            {filter === 'audio' ? (
                                <Volume2 className="h-9 w-9 text-zinc-600" />
                            ) : filter === 'videos' ? (
                                <Film className="h-9 w-9 text-zinc-600" />
                            ) : (
                                <ImageIcon className="h-9 w-9 text-zinc-600" />
                            )}
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-zinc-300">
                                {filter === 'audio'
                                    ? 'No audio creations yet'
                                    : filter === 'videos'
                                        ? 'No video creations yet'
                                        : 'No image creations yet'}
                            </h2>
                            <p className="mt-2 text-sm text-zinc-500">Choose another filter to keep browsing your Studio.</p>
                        </div>
                    </div>
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
                        <div className={STUDIO_GRID_CLASS}>
                            {processingGenerations.map((gen) => (
                                <div key={gen.id}
                                    className="flex h-full flex-col overflow-hidden rounded-2xl border border-yellow-500/20 bg-white/[0.02] backdrop-blur-md">
                                    <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                        <div className="flex flex-col items-center gap-3">
                                            <Loader2 className="w-8 h-8 text-yellow-400 animate-spin" />
                                            <span className="text-xs text-zinc-400">{getStartedAgoLabel(gen) ?? 'Still processing in background...'}</span>
                                        </div>
                                    </div>
                                    <div className="mt-auto flex items-center justify-between gap-3 p-4">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        <span className="text-xs text-zinc-500">{getStartedAgoLabel(gen) ?? 'Processing'}</span>
                                    </div>
                                </div>
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
                        <div data-testid="creation-grid" className={STUDIO_GRID_CLASS}>
                            {successfulCreationCards.map(({ generation: gen, workspaceState }) => {
                                const mediaKind = getMediaKind(gen);
                                const isImage = mediaKind === 'image';
                                const isAudio = mediaKind === 'audio';
                                const MediaIcon = isImage ? ImageIcon : isAudio ? Volume2 : Film;
                                const outputUrls = getUniqueMediaUrls([
                                    gen.output_url,
                                    ...(gen.output_urls ?? []),
                                ]);
                                const primaryMediaUrl = gen.output_url ?? outputUrls[0];
                                const canManageFromCreation = !isAudio && isShareSupported(gen);
                                const completedInLabel = getCompletedInLabel(gen);
                                const badgeClass = isImage
                                    ? 'border-blue-400/30 bg-blue-500/20 text-blue-100'
                                    : isAudio
                                        ? 'border-emerald-400/30 bg-emerald-500/20 text-emerald-100'
                                        : 'border-rose-400/30 bg-rose-500/20 text-rose-100';
                                const badgeLabel = isImage ? 'Image' : isAudio ? 'Audio' : 'Video';
                                const publishBadgeLabel = workspaceState.publishBadge;
                                const monetizationBadgeLabel = getMonetizationBadgeLabel(workspaceState);
                                const linkedPostPublicPath = workspaceState.linkedPost?.publicPath ?? null;
                                const canCopyLinkedPost =
                                    Boolean(workspaceState.linkedPost?.canShare) &&
                                    Boolean(linkedPostPublicPath);
                                const linkedPostQuickVisibility =
                                    workspaceState.linkedPost &&
                                    !workspaceState.linkedPost.archivedAt &&
                                    (workspaceState.linkedPost.visibility === 'public' || workspaceState.linkedPost.visibility === 'private')
                                        ? workspaceState.linkedPost.visibility
                                        : null;
                                const nextLinkedPostVisibility: Extract<OwnerPost['visibility'], 'public' | 'private'> | null =
                                    linkedPostQuickVisibility === 'public'
                                        ? 'private'
                                        : linkedPostQuickVisibility === 'private'
                                            ? 'public'
                                            : null;
                                const linkedPostVisibilityActionLabel =
                                    nextLinkedPostVisibility === 'public' ? 'Make public' : 'Make private';
                                const LinkedPostVisibilityActionIcon =
                                    nextLinkedPostVisibility === 'public' ? Globe : LockKeyhole;
                                const isLinkedPostVisibilityUpdating =
                                    Boolean(workspaceState.linkedPost) &&
                                    Boolean(nextLinkedPostVisibility) &&
                                    postVisibilityUpdatingKey === `${workspaceState.linkedPost?.id}:${nextLinkedPostVisibility}`;
                                const linkedPostVisibilityActionClass =
                                    nextLinkedPostVisibility === 'public'
                                        ? 'border-sky-400/25 bg-sky-500/10 text-sky-100 hover:border-sky-300/35 hover:bg-sky-500/15'
                                        : 'border-violet-400/25 bg-violet-500/10 text-violet-100 hover:border-violet-300/35 hover:bg-violet-500/15';
                                const hasPrimaryAction =
                                    canManageFromCreation &&
                                    workspaceState.primaryAction.type !== 'none' &&
                                    Boolean(workspaceState.primaryAction.label);
                                const primaryIsPublish = workspaceState.primaryAction.type === 'publish';
                                const primaryIsUnlock =
                                    workspaceState.primaryAction.type === 'add-paywall' ||
                                    workspaceState.primaryAction.type === 'manage-paywall';
                                const createdShort = new Date(gen.created_at).toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                });
                                const hasSecondaryInlineAction =
                                    Boolean(workspaceState.secondaryAction.href) && !primaryIsPublish;
                                const hasLinkedVisibilityAction =
                                    Boolean(workspaceState.linkedPost) && Boolean(nextLinkedPostVisibility);
                                const hasCompactActionRow = hasSecondaryInlineAction || hasLinkedVisibilityAction;
                                return (
                                    <div
                                        key={gen.id}
                                        data-testid={`creation-card-${gen.id}`}
                                        className="group flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.07] bg-[linear-gradient(180deg,rgba(24,24,27,0.78),rgba(8,8,10,0.96))] shadow-[0_18px_60px_rgba(0,0,0,0.34)] backdrop-blur-md transition duration-300 hover:border-white/14 hover:shadow-[0_24px_80px_rgba(0,0,0,0.46)]"
                                    >
                                        <div className="relative shrink-0 overflow-hidden bg-black">
                                            {primaryMediaUrl ? (
                                                <CreationMediaFrame
                                                    key={primaryMediaUrl}
                                                    id={gen.id}
                                                    mediaKind={mediaKind}
                                                    src={primaryMediaUrl}
                                                    alt={isImage ? 'Generated image' : `${badgeLabel} generation`}
                                                    outputCount={outputUrls.length}
                                                    onOpen={() => setPreviewGen(gen)}
                                                    onRestore={!isAudio ? () => requestPreviewRestore(gen) : undefined}
                                                    isRestoring={restoringGenerationId === gen.id}
                                                />
                                            ) : null}
                                            <div className={`absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] backdrop-blur-md ${badgeClass}`}>
                                                <MediaIcon className="h-3.5 w-3.5" />
                                                {badgeLabel}
                                            </div>
                                            <a href={primaryMediaUrl} download={`creation_${gen.id}.${inferDownloadExtension(gen)}`} target="_blank" rel="noopener noreferrer"
                                                className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white opacity-0 shadow-lg backdrop-blur-md transition-all hover:bg-white hover:text-black focus:opacity-100 group-hover:opacity-100"
                                                title="Download creation"
                                                aria-label="Download creation"
                                            >
                                                <Download className="w-4 h-4" />
                                            </a>
                                        </div>

                                        <div className="flex flex-1 flex-col gap-3.5 p-3.5 sm:p-4">
                                            <div className="min-w-0">
                                                <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-white">
                                                    {getPreviewTitle(gen)}
                                                </h3>
                                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">
                                                    {getPreviewSummary(gen)}
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-3 gap-2 rounded-[18px] border border-white/8 bg-black/25 p-2.5">
                                                <div>
                                                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Created</div>
                                                    <div className="mt-1 text-xs font-medium text-zinc-200">{createdShort}</div>
                                                </div>
                                                <div>
                                                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Render</div>
                                                    <div className="mt-1 flex items-center gap-1 text-xs font-medium text-zinc-200">
                                                        <Clock className="h-3 w-3 text-zinc-500" />
                                                        {gen.duration ? `${Math.round(gen.duration)}s` : completedInLabel?.replace('Completed in ', '') ?? 'Ready'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Credits</div>
                                                    <div className="mt-1 flex items-center gap-1 text-xs font-medium text-zinc-200">
                                                        <Zap className="h-3 w-3 text-zinc-500" />
                                                        {gen.cost ?? 0}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap gap-2">
                                                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${getPublishBadgeClass(publishBadgeLabel)}`}>
                                                    {publishBadgeLabel}
                                                </div>
                                                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${getMonetizationBadgeClass(workspaceState.monetizationKind)}`}>
                                                    {monetizationBadgeLabel}
                                                </div>
                                            </div>

                                            {workspaceState.linkedPost ? (
                                                <div className="rounded-2xl border border-white/8 bg-black/25 p-2.5">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Linked post</div>
                                                            <div className="mt-1 truncate text-sm font-semibold text-white">{workspaceState.linkedPost.title}</div>
                                                        </div>
                                                        <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                                                            {workspaceState.linkedPost.archivedAt ? 'Archived' : workspaceState.linkedPost.visibility}
                                                        </span>
                                                    </div>
                                                </div>
                                            ) : null}

                                            {hasPrimaryAction ? (
                                                <div className="space-y-2">
                                                    {primaryIsPublish ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => openPublishModal(gen)}
                                                            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                                                        >
                                                            <Globe className="h-4 w-4" />
                                                            {workspaceState.primaryAction.label}
                                                        </button>
                                                    ) : primaryIsUnlock ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => openUnlockModalForGeneration(gen)}
                                                            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200"
                                                        >
                                                            <Wand2 className="h-4 w-4" />
                                                            {workspaceState.primaryAction.label}
                                                        </button>
                                                    ) : null}

                                                    {hasCompactActionRow ? (
                                                        <div className={`grid gap-2 ${hasSecondaryInlineAction && hasLinkedVisibilityAction ? 'min-[1180px]:grid-cols-2' : ''}`}>
                                                            {hasSecondaryInlineAction && workspaceState.secondaryAction.href ? (
                                                                <Link
                                                                    href={workspaceState.secondaryAction.href}
                                                                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                                                                >
                                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                                    {workspaceState.secondaryAction.label}
                                                                </Link>
                                                            ) : null}

                                                            {hasLinkedVisibilityAction && workspaceState.linkedPost && nextLinkedPostVisibility ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void handleCreationPostVisibilityChange(
                                                                        gen.id,
                                                                        workspaceState.linkedPost!.id,
                                                                        nextLinkedPostVisibility
                                                                    )}
                                                                    disabled={Boolean(postVisibilityUpdatingKey)}
                                                                    className={`inline-flex w-full items-center justify-center gap-2 rounded-2xl border px-3 py-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${linkedPostVisibilityActionClass}`}
                                                                >
                                                                    {isLinkedPostVisibilityUpdating ? (
                                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                    ) : (
                                                                        <LinkedPostVisibilityActionIcon className="h-3.5 w-3.5" />
                                                                    )}
                                                                    {linkedPostVisibilityActionLabel}
                                                                </button>
                                                            ) : null}
                                                        </div>
                                                    ) : null}
                                                </div>
                                            ) : null}

                                            <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/8 pt-3">
                                                <div className="flex min-w-0 flex-wrap gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => setPreviewGen(gen)}
                                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                                    >
                                                        <Eye className="h-3.5 w-3.5" />
                                                        Details
                                                    </button>
                                                    {canCopyLinkedPost && workspaceState.linkedPost?.publicPath ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => linkedPostPublicPath && void copyPostLink(linkedPostPublicPath)}
                                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                                        >
                                                            <Copy className="h-3.5 w-3.5" />
                                                            Link
                                                        </button>
                                                    ) : null}
                                                </div>
                                                <div className="flex shrink-0 gap-1.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleGenerationArchive(gen.id)}
                                                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-amber-400/20 bg-amber-500/10 text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-500/15"
                                                        title="Archive creation"
                                                        aria-label="Archive creation"
                                                    >
                                                        <Archive className="h-3.5 w-3.5" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleGenerationDelete(gen.id)}
                                                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-rose-400/20 bg-rose-500/10 text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15"
                                                        title="Delete creation"
                                                        aria-label="Delete creation"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Failed */}
                {activeView === 'creations' && failedGenerations.length > 0 && (
                    <div className="mb-10">
                        <h2 className="text-xs font-bold text-red-400/80 uppercase tracking-widest mb-4">Failed ({failedGenerations.length})</h2>
                        <div className={STUDIO_GRID_CLASS}>
                            {failedGenerations.map((gen) => (
                                <div key={gen.id}
                                    className="flex h-full flex-col overflow-hidden rounded-[1.5rem] border border-red-500/20 bg-white/[0.02] opacity-60 backdrop-blur-md">
                                    <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                        <span className="text-xs text-red-400/60">Generation failed</span>
                                    </div>
                                    <div className="mt-auto flex items-center justify-between p-4">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        {gen.cost && <span className="flex items-center gap-1 text-xs text-zinc-500"><Zap className="w-3 h-3" />{gen.cost}</span>}
                                    </div>
                                </div>
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
                        <div className={STUDIO_GRID_CLASS}>
                            {archivedGenerations.map((gen) => (
                                <div
                                    key={gen.id}
                                    className="flex h-full flex-col rounded-[1.5rem] border border-white/[0.08] bg-white/[0.02] p-4 backdrop-blur-md"
                                >
                                    <div className="flex h-full flex-col rounded-[1.25rem] border border-white/8 bg-black/60 p-4">
                                        <div className="text-sm font-semibold text-white">{getPreviewTitle(gen)}</div>
                                        <p className="mt-2 text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        <div className="mt-auto flex flex-wrap gap-2 pt-4">
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
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {activeView === 'posts' && !isLoading && visiblePosts.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-6 py-24">
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
                    </div>
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
                        <div className="grid gap-4">
                            {visiblePosts.map((post) => {
                                const postSummary = post.description || post.body || post.prompt || 'No post story yet.';
                                const updatedLabel = new Date(post.updatedAt).toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                });
                                const statusClass = post.archivedAt
                                    ? 'border-amber-400/20 bg-amber-500/10 text-amber-100'
                                    : post.visibility === 'public'
                                        ? 'border-sky-400/20 bg-sky-500/10 text-sky-100'
                                        : post.visibility === 'unlisted'
                                            ? 'border-indigo-400/20 bg-indigo-500/10 text-indigo-100'
                                            : 'border-violet-400/20 bg-violet-500/10 text-violet-100';
                                const bundleStatusClass = post.bundle?.status === 'published'
                                    ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                                    : 'border-amber-400/20 bg-amber-500/10 text-amber-100';
                                const categoryLabel = post.mediaKind === 'video'
                                    ? 'Video'
                                    : post.mediaKind === 'image'
                                        ? 'Image'
                                        : post.postFormat === 'text'
                                            ? 'Text'
                                            : post.category;
                                const nextVisibility: Extract<OwnerPost['visibility'], 'public' | 'private'> =
                                    post.visibility === 'private' ? 'public' : 'private';
                                const visibilityActionLabel = nextVisibility === 'public' ? 'Make public' : 'Make private';
                                const VisibilityActionIcon = nextVisibility === 'public' ? Globe : LockKeyhole;
                                const isVisibilityUpdating = postVisibilityUpdatingKey === `${post.id}:${nextVisibility}`;
                                const visibilityActionClass = nextVisibility === 'public'
                                    ? 'border-sky-400/25 bg-sky-500/10 text-sky-100 hover:border-sky-300/35 hover:bg-sky-500/15'
                                    : 'border-violet-400/25 bg-violet-500/10 text-violet-100 hover:border-violet-300/35 hover:bg-violet-500/15';

                                return (
                                    <article
                                        key={post.id}
                                        className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(135deg,rgba(24,24,27,0.82),rgba(8,8,10,0.96))] p-3 shadow-[0_20px_70px_rgba(0,0,0,0.32)] backdrop-blur-md transition hover:border-white/14"
                                    >
                                        <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
                                            <div className="relative overflow-hidden rounded-[22px] border border-white/8 bg-black/60">
                                                {post.mediaUrl ? (
                                                    post.mediaKind === 'video' ? (
                                                        <video src={post.mediaUrl} controls playsInline preload="metadata" className="aspect-[4/5] w-full object-cover" />
                                                    ) : (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img src={post.mediaUrl} alt={post.title} loading="lazy" decoding="async" className="aspect-[4/5] w-full object-cover" />
                                                    )
                                                ) : (
                                                    <div className="flex aspect-[4/5] w-full items-center justify-center p-4 text-sm leading-6 text-zinc-400">
                                                        <span className="line-clamp-6">{post.body || 'Text post'}</span>
                                                    </div>
                                                )}
                                                <div className="absolute left-3 top-3 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-100 backdrop-blur-md">
                                                    {categoryLabel}
                                                </div>
                                            </div>

                                            <div className="flex min-w-0 flex-col justify-between gap-4 p-1 md:p-2">
                                                <div>
                                                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                                        <div className="min-w-0">
                                                            <h3 className="line-clamp-2 text-lg font-semibold leading-6 text-white">
                                                                {post.title}
                                                            </h3>
                                                            <p className="mt-2 text-sm text-zinc-500">
                                                                {post.sourceLabel} · Updated {updatedLabel}
                                                            </p>
                                                        </div>
                                                        <div className="flex shrink-0 flex-wrap gap-2">
                                                            <span className={`rounded-full border px-3 py-1 text-xs font-medium capitalize ${statusClass}`}>
                                                                {post.archivedAt ? 'Archived' : post.visibility}
                                                            </span>
                                                            {post.bundle ? (
                                                                <span className={`rounded-full border px-3 py-1 text-xs font-medium ${bundleStatusClass}`}>
                                                                    {post.bundle.status === 'published' ? 'Unlock live' : 'Unlock draft'}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    </div>

                                                    <p className="mt-4 line-clamp-2 max-w-3xl text-sm leading-6 text-zinc-400">
                                                        {postSummary}
                                                    </p>

                                                    <div className="mt-4 rounded-[20px] border border-white/8 bg-black/25 p-3">
                                                        {post.bundle ? (
                                                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                                                <div>
                                                                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
                                                                        Unlock package
                                                                    </div>
                                                                    <div className="mt-1 flex flex-wrap items-center gap-2">
                                                                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-100">
                                                                            {post.bundle.accessMode === 'free'
                                                                                ? 'Free unlock'
                                                                                : formatUsdCents(post.bundle.priceUsdCents)}
                                                                        </span>
                                                                        {post.bundle.resourceKinds.slice(0, 4).map((kind) => (
                                                                            <span
                                                                                key={`${post.id}-${kind}`}
                                                                                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-300"
                                                                            >
                                                                                {getPostResourceKindLabel(kind)}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                                <div className="text-xs leading-5 text-zinc-500">
                                                                    {post.bundle.salesCount} sold · {formatUsdCents(post.bundle.earningsUsdCents)} earned
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                                                <div>
                                                                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Unlock package</div>
                                                                    <p className="mt-1 text-sm text-zinc-300">No reusable prompt, files, notes, or workflow attached.</p>
                                                                </div>
                                                                <span className="self-start rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-300">
                                                                    No unlock
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex flex-col gap-3 border-t border-white/8 pt-4 lg:flex-row lg:items-center lg:justify-between">
                                                    <div className="flex flex-wrap gap-2">
                                                        {post.publicPath ? (
                                                            <Link
                                                                href={buildStudioDetailPath(post.id)}
                                                                className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200"
                                                            >
                                                                <ExternalLink className="h-4 w-4" />
                                                                Open public page
                                                            </Link>
                                                        ) : null}
                                                        {!post.archivedAt ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => void handlePostVisibilityChange(post, nextVisibility)}
                                                                disabled={Boolean(postVisibilityUpdatingKey)}
                                                                className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${visibilityActionClass}`}
                                                            >
                                                                {isVisibilityUpdating ? (
                                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                                ) : (
                                                                    <VisibilityActionIcon className="h-4 w-4" />
                                                                )}
                                                                {visibilityActionLabel}
                                                            </button>
                                                        ) : null}
                                                        <Link
                                                            href={post.ownerPath}
                                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                                        >
                                                            <PencilLine className="h-4 w-4" />
                                                            Edit
                                                        </Link>
                                                        {post.generationId && !post.archivedAt ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => openUnlockModalForPost(post)}
                                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                                            >
                                                                <Wand2 className="h-4 w-4" />
                                                                {post.bundle ? 'Manage unlock' : 'Add unlock'}
                                                            </button>
                                                        ) : post.resourcePath ? (
                                                            <Link
                                                                href={buildStudioDetailPath(post.id, 'resources')}
                                                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                                            >
                                                                <Wand2 className="h-4 w-4" />
                                                                Manage unlock
                                                            </Link>
                                                        ) : null}
                                                    </div>

                                                    <div className="flex flex-wrap gap-2">
                                                        {post.canShare ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => void copyPostLink(post.publicPath ?? `/showcase/${post.id}`)}
                                                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-100 transition hover:bg-white/[0.08]"
                                                                title="Copy post link"
                                                                aria-label="Copy post link"
                                                            >
                                                                <Copy className="h-4 w-4" />
                                                            </button>
                                                        ) : null}
                                                        {post.archivedAt ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => void handlePostRestore(post.id)}
                                                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10 text-emerald-100 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                                                                title="Restore post"
                                                                aria-label="Restore post"
                                                            >
                                                                <RotateCcw className="h-4 w-4" />
                                                            </button>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={() => void handlePostArchive(post.id)}
                                                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-amber-400/25 bg-amber-500/10 text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-500/15"
                                                                title="Archive post"
                                                                aria-label="Archive post"
                                                            >
                                                                <Archive className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={() => void handlePostDelete(post.id)}
                                                            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-rose-400/25 bg-rose-500/10 text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15"
                                                            title="Delete post"
                                                            aria-label="Delete post"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
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
                body={previewGen?.description ?? ''}
                inputMedia={previewGen?.input_media ?? []}
                additionalMedia={previewGen ? getAdditionalPreviewMedia(previewGen) : []}
                metadata={previewGen ? getPreviewMetadata(previewGen) : []}
                actions={previewGen ? renderPreviewActions(previewGen) : null}
            />

            <PublishToShowcaseModal
                isOpen={Boolean(publishTarget)}
                onClose={closePublishModal}
                generationId={publishTarget?.id ?? null}
                accessToken={session?.access_token ?? null}
                defaultTitle={publishTarget?.title ?? ''}
                defaultDescription={publishTarget?.description ?? ''}
                showPaidShortcut={showPaidShortcutInPublishModal}
                initialSellAutoUnlock={initialSellAutoUnlockInPublishModal}
                paywallPrefill={publishTarget?.paywallPrefill ?? null}
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
