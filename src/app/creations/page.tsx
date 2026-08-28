'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Archive, CheckCircle2, Clock, Copy, Download, ExternalLink, Eye, Film, Globe, ImageIcon, Loader2, PencilLine, Plus, RotateCcw, Trash2, UserRound, Volume2, Wand2, Zap } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';
import MediaDetailsPreviewModal, { type MediaDetailsType } from '@/app/components/MediaDetailsPreviewModal';
import PostVisibilityMenu from '@/app/components/PostVisibilityMenu';
import StudioOverflowMenu, { type StudioOverflowMenuItem } from '@/app/components/StudioOverflowMenu';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import {
    usePostLifecycle,
    type PostLifecyclePatch,
    type PostLifecycleTarget,
} from '@/app/components/usePostLifecycle';
import { HoverVideo } from '@/app/components/HoverVideo';
import CreationMediaFrame from '@/app/creations/CreationMediaFrame';
import StudioCard, {
    STUDIO_GRID_CLASS,
    StudioChip,
    StudioDetail,
    StudioKindBadge,
    studioActionClass,
    type StudioChipTone,
} from '@/app/creations/StudioCard';
import {
    buildPostRecipeManagementPath,
    resolveCreationWorkspaceCardState,
    type CreationWorkspaceCardState,
    type CreationWorkspaceMonetizationKind,
    type CreationWorkspacePublishBadge,
} from '@/lib/creation-workspace';
import { formatDurationShort, formatTimeAgoShort } from '@/lib/generation-timing';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import { resolvePlaybackUrl } from '@/lib/media-descriptor';
import { getStoredMediaLocation } from '@/lib/media-urls';
import { isAudioModel, isImageModel } from '@/lib/client-generation-models';
import { getCreatorProfileReadiness, type ProfileApiResponse } from '@/lib/profile';
import { formatUsdCents, getPostResourceKindLabel } from '@/lib/post-resource-bundles';
import UnlockLibrary from './UnlockLibrary';
import { buildShowcaseDetailPath, supportsPublicCreationSharing } from '@/lib/share';
import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';

interface Generation {
    id: string;
    output_url: string | null;
    /** Poster for the studio grid, so video tiles need not preload metadata. */
    preview_url?: string | null;
    output_urls?: string[] | null;
    output_count?: number | null;
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
    origin?: 'creation' | 'template';
    template?: {
        runId: string;
        templateId: string;
        templateTitle: string | null;
    } | null;
}

type FilterType = 'all' | 'images' | 'videos' | 'audio';
type WorkspaceView = 'creations' | 'posts' | 'unlocks';
type OwnerPostVisibilityFilter = 'all' | 'public' | 'unlisted' | 'private' | 'archived';

interface OwnerPost {
    id: string;
    generationId: string | null;
    visibility: 'public' | 'unlisted' | 'private';
    archivedAt: string | null;
    mediaUrl: string | null;
    mediaKind: 'image' | 'video' | null;
    mediaItems?: Array<{
      renditionUrl?: string | null;
      previewUrl?: string | null;
    }>;
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

interface GenerationsApiResponse {
    generations?: Generation[];
    pagination?: {
        limit?: number;
        hasMore?: boolean;
        nextCursor?: string | null;
    };
}

interface OwnerPostsApiResponse {
    posts?: OwnerPost[];
    pageInfo?: {
        hasMore?: boolean;
        nextOffset?: number | null;
    };
}

const CREATIONS_WORKSPACE_CACHE_TTL_MS = 5 * 60 * 1000;
const CREATIONS_GENERATIONS_PAGE_SIZE = 36;
const CREATIONS_POSTS_PAGE_SIZE = 36;
const SIGNED_MEDIA_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000;
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

function getSignedMediaUrlExpirationMs(url: string): number | null {
    try {
        const parsedUrl = new URL(url);
        if (!parsedUrl.pathname.includes('/storage/v1/object/sign/')) {
            return null;
        }

        const tokenPayload = parsedUrl.searchParams.get('token')?.split('.')[1];
        if (!tokenPayload) {
            return null;
        }

        const normalizedPayload = tokenPayload.replace(/-/g, '+').replace(/_/g, '/');
        const paddedPayload = normalizedPayload.padEnd(
            Math.ceil(normalizedPayload.length / 4) * 4,
            '='
        );
        const payload = JSON.parse(globalThis.atob(paddedPayload)) as { exp?: unknown };
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

function preserveStableMediaUrl(
    previousUrl: string | null | undefined,
    incomingUrl: string | null | undefined
): string | null {
    if (!incomingUrl) {
        return incomingUrl ?? null;
    }

    if (!previousUrl || getMediaIdentity(previousUrl) !== getMediaIdentity(incomingUrl)) {
        return incomingUrl;
    }

    if (previousUrl === incomingUrl) {
        return previousUrl;
    }

    const previousExpirationMs = getSignedMediaUrlExpirationMs(previousUrl);
    if (
        previousExpirationMs !== null
        && previousExpirationMs > Date.now() + SIGNED_MEDIA_URL_REFRESH_BUFFER_MS
    ) {
        return previousUrl;
    }

    return incomingUrl;
}

function buildGenerationsPageUrl(cursor?: string | null): string {
    const params = new URLSearchParams({
        includeArchived: 'true',
        detail: 'summary',
        limit: String(CREATIONS_GENERATIONS_PAGE_SIZE),
    });

    if (cursor) {
        params.set('cursor', cursor);
    }

    return `/api/generations?${params.toString()}`;
}

function buildGenerationDetailUrl(generationId: string): string {
    return `/api/generations?${new URLSearchParams({
        includeArchived: 'true',
        id: generationId,
        limit: '1',
    }).toString()}`;
}

function buildGenerationStatusRefreshUrl(generationIds: string[]): string {
    return `/api/generations?${new URLSearchParams({
        detail: 'status',
        ids: generationIds.join(','),
        limit: String(Math.max(1, generationIds.length)),
    }).toString()}`;
}

function hasFullGenerationDetails(generation: Generation): boolean {
    return generation.input_media !== undefined || generation.paywallPrefill !== undefined;
}

function getNextGenerationCursor(payload: GenerationsApiResponse): string | null {
    const nextCursor = payload.pagination?.nextCursor;
    return typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null;
}

function mergeGenerationRefresh(
    previousGenerations: Generation[],
    incomingGenerations: Generation[],
    options: { preserveMissing?: boolean } = {}
): Generation[] {
    const previousById = new Map(previousGenerations.map((generation) => [generation.id, generation]));

    const refreshedGenerations = incomingGenerations.map((incomingGeneration) => {
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
            output_count: incomingGeneration.output_count ?? previousGeneration.output_count,
            input_media: incomingGeneration.input_media ?? previousGeneration.input_media,
            paywallPrefill: incomingGeneration.paywallPrefill ?? previousGeneration.paywallPrefill,
        };
    });

    if (!options.preserveMissing) {
        return refreshedGenerations;
    }

    const refreshedIds = new Set(refreshedGenerations.map((generation) => generation.id));
    return [
        ...refreshedGenerations,
        ...previousGenerations.filter((generation) => !refreshedIds.has(generation.id)),
    ];
}

function mergeGenerationAppend(previousGenerations: Generation[], incomingGenerations: Generation[]): Generation[] {
    const previousIds = new Set(previousGenerations.map((generation) => generation.id));
    return [
        ...previousGenerations,
        ...incomingGenerations.filter((generation) => !previousIds.has(generation.id)),
    ];
}

function mergePostAppend(previousPosts: OwnerPost[], incomingPosts: OwnerPost[]): OwnerPost[] {
    const previousIds = new Set(previousPosts.map((post) => post.id));
    return [
        ...previousPosts,
        ...incomingPosts.filter((post) => !previousIds.has(post.id)),
    ];
}

function parseWorkspaceView(value: string | null): WorkspaceView {
    return value === 'posts' || value === 'unlocks' ? value : 'creations';
}

function parsePostVisibilityFilter(value: string | null): OwnerPostVisibilityFilter {
    return value === 'public' || value === 'unlisted' || value === 'private' || value === 'archived'
        ? value
        : 'all';
}

const WORKSPACE_TABS: ReadonlyArray<{ key: WorkspaceView; label: string; lede: string }> = [
    { key: 'creations', label: 'Creations', lede: 'Preview private outputs, then turn the strongest ones into posts.' },
    { key: 'posts', label: 'Post Library', lede: 'Use Post Library for full post edits, archive state, and cleanup after publishing.' },
    { key: 'unlocks', label: 'Unlocks', lede: 'Everything you have unlocked from other creators, yours to keep.' },
];

export default function CreationsPage() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { session } = useAuth();
    const userId = session?.user?.id ?? null;
    const accessToken = session?.access_token ?? null;
    const requestedGenerationId = searchParams.get('generation')?.trim() || null;
    // The URL is the only source of truth for the workspace controls, so the
    // back button, a refresh, a shared link, and every returnTo land on the
    // view the viewer was actually looking at. The tabs and filter chips are
    // links that change it; nothing else does.
    const activeView = parseWorkspaceView(searchParams.get('view'));
    const postVisibilityFilter = parsePostVisibilityFilter(searchParams.get('visibility'));
    const buildWorkspacePath = (view: WorkspaceView, visibility: OwnerPostVisibilityFilter = 'all') => {
        const params = new URLSearchParams();
        if (view !== 'creations') {
            params.set('view', view);
        }
        if (view === 'posts' && visibility !== 'all') {
            params.set('visibility', visibility);
        }
        const query = params.toString();
        return query ? `${pathname}?${query}` : pathname;
    };
    const [generations, setGenerations] = useState<Generation[]>([]);
    const [posts, setPosts] = useState<OwnerPost[]>([]);
    const [profile, setProfile] = useState<ProfileApiResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [generationsNextCursor, setGenerationsNextCursor] = useState<string | null>(null);
    const [isLoadingMoreGenerations, setIsLoadingMoreGenerations] = useState(false);
    const [generationsLoadMoreError, setGenerationsLoadMoreError] = useState<string | null>(null);
    const [postsNextOffset, setPostsNextOffset] = useState<number | null>(null);
    const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false);
    const [postsLoadMoreError, setPostsLoadMoreError] = useState<string | null>(null);
    const [generationDetailLoadingId, setGenerationDetailLoadingId] = useState<string | null>(null);
    const [generationDetailError, setGenerationDetailError] = useState<string | null>(null);
    const generationsRef = useRef<Generation[]>([]);
    const generationStatusRefreshInFlightRef = useRef(false);
    const [filter, setFilter] = useState<FilterType>('all');
    const [previewGen, setPreviewGen] = useState<Generation | null>(null);
    const requestedGenerationRef = useRef<string | null>(null);
    const [publishTarget, setPublishTarget] = useState<Generation | null>(null);
    const [shareAfterPublish, setShareAfterPublish] = useState(false);
    const [showPaidShortcutInPublishModal, setShowPaidShortcutInPublishModal] = useState(true);
    const [restoreTarget, setRestoreTarget] = useState<Generation | null>(null);
    const [restoringGenerationId, setRestoringGenerationId] = useState<string | null>(null);
    const restoreInputRef = useRef<HTMLInputElement>(null);
    const postsRef = useRef<OwnerPost[]>([]);
    const profileRef = useRef<ProfileApiResponse | null>(null);
    useEffect(() => {
        postsRef.current = posts;
    }, [posts]);
    useEffect(() => {
        profileRef.current = profile;
    }, [profile]);
    const creationsReturnPath = searchParams.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
    const buildStudioDetailPath = (postId: string, section?: string) =>
        buildShowcaseDetailPath(postId, {
            from: 'studio',
            returnTo: creationsReturnPath,
            section,
        });

    // Lifecycle changes land in local state (and the session cache, so a
    // reload does not flash the old state) instead of refetching the whole
    // workspace. A generation card reads its linked post from `posts` first
    // and from its own linked_post_* columns only as a fallback, so both are
    // kept in step.
    const patchPost = useCallback((postId: string, patch: PostLifecyclePatch) => {
        const nextPosts = postsRef.current.map((post) => {
            if (post.id !== postId) {
                return post;
            }
            return {
                ...post,
                ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
                ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
                ...(patch.bundleStatus !== undefined && post.bundle
                    ? { bundle: { ...post.bundle, status: patch.bundleStatus ?? post.bundle.status } }
                    : {}),
            };
        });
        const nextGenerations = generationsRef.current.map((generation) => {
            if (generation.linked_post_id !== postId) {
                return generation;
            }
            return {
                ...generation,
                ...(patch.visibility !== undefined ? { linked_post_visibility: patch.visibility } : {}),
                ...(patch.archivedAt !== undefined ? { linked_post_archived_at: patch.archivedAt } : {}),
            };
        });
        postsRef.current = nextPosts;
        generationsRef.current = nextGenerations;
        setPosts(nextPosts);
        setGenerations(nextGenerations);
        writeCreationsWorkspaceCache(userId, {
            generations: nextGenerations,
            posts: nextPosts,
            profile: profileRef.current,
        });
    }, [userId]);

    const removePost = useCallback((postId: string) => {
        const nextPosts = postsRef.current.filter((post) => post.id !== postId);
        const nextGenerations = generationsRef.current.map((generation) => (
            generation.linked_post_id === postId
                ? {
                    ...generation,
                    linked_post_id: null,
                    linked_post_title: null,
                    linked_post_visibility: null,
                    linked_post_archived_at: null,
                }
                : generation
        ));
        postsRef.current = nextPosts;
        generationsRef.current = nextGenerations;
        setPosts(nextPosts);
        setGenerations(nextGenerations);
        writeCreationsWorkspaceCache(userId, {
            generations: nextGenerations,
            posts: nextPosts,
            profile: profileRef.current,
        });
    }, [userId]);

    const handleLifecycleAuthRequired = useCallback(() => {
        router.push(`/login?returnUrl=${encodeURIComponent(creationsReturnPath)}`);
    }, [creationsReturnPath, router]);

    const postLifecycle = usePostLifecycle({
        accessToken,
        onAuthRequired: handleLifecycleAuthRequired,
        onPatch: patchPost,
        onRemoved: removePost,
    });

    // A generation card's linked post is the full owner record when it is
    // loaded, so policy can see its bundle; otherwise the generation's own
    // linkage columns are enough to act on.
    const resolveLinkedPostTarget = (
        generation: Generation,
        linkedPost: NonNullable<CreationWorkspaceCardState['linkedPost']>,
    ): PostLifecycleTarget => {
        const ownerPost = postsRef.current.find((post) => post.id === linkedPost.id);
        return ownerPost ?? {
            id: linkedPost.id,
            generationId: generation.id,
            visibility: linkedPost.visibility,
            archivedAt: linkedPost.archivedAt,
            bundle: null,
        };
    };

    useEffect(() => {
        const cachedWorkspace = readCreationsWorkspaceCache(userId);
        if (!cachedWorkspace) {
            return;
        }

        generationsRef.current = cachedWorkspace.generations;
        // Hydrate the last user-scoped workspace snapshot before the network refresh completes.
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
                fetch(buildGenerationsPageUrl(), {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
                fetch(`/api/posts?scope=owner&includeArchived=true&limit=${CREATIONS_POSTS_PAGE_SIZE}&offset=0`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
                fetch('/api/profile', {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
            ]);

            const generationsData = await generationsRes.json() as GenerationsApiResponse;
            let nextGenerations: Generation[] | null = null;
            if (generationsRes.ok) {
                const loadedGenerations = (generationsData.generations || []) as Generation[];
                nextGenerations = mergeGenerationRefresh(generationsRef.current, loadedGenerations, {
                    preserveMissing: generationsRef.current.length > loadedGenerations.length,
                });
                generationsRef.current = nextGenerations;
                setGenerations(nextGenerations);
                setGenerationsNextCursor(getNextGenerationCursor(generationsData));
                setGenerationsLoadMoreError(null);
            }

            const postsData = await postsRes.json() as OwnerPostsApiResponse;
            let nextPosts: OwnerPost[] | null = null;
            if (postsRes.ok) {
                const loadedPosts = (postsData.posts || []) as OwnerPost[];
                nextPosts = loadedPosts;
                setPosts(loadedPosts);
                setPostsNextOffset(postsData.pageInfo?.hasMore
                    ? postsData.pageInfo.nextOffset ?? null
                    : null);
                setPostsLoadMoreError(null);
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

    const loadMoreGenerations = useCallback(async () => {
        if (!accessToken || !userId) {
            router.push('/login');
            return;
        }

        if (!generationsNextCursor || isLoadingMoreGenerations) {
            return;
        }

        setIsLoadingMoreGenerations(true);
        setGenerationsLoadMoreError(null);

        try {
            const response = await fetch(buildGenerationsPageUrl(generationsNextCursor), {
                headers: { 'Authorization': `Bearer ${accessToken}` },
            });
            const data = await response.json() as GenerationsApiResponse;

            if (!response.ok) {
                throw new Error('Failed to load more creations.');
            }

            const loadedGenerations = Array.isArray(data.generations) ? data.generations : [];
            const nextGenerations = mergeGenerationAppend(generationsRef.current, loadedGenerations);
            generationsRef.current = nextGenerations;
            setGenerations(nextGenerations);
            setGenerationsNextCursor(getNextGenerationCursor(data));
            writeCreationsWorkspaceCache(userId, {
                generations: nextGenerations,
                posts,
                profile,
            });
        } catch (error) {
            console.error('Failed to load more creations:', error);
            setGenerationsLoadMoreError(error instanceof Error ? error.message : 'Failed to load more creations.');
        } finally {
            setIsLoadingMoreGenerations(false);
        }
    }, [accessToken, generationsNextCursor, isLoadingMoreGenerations, posts, profile, router, userId]);

    const refreshProcessingGenerationStatuses = useCallback(async () => {
        if (!accessToken || generationStatusRefreshInFlightRef.current) return;

        const activeIds = generationsRef.current
            .filter((generation) => (
                !generation.archived_at
                && (generation.status === 'processing' || generation.status === 'waiting')
            ))
            .map((generation) => generation.id);
        if (activeIds.length === 0) return;

        generationStatusRefreshInFlightRef.current = true;
        try {
            const response = await fetch(buildGenerationStatusRefreshUrl(activeIds), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) return;

            const payload = await response.json() as GenerationsApiResponse;
            const statuses = new Map(
                (Array.isArray(payload.generations) ? payload.generations : [])
                    .map((generation) => [generation.id, generation] as const)
            );
            const reachedTerminalState = activeIds.some((generationId) => {
                const status = statuses.get(generationId)?.status;
                return status === 'succeeded' || status === 'failed';
            });

            if (reachedTerminalState) {
                await fetchCreations();
                return;
            }

            const nextGenerations = generationsRef.current.map((generation) => {
                const statusUpdate = statuses.get(generation.id);
                return statusUpdate
                    ? {
                        ...generation,
                        status: statusUpdate.status,
                        completed_at: statusUpdate.completed_at ?? generation.completed_at,
                    }
                    : generation;
            });
            generationsRef.current = nextGenerations;
            setGenerations(nextGenerations);
        } catch (error) {
            console.error('Failed to refresh processing generation statuses:', error);
        } finally {
            generationStatusRefreshInFlightRef.current = false;
        }
    }, [accessToken, fetchCreations]);

    const loadMorePosts = useCallback(async () => {
        if (!accessToken || !userId) {
            router.push('/login');
            return;
        }
        if (postsNextOffset === null || isLoadingMorePosts) return;

        setIsLoadingMorePosts(true);
        setPostsLoadMoreError(null);
        try {
            const response = await fetch(
                `/api/posts?scope=owner&includeArchived=true&limit=${CREATIONS_POSTS_PAGE_SIZE}&offset=${postsNextOffset}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const data = await response.json() as OwnerPostsApiResponse;
            if (!response.ok) throw new Error('Failed to load more posts.');

            const nextPosts = mergePostAppend(posts, Array.isArray(data.posts) ? data.posts : []);
            setPosts(nextPosts);
            setPostsNextOffset(data.pageInfo?.hasMore ? data.pageInfo.nextOffset ?? null : null);
            writeCreationsWorkspaceCache(userId, {
                generations: generationsRef.current,
                posts: nextPosts,
                profile,
            });
        } catch (error) {
            console.error('Failed to load more posts:', error);
            setPostsLoadMoreError(error instanceof Error ? error.message : 'Failed to load more posts.');
        } finally {
            setIsLoadingMorePosts(false);
        }
    }, [accessToken, isLoadingMorePosts, posts, postsNextOffset, profile, router, userId]);

    const cacheGenerations = useCallback((nextGenerations: Generation[]) => {
        generationsRef.current = nextGenerations;
        setGenerations(nextGenerations);
        writeCreationsWorkspaceCache(userId, {
            generations: nextGenerations,
            posts,
            profile,
        });
    }, [posts, profile, userId]);

    const loadGenerationById = useCallback(async (
        generationId: string,
        generation?: Generation
    ): Promise<Generation> => {
        if (generation && hasFullGenerationDetails(generation)) {
            return generation;
        }

        if (!accessToken || !userId) {
            router.push('/login');
            throw new Error('Authentication required.');
        }

        setGenerationDetailLoadingId(generationId);
        setGenerationDetailError(null);

        try {
            const response = await fetch(buildGenerationDetailUrl(generationId), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            const data = await response.json() as GenerationsApiResponse;

            if (!response.ok) {
                throw new Error('Failed to load creation details.');
            }

            const loadedGeneration = Array.isArray(data.generations) ? data.generations[0] : null;
            if (!loadedGeneration) {
                throw new Error('Creation details were not found.');
            }

            const mergedGeneration = generation
                ? mergeGenerationRefresh([generation], [loadedGeneration])[0]
                : loadedGeneration;
            const previousGenerations = generationsRef.current;
            const nextGenerations = previousGenerations.some((item) => item.id === mergedGeneration.id)
                ? previousGenerations.map((item) => item.id === mergedGeneration.id ? mergedGeneration : item)
                : [mergedGeneration, ...previousGenerations];
            cacheGenerations(nextGenerations);
            return mergedGeneration;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load creation details.';
            console.error('Failed to load creation details:', error);
            setGenerationDetailError(message);
            throw error;
        } finally {
            setGenerationDetailLoadingId(null);
        }
    }, [accessToken, cacheGenerations, router, userId]);

    const loadGenerationDetail = useCallback(
        (generation: Generation) => loadGenerationById(generation.id, generation),
        [loadGenerationById]
    );

    useEffect(() => {
        if (!requestedGenerationId || !accessToken || !userId) {
            return;
        }

        if (requestedGenerationRef.current === requestedGenerationId) {
            return;
        }

        requestedGenerationRef.current = requestedGenerationId;
        const existingGeneration = generationsRef.current.find(
            (generation) => generation.id === requestedGenerationId
        );

        void loadGenerationById(requestedGenerationId, existingGeneration)
            .then((generation) => {
                if (requestedGenerationRef.current === requestedGenerationId) {
                    setPreviewGen(generation);
                }
            })
            .catch(() => {
                if (requestedGenerationRef.current === requestedGenerationId) {
                    requestedGenerationRef.current = null;
                }
            });
    }, [accessToken, loadGenerationById, requestedGenerationId, userId]);

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

            void refreshProcessingGenerationStatuses();
        }, 30000);

        return () => {
            window.clearInterval(intervalId);
        };
    }, [hasProcessingGenerations, refreshProcessingGenerationStatuses]);

    const openPreviewModal = async (generation: Generation) => {
        try {
            const detailedGeneration = await loadGenerationDetail(generation);
            setPreviewGen(detailedGeneration);
        } catch {
            // Error state is stored in generationDetailError for the page-level notice.
        }
    };

    // The publish modal only opens for a generation that has no post yet.
    // Recipe changes on an existing post link to the editor instead, which
    // loads the stored bundle rather than rebuilding one from the prefill.
    const openPublishModal = useCallback(async (generation: Generation, options?: {
        shareAfterPublish?: boolean;
        showPaidShortcut?: boolean;
    }) => {
        try {
            const detailedGeneration = await loadGenerationDetail(generation);
            setPublishTarget(detailedGeneration);
            setShareAfterPublish(Boolean(options?.shareAfterPublish));
            setShowPaidShortcutInPublishModal(
                detailedGeneration.origin === 'template'
                    ? false
                    : options?.showPaidShortcut ?? true
            );
        } catch {
            // Error state is stored in generationDetailError for the page-level notice.
        }
    }, [loadGenerationDetail]);

    const closePublishModal = () => {
        setPublishTarget(null);
        setShareAfterPublish(false);
        setShowPaidShortcutInPublishModal(true);
    };

    const handlePublished = () => {
        void fetchCreations();
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

        if (generation.origin === 'template' && generation.template?.templateTitle?.trim()) {
            return generation.template.templateTitle.trim();
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
            if (generation.origin === 'template') {
                return `Final ${mediaKind} created from a reusable template. Open the run to review its progress or publish the result.`;
            }
            return `${mediaKind === 'audio' ? 'Audio' : mediaKind === 'image' ? 'Image' : 'Video'} is ready to preview, publish, or turn into a reusable recipe.`;
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
            generation.origin === 'template' ? { label: 'Origin', value: 'Template' } : null,
            { label: 'Model', value: generation.model },
            { label: 'Created', value: createdLabel },
            generation.cost !== null ? { label: 'Credits', value: `${generation.cost} credits` } : null,
            completedLabel ? { label: 'Render time', value: completedLabel.replace('Completed in ', '') } : null,
        ].filter((item): item is { label: string; value: string } => Boolean(item));
    };

    const renderPreviewActions = (generation: Generation) => {
        const workspaceState = resolveCreationWorkspaceCardState(generation, posts);
        const mediaKind = getMediaKind(generation);
        const isTemplateResult = generation.origin === 'template';
        const canManageFromCreation = mediaKind !== 'audio' && isShareSupported(generation);
        const primaryIsPublish = workspaceState.primaryAction.type === 'publish';
        const primaryIsUnlock =
            workspaceState.primaryAction.type === 'add-paywall' ||
            workspaceState.primaryAction.type === 'manage-paywall';
        const customizeHref = canManageFromCreation && !isTemplateResult
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
                            // This callback runs only after a click; detail loading reads the cache ref then.
                            void openPublishModal(generation);
                        }}
                        className={primaryClass}
                    >
                        <Globe className="h-4 w-4" />
                        Publish
                    </button>
                ) : null}

                {canManageFromCreation && primaryIsUnlock && workspaceState.primaryAction.href ? (
                    <Link
                        href={workspaceState.primaryAction.href}
                        onClick={() => setPreviewGen(null)}
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 sm:w-auto sm:min-w-40"
                    >
                        <Wand2 className="h-4 w-4" />
                        {workspaceState.primaryAction.label}
                    </Link>
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

                {isTemplateResult && generation.template?.runId ? (
                    <Link href={`/template-runs/${generation.template.runId}`} className={secondaryClass}>
                        <ExternalLink className="h-4 w-4" />
                        Open template run
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

                {!isTemplateResult ? (
                    <>
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
                ) : null}
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

    const successfulCreationCards = filteredSuccessful.map((generation) => ({
        generation,
        workspaceState: resolveCreationWorkspaceCardState(generation, posts),
    }));
    const profileReadiness = getCreatorProfileReadiness(profile);
    const publicProfileUsername = profileReadiness.hasClaimedHandle
        ? profile?.username?.trim() || null
        : null;
    const activePortfolioPostCount = posts.filter(
        (post) => !post.archivedAt && post.visibility === 'public'
    ).length;
    const activePostCount = posts.filter((post) => !post.archivedAt).length;
    const archivedPostCount = posts.length - activePostCount;
    const isProfileIncomplete = !profileReadiness.profileComplete;
    const hasPortfolioProof = successfulGenerations.length > 0 && activePortfolioPostCount > 0;
    const shouldShowPortfolioStarter = activeView === 'creations' && !isLoading && (
        successfulGenerations.length === 0 ||
        activePortfolioPostCount === 0 ||
        isProfileIncomplete
    );

    // One colour per meaning, shared with the visibility menu: sky is public,
    // violet is unlisted, neutral is private or gone. Amber is kept for
    // "draft" so an unlisted post never reads as a taken-down one.
    const getPublishBadgeTone = (badge: CreationWorkspacePublishBadge): StudioChipTone => {
        switch (badge) {
            case 'Public':
                return 'sky';
            case 'Unlisted':
                return 'violet';
            case 'Archived':
                return 'muted';
            case 'Private':
            case 'Not published':
            default:
                return 'neutral';
        }
    };

    const getMonetizationBadgeTone = (kind: CreationWorkspaceMonetizationKind): StudioChipTone => {
        switch (kind) {
            case 'free':
                return 'sky';
            case 'paid':
                return 'emerald';
            case 'draft':
                return 'amber';
            case 'none':
            default:
                return 'neutral';
        }
    };

    const getMonetizationBadgeLabel = (workspaceState: CreationWorkspaceCardState): string =>
        workspaceState.monetizationKind === 'paid' && workspaceState.monetizationPriceUsdCents !== null
            ? `${formatUsdCents(workspaceState.monetizationPriceUsdCents)} recipe`
            : workspaceState.monetizationLabel;

    return (
        <div className="ui-page ui-page-ambient min-h-screen">
            <input
                ref={restoreInputRef}
                type="file"
                accept={restoreTarget && getMediaKind(restoreTarget) === 'video' ? 'video/*' : 'image/*'}
                aria-label="Restore preview media"
                className="hidden"
                onChange={(event) => void handlePreviewRestoreFile(event)}
            />
            <div className="studio-shell relative z-10 py-8">
                {/* Header */}
                <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-4">
                        <div>
                            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
                                Studio
                            </h1>
                            <p className="text-sm text-zinc-500 font-medium tracking-wide">
                                {activeView === 'creations'
                                    ? `${successfulGenerations.length} CREATION${successfulGenerations.length !== 1 ? 'S' : ''} TOTAL`
                                    : activeView === 'posts'
                                        ? `${activePostCount} POST${activePostCount !== 1 ? 'S' : ''}${archivedPostCount > 0 ? ` · ${archivedPostCount} ARCHIVED` : ''}`
                                        : 'YOUR UNLOCKS'}
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 self-start">
                        <Link
                            href="/create"
                            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
                        >
                            <Wand2 className="h-4 w-4" />
                            Create
                        </Link>
                        <Link
                            href="/post/new?from=creations&returnTo=%2Fcreations%3Fview%3Dposts"
                            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-5 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
                        >
                            <Plus className="h-4 w-4" />
                            Post
                        </Link>
                        <Link
                            href="/profile"
                            className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-5 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[rgba(255,122,89,0.3)] hover:bg-[var(--ui-primary-soft)] hover:text-[var(--ui-text-primary)]"
                        >
                            <UserRound className="h-4 w-4" />
                            Manage profile
                        </Link>
                    </div>
                </div>

                <div className="mb-6 flex flex-wrap items-center gap-3">
                    {/* Links, not buttons: each section has its own URL, so the
                        browser's history and a shared link both know which one. */}
                    <nav aria-label="Studio sections" className="flex flex-wrap items-center gap-3">
                        {WORKSPACE_TABS.map((tab) => (
                            <Link
                                key={tab.key}
                                href={buildWorkspacePath(tab.key)}
                                scroll={false}
                                aria-current={activeView === tab.key ? 'page' : undefined}
                                className={`ui-focus-ring rounded-full border px-4 py-2.5 text-sm font-semibold transition ${
                                    activeView === tab.key
                                        ? 'border-white/20 bg-white/10 text-white'
                                        : 'border-white/8 bg-zinc-900/50 text-zinc-400 hover:border-white/14 hover:bg-zinc-800 hover:text-zinc-200'
                                }`}
                            >
                                {tab.label}
                            </Link>
                        ))}
                    </nav>
                    <div className="text-sm text-zinc-500">
                        {WORKSPACE_TABS.find((tab) => tab.key === activeView)?.lede}
                    </div>
                </div>

                {generationDetailError ? (
                    <div role="alert" className="mb-6 rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                        {generationDetailError}
                    </div>
                ) : null}

                {activeView === 'unlocks' ? <UnlockLibrary /> : null}

                {shouldShowPortfolioStarter ? (
                    <section className="mb-8 rounded-[28px] border border-[rgba(255,122,89,0.2)] bg-[var(--ui-surface-1)] p-5 shadow-[var(--ui-shadow-panel)] sm:p-6">
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
                                    <UserRound className="h-3.5 w-3.5 text-[var(--ui-primary)]" />
                                    Portfolio setup
                                </div>
                                <h2 className="mt-4 max-w-2xl text-2xl font-semibold tracking-tight text-white">
                                    {hasPortfolioProof
                                        ? 'Finish the profile behind your published work.'
                                        : 'Turn the first output into a profile-ready portfolio piece.'}
                                </h2>
                                <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300">
                                    {hasPortfolioProof
                                        ? 'Your creation and public proof are in place. Add the remaining identity details so visitors and buyers know who is behind the work.'
                                        : 'New creators have three jobs here: shape the profile, create proof, then publish the strongest result with an optional recipe.'}
                                </p>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row lg:justify-end">
                                <Link
                                    href="/profile?next=%2Fcreations"
                                    className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200"
                                >
                                    <UserRound className="h-4 w-4" />
                                    {profileReadiness.publicPublishReady ? 'Complete profile' : 'Set up profile'}
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
                                    title: profileReadiness.profileComplete
                                        ? 'Creator profile ready'
                                        : profileReadiness.publicPublishReady
                                            ? 'Strengthen creator profile'
                                            : 'Finish creator identity',
                                    body: profileReadiness.profileComplete
                                        ? 'Your handle, name, avatar, and bio are ready for visitors and buyers.'
                                        : profileReadiness.sellerReady
                                            ? 'Your selling identity is ready. Add a short bio so visitors understand your work.'
                                            : profileReadiness.publicPublishReady
                                                ? 'Your public identity is ready. Add an avatar so people recognize your work.'
                                                : 'Choose a custom handle and display name before publishing publicly.',
                                    ready: profileReadiness.profileComplete,
                                },
                                {
                                    title: successfulGenerations.length > 0 ? 'Creation ready' : 'Create one proof piece',
                                    body: 'Use image, video, motion, or workflow to make the first visual result.',
                                    ready: successfulGenerations.length > 0,
                                },
                                {
                                    title: activePortfolioPostCount > 0 ? 'Portfolio has posts' : 'Publish to portfolio',
                                    body: 'Use Publish to add the result publicly, or attach a paid recipe for the reusable process.',
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
                    <div role="group" aria-label="Filter posts by visibility" className="mb-8 flex flex-wrap gap-2">
                        {([
                            { key: 'all', label: `All (${activePostCount})` },
                            { key: 'public', label: `Public (${posts.filter((post) => !post.archivedAt && post.visibility === 'public').length})` },
                            { key: 'unlisted', label: `Unlisted (${posts.filter((post) => !post.archivedAt && post.visibility === 'unlisted').length})` },
                            { key: 'private', label: `Private (${posts.filter((post) => !post.archivedAt && post.visibility === 'private').length})` },
                            { key: 'archived', label: `Archived (${archivedPostCount})` },
                        ] as Array<{ key: OwnerPostVisibilityFilter; label: string }>).map((tab) => (
                            // A filter is a refinement of the current section, so it
                            // replaces the history entry instead of adding one.
                            <Link
                                key={tab.key}
                                href={buildWorkspacePath('posts', tab.key)}
                                replace
                                scroll={false}
                                aria-current={postVisibilityFilter === tab.key ? 'true' : undefined}
                                className={`ui-focus-ring rounded-full border px-4 py-2 text-sm font-semibold transition ${
                                    postVisibilityFilter === tab.key
                                        ? 'border-white/20 bg-white/10 text-white'
                                        : 'border-white/8 bg-zinc-900/50 text-zinc-400 hover:border-white/14 hover:bg-zinc-800 hover:text-zinc-200'
                                }`}
                            >
                                {tab.label}
                            </Link>
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
                                Make one strong output, publish it to your creator profile, then add a recipe when the prompt, workflow, or setup is worth sharing.
                            </p>
                        </div>
                        <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
                            {[
                                { icon: UserRound, title: 'Profile', body: 'Custom handle, name, and avatar.' },
                                { icon: Wand2, title: 'Create', body: 'Generate image, video, or motion.' },
                                { icon: Globe, title: 'Publish', body: 'Add to your profile or attach a recipe.' },
                            ].map((item) => {
                                const Icon = item.icon;
                                return (
                                    <div key={item.title} className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-left">
                                        <Icon className="h-5 w-5 text-[var(--ui-primary)]" />
                                        <div className="mt-3 text-sm font-semibold text-white">{item.title}</div>
                                        <p className="mt-1 text-xs leading-5 text-zinc-500">{item.body}</p>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row">
                            <Link href="/create" className="ui-focus-ring inline-flex items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 py-3 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]">
                                <Wand2 className="h-4 w-4" />
                                Choose a creator tool
                            </Link>
                            <Link href="/profile?next=%2Fcreations" className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]">
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
                                <StudioCard
                                    key={gen.id}
                                    density="compact"
                                    tone="processing"
                                    media={(
                                        <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                            <div className="flex flex-col items-center gap-3">
                                                <Loader2 className="h-8 w-8 animate-spin text-yellow-400" />
                                                <span className="text-xs text-zinc-400">{getStartedAgoLabel(gen) ?? 'Still processing in background...'}</span>
                                            </div>
                                        </div>
                                    )}
                                    chips={<StudioChip tone="amber">Processing</StudioChip>}
                                    title={getPreviewTitle(gen)}
                                    meta={[{ label: 'Started', value: formatDate(gen.created_at) }]}
                                />
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
                                const isTemplateResult = gen.origin === 'template';
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
                                const kindTone: StudioChipTone = isImage ? 'sky' : isAudio ? 'emerald' : 'rose';
                                const badgeLabel = isImage ? 'Image' : isAudio ? 'Audio' : 'Video';
                                const publishBadgeLabel = workspaceState.publishBadge;
                                const monetizationBadgeLabel = getMonetizationBadgeLabel(workspaceState);
                                const linkedPostPublicPath = workspaceState.linkedPost?.publicPath ?? null;
                                const canCopyLinkedPost =
                                    Boolean(workspaceState.linkedPost?.canShare) &&
                                    Boolean(linkedPostPublicPath);
                                const linkedPostTarget = workspaceState.linkedPost && !workspaceState.linkedPost.archivedAt
                                    ? resolveLinkedPostTarget(gen, workspaceState.linkedPost)
                                    : null;
                                const linkedPostPendingAction = linkedPostTarget
                                    ? postLifecycle.pendingAction(linkedPostTarget.id)
                                    : null;
                                const hasPrimaryAction =
                                    canManageFromCreation &&
                                    workspaceState.primaryAction.type !== 'none' &&
                                    Boolean(workspaceState.primaryAction.label);
                                const primaryIsPublish = workspaceState.primaryAction.type === 'publish';
                                const primaryIsUnlock =
                                    !isTemplateResult && (
                                        workspaceState.primaryAction.type === 'add-paywall' ||
                                        workspaceState.primaryAction.type === 'manage-paywall'
                                    );
                                const createdShort = new Date(gen.created_at).toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                });
                                // The linked post's own page opens from its title in the
                                // detail block, so the footer stays one row.
                                const linkedPostHref = hasPrimaryAction && !primaryIsPublish
                                    ? workspaceState.secondaryAction.href ?? null
                                    : null;
                                const isGenerationDetailLoading = generationDetailLoadingId === gen.id;
                                const cardTitle = getPreviewTitle(gen);
                                const overflowItems: StudioOverflowMenuItem[] = [];
                                if (canCopyLinkedPost && linkedPostPublicPath) {
                                    overflowItems.push({
                                        key: 'copy-link',
                                        label: 'Copy post link',
                                        icon: <Copy className="h-4 w-4" />,
                                        onSelect: () => void copyPostLink(linkedPostPublicPath),
                                    });
                                }
                                if (primaryMediaUrl) {
                                    overflowItems.push({
                                        key: 'download',
                                        label: 'Download creation',
                                        icon: <Download className="h-4 w-4" />,
                                        href: primaryMediaUrl,
                                        download: `creation_${gen.id}.${inferDownloadExtension(gen)}`,
                                    });
                                }
                                if (!isTemplateResult) {
                                    overflowItems.push(
                                        {
                                            key: 'archive',
                                            label: 'Archive creation',
                                            icon: <Archive className="h-4 w-4" />,
                                            tone: 'warning',
                                            onSelect: () => void handleGenerationArchive(gen.id),
                                        },
                                        {
                                            key: 'delete',
                                            label: 'Delete creation',
                                            icon: <Trash2 className="h-4 w-4" />,
                                            tone: 'danger',
                                            onSelect: () => void handleGenerationDelete(gen.id),
                                        },
                                    );
                                }
                                return (
                                    <StudioCard
                                        key={gen.id}
                                        density="compact"
                                        testId={`creation-card-${gen.id}`}
                                        media={primaryMediaUrl ? (
                                            <CreationMediaFrame
                                                key={primaryMediaUrl}
                                                id={gen.id}
                                                mediaKind={mediaKind}
                                                src={primaryMediaUrl}
                                                posterSrc={gen.preview_url}
                                                alt={isImage ? 'Generated image' : `${badgeLabel} generation`}
                                                outputCount={Math.max(outputUrls.length, gen.output_count ?? 0)}
                                                onOpen={() => void openPreviewModal(gen)}
                                                onRestore={!isAudio && !isTemplateResult ? () => requestPreviewRestore(gen) : undefined}
                                                isRestoring={restoringGenerationId === gen.id}
                                            />
                                        ) : null}
                                        badge={(
                                            <StudioKindBadge tone={kindTone} icon={<MediaIcon className="h-3.5 w-3.5" />}>
                                                {badgeLabel}
                                            </StudioKindBadge>
                                        )}
                                        chips={(
                                            <>
                                                {isTemplateResult ? <StudioChip tone="emerald">From template</StudioChip> : null}
                                                <StudioChip tone={getPublishBadgeTone(publishBadgeLabel)}>{publishBadgeLabel}</StudioChip>
                                                <StudioChip tone={getMonetizationBadgeTone(workspaceState.monetizationKind)}>{monetizationBadgeLabel}</StudioChip>
                                            </>
                                        )}
                                        title={cardTitle}
                                        summary={getPreviewSummary(gen)}
                                        meta={[
                                            { label: 'Created', value: createdShort },
                                            {
                                                label: 'Render',
                                                value: (
                                                    <>
                                                        <Clock className="h-3 w-3 text-zinc-500" />
                                                        {gen.duration ? `${Math.round(gen.duration)}s` : completedInLabel?.replace('Completed in ', '') ?? 'Ready'}
                                                    </>
                                                ),
                                            },
                                            {
                                                label: 'Credits',
                                                value: (
                                                    <>
                                                        <Zap className="h-3 w-3 text-zinc-500" />
                                                        {gen.cost ?? 0}
                                                    </>
                                                ),
                                            },
                                        ]}
                                        detail={workspaceState.linkedPost ? (
                                            <StudioDetail
                                                label="Linked post"
                                                trailing={linkedPostTarget ? (
                                                    <PostVisibilityMenu
                                                        value={linkedPostTarget.visibility}
                                                        onChange={(next) => void postLifecycle.setVisibility(linkedPostTarget, next)}
                                                        pending={linkedPostPendingAction === 'visibility'}
                                                        disabled={Boolean(linkedPostPendingAction)}
                                                        label={`Visibility of ${workspaceState.linkedPost.title}`}
                                                        align="end"
                                                        size="sm"
                                                    />
                                                ) : (
                                                    <StudioChip tone="muted">Archived</StudioChip>
                                                )}
                                            >
                                                {linkedPostHref ? (
                                                    <Link
                                                        href={linkedPostHref}
                                                        aria-label={workspaceState.secondaryAction.label ?? 'Open post'}
                                                        className="ui-focus-ring flex items-center gap-1.5 rounded-md text-sm font-semibold text-white transition hover:text-[var(--ui-primary)]"
                                                    >
                                                        <span className="truncate">{workspaceState.linkedPost.title}</span>
                                                        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                                                    </Link>
                                                ) : (
                                                    <div className="truncate text-sm font-semibold text-white">{workspaceState.linkedPost.title}</div>
                                                )}
                                            </StudioDetail>
                                        ) : null}
                                        primaryAction={hasPrimaryAction ? (
                                            primaryIsPublish ? (
                                                <button
                                                    type="button"
                                                    onClick={() => void openPublishModal(gen)}
                                                    disabled={isGenerationDetailLoading}
                                                    className={studioActionClass('primary', { size: 'md', full: true })}
                                                >
                                                    {isGenerationDetailLoading ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Globe className="h-4 w-4" />
                                                    )}
                                                    {workspaceState.primaryAction.label}
                                                </button>
                                            ) : primaryIsUnlock && workspaceState.primaryAction.href ? (
                                                <Link
                                                    href={workspaceState.primaryAction.href}
                                                    className={studioActionClass('emerald', { size: 'md', full: true })}
                                                >
                                                    <Wand2 className="h-4 w-4" />
                                                    {workspaceState.primaryAction.label}
                                                </Link>
                                            ) : null
                                        ) : null}
                                        actions={(
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() => void openPreviewModal(gen)}
                                                    disabled={isGenerationDetailLoading}
                                                    className={studioActionClass('secondary')}
                                                >
                                                    {isGenerationDetailLoading ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        <Eye className="h-3.5 w-3.5" />
                                                    )}
                                                    Details
                                                </button>
                                                {isTemplateResult && gen.template?.runId ? (
                                                    <Link
                                                        href={`/template-runs/${gen.template.runId}`}
                                                        className={studioActionClass('emerald')}
                                                    >
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                        Open run
                                                    </Link>
                                                ) : null}
                                            </>
                                        )}
                                        menu={<StudioOverflowMenu label={`More actions for ${cardTitle}`} items={overflowItems} />}
                                    />
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
                            {failedGenerations.map((gen) => {
                                const failedTitle = getPreviewTitle(gen);
                                return (
                                    <StudioCard
                                        key={gen.id}
                                        density="compact"
                                        tone="failed"
                                        media={(
                                            <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                                <span className="text-xs text-red-400/60">Generation failed</span>
                                            </div>
                                        )}
                                        chips={<StudioChip tone="rose">Failed</StudioChip>}
                                        title={failedTitle}
                                        meta={[
                                            { label: 'Created', value: formatDate(gen.created_at) },
                                            ...(gen.cost ? [{
                                                label: 'Credits',
                                                value: (
                                                    <>
                                                        <Zap className="h-3 w-3 text-zinc-500" />
                                                        {gen.cost}
                                                    </>
                                                ),
                                            }] : []),
                                        ]}
                                        menu={(
                                            <StudioOverflowMenu
                                                label={`More actions for ${failedTitle}`}
                                                items={[{
                                                    key: 'delete',
                                                    label: 'Delete creation',
                                                    icon: <Trash2 className="h-4 w-4" />,
                                                    tone: 'danger',
                                                    onSelect: () => void handleGenerationDelete(gen.id),
                                                }]}
                                            />
                                        )}
                                    />
                                );
                            })}
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
                            {archivedGenerations.map((gen) => {
                                const archivedTitle = getPreviewTitle(gen);
                                return (
                                    <StudioCard
                                        key={gen.id}
                                        density="compact"
                                        tone="archived"
                                        media={(
                                            <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                                <Archive className="h-8 w-8 text-zinc-600" />
                                            </div>
                                        )}
                                        chips={<StudioChip tone="muted">Archived</StudioChip>}
                                        title={archivedTitle}
                                        meta={[{ label: 'Created', value: formatDate(gen.created_at) }]}
                                        actions={(
                                            <button
                                                type="button"
                                                onClick={() => void handleGenerationRestore(gen.id)}
                                                className={studioActionClass('emerald')}
                                            >
                                                <RotateCcw className="h-3.5 w-3.5" />
                                                Restore
                                            </button>
                                        )}
                                        menu={(
                                            <StudioOverflowMenu
                                                label={`More actions for ${archivedTitle}`}
                                                items={[{
                                                    key: 'delete',
                                                    label: 'Delete creation',
                                                    icon: <Trash2 className="h-4 w-4" />,
                                                    tone: 'danger',
                                                    onSelect: () => void handleGenerationDelete(gen.id),
                                                }]}
                                            />
                                        )}
                                    />
                                );
                            })}
                        </div>
                    </div>
                )}

                {activeView === 'creations' && !isLoading && generationsNextCursor ? (
                    <div className="mb-10 flex flex-col items-center gap-3">
                        {generationsLoadMoreError ? (
                            <p className="text-sm text-rose-300">{generationsLoadMoreError}</p>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => void loadMoreGenerations()}
                            disabled={isLoadingMoreGenerations}
                            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isLoadingMoreGenerations ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RotateCcw className="h-4 w-4" />
                            )}
                            {isLoadingMoreGenerations ? 'Loading more...' : 'Load more creations'}
                        </button>
                    </div>
                ) : null}

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
                        {postsNextOffset !== null ? (
                            <button
                                type="button"
                                onClick={() => void loadMorePosts()}
                                disabled={isLoadingMorePosts}
                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {isLoadingMorePosts ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <RotateCcw className="h-4 w-4" />
                                )}
                                {isLoadingMorePosts ? 'Loading older posts...' : 'Search older posts'}
                            </button>
                        ) : null}
                        {postsLoadMoreError ? (
                            <p className="text-sm text-rose-300">{postsLoadMoreError}</p>
                        ) : null}
                        <Link
                            href="/post/new?from=creations&returnTo=%2Fcreations%3Fview%3Dposts"
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
                                Post Library is the management view for editing, publishing, attaching recipes, archiving, and cleanup.
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
                                const categoryLabel = post.mediaKind === 'video'
                                    ? 'Video'
                                    : post.mediaKind === 'image'
                                        ? 'Image'
                                        : post.postFormat === 'text'
                                            ? 'Text'
                                            : post.category;
                                const kindTone: StudioChipTone = post.mediaKind === 'video'
                                    ? 'rose'
                                    : post.mediaKind === 'image'
                                        ? 'sky'
                                        : 'neutral';
                                const pendingAction = postLifecycle.pendingAction(post.id);
                                const isBusy = Boolean(pendingAction);
                                const overflowItems: StudioOverflowMenuItem[] = [];
                                if (post.canShare) {
                                    overflowItems.push({
                                        key: 'copy-link',
                                        label: 'Copy post link',
                                        icon: <Copy className="h-4 w-4" />,
                                        onSelect: () => void copyPostLink(post.publicPath ?? `/showcase/${post.id}`),
                                    });
                                }
                                overflowItems.push(post.archivedAt
                                    ? {
                                        key: 'restore',
                                        label: 'Restore post',
                                        icon: <RotateCcw className="h-4 w-4" />,
                                        tone: 'success',
                                        disabled: isBusy,
                                        pending: pendingAction === 'restore',
                                        onSelect: () => void postLifecycle.restore(post),
                                    }
                                    : {
                                        key: 'archive',
                                        label: 'Archive post',
                                        icon: <Archive className="h-4 w-4" />,
                                        tone: 'warning',
                                        disabled: isBusy,
                                        pending: pendingAction === 'archive',
                                        onSelect: () => void postLifecycle.archive(post),
                                    });
                                overflowItems.push({
                                    key: 'delete',
                                    label: 'Delete post',
                                    icon: <Trash2 className="h-4 w-4" />,
                                    tone: 'danger',
                                    disabled: isBusy,
                                    pending: pendingAction === 'delete',
                                    onSelect: () => void postLifecycle.remove(post),
                                });

                                return (
                                    <StudioCard
                                        key={post.id}
                                        density="expanded"
                                        tone={post.archivedAt ? 'archived' : 'default'}
                                        media={post.mediaUrl ? (
                                            post.mediaKind === 'video' ? (
                                                // Poster at rest, playback on hover: a page of rows must not
                                                // start a metadata fetch of every full-size video.
                                                <HoverVideo
                                                    src={resolvePlaybackUrl({ url: post.mediaUrl, renditionUrl: post.mediaItems?.[0]?.renditionUrl })}
                                                    poster={post.mediaItems?.[0]?.previewUrl}
                                                    className="aspect-[4/5] w-full object-cover"
                                                />
                                            ) : (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={post.mediaUrl} alt={post.title} loading="lazy" decoding="async" className="aspect-[4/5] w-full object-cover" />
                                            )
                                        ) : (
                                            <div className="flex aspect-[4/5] w-full items-center justify-center p-4 text-sm leading-6 text-zinc-400">
                                                <span className="line-clamp-6">{post.body || 'Text post'}</span>
                                            </div>
                                        )}
                                        badge={<StudioKindBadge tone={kindTone}>{categoryLabel}</StudioKindBadge>}
                                        chips={post.archivedAt || post.bundle ? (
                                            <>
                                                {/* Live visibility is the menu in the action row; only the archived state needs a chip. */}
                                                {post.archivedAt ? <StudioChip tone="muted">Archived</StudioChip> : null}
                                                {post.bundle ? (
                                                    <StudioChip tone={post.bundle.status === 'published' ? 'emerald' : 'amber'}>
                                                        {post.bundle.status === 'published' ? 'Recipe live' : 'Recipe draft'}
                                                    </StudioChip>
                                                ) : null}
                                            </>
                                        ) : null}
                                        title={(
                                            <Link href={post.ownerPath} className="transition hover:text-[var(--ui-primary)]">
                                                {post.title}
                                            </Link>
                                        )}
                                        subtitle={`${post.sourceLabel} · Updated ${updatedLabel}`}
                                        summary={postSummary}
                                        detail={post.bundle ? (
                                            <StudioDetail
                                                label="Recipe"
                                                labelTone="text-emerald-300/80"
                                                trailing={(
                                                    <span className="text-xs leading-5 text-zinc-500">
                                                        {post.bundle.salesCount} sold · {formatUsdCents(post.bundle.earningsUsdCents)} earned
                                                    </span>
                                                )}
                                            >
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <StudioChip tone="neutral">
                                                        {post.bundle.accessMode === 'free'
                                                            ? 'Free recipe'
                                                            : formatUsdCents(post.bundle.priceUsdCents)}
                                                    </StudioChip>
                                                    {post.bundle.resourceKinds.slice(0, 4).map((kind) => (
                                                        <StudioChip key={`${post.id}-${kind}`} tone="neutral" className="text-zinc-300">
                                                            {getPostResourceKindLabel(kind)}
                                                        </StudioChip>
                                                    ))}
                                                </div>
                                            </StudioDetail>
                                        ) : (
                                            <StudioDetail
                                                label="Recipe"
                                                trailing={<StudioChip tone="neutral" className="text-zinc-300">No recipe</StudioChip>}
                                            >
                                                <p className="text-sm text-zinc-300">No reusable prompt, files, notes, or workflow attached.</p>
                                            </StudioDetail>
                                        )}
                                        actions={(
                                            <>
                                                <Link
                                                    href={post.ownerPath}
                                                    className={studioActionClass('primary', { size: 'md' })}
                                                >
                                                    <PencilLine className="h-4 w-4" />
                                                    Edit post
                                                </Link>
                                                {post.publicPath ? (
                                                    <Link
                                                        href={buildStudioDetailPath(post.id)}
                                                        className={studioActionClass('secondary', { size: 'md' })}
                                                    >
                                                        <ExternalLink className="h-4 w-4" />
                                                        View live
                                                    </Link>
                                                ) : null}
                                                {!post.archivedAt ? (
                                                    <PostVisibilityMenu
                                                        value={post.visibility}
                                                        onChange={(next) => void postLifecycle.setVisibility(post, next)}
                                                        pending={pendingAction === 'visibility'}
                                                        disabled={isBusy}
                                                        label={`Visibility of ${post.title}`}
                                                    />
                                                ) : null}
                                                {!post.archivedAt ? (
                                                    <Link
                                                        href={buildPostRecipeManagementPath(post)}
                                                        className={studioActionClass('emerald', { size: 'md' })}
                                                    >
                                                        <Wand2 className="h-4 w-4" />
                                                        {post.bundle ? 'Manage recipe' : 'Add recipe'}
                                                    </Link>
                                                ) : null}
                                            </>
                                        )}
                                        menu={<StudioOverflowMenu label={`More actions for ${post.title}`} items={overflowItems} />}
                                    />
                                );
                            })}
                        </div>
                        {postsNextOffset !== null ? (
                            <div className="mt-6 flex flex-col items-center gap-3">
                                {postsLoadMoreError ? (
                                    <p className="text-sm text-rose-300">{postsLoadMoreError}</p>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() => void loadMorePosts()}
                                    disabled={isLoadingMorePosts}
                                    className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {isLoadingMorePosts ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <RotateCcw className="h-4 w-4" />
                                    )}
                                    {isLoadingMorePosts ? 'Loading more...' : 'Load more posts'}
                                </button>
                            </div>
                        ) : null}
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
                defaultTitle={publishTarget?.title ?? publishTarget?.template?.templateTitle ?? ''}
                defaultDescription={publishTarget?.description ?? ''}
                showPaidShortcut={showPaidShortcutInPublishModal}
                mediaOnly={publishTarget?.origin === 'template'}
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
