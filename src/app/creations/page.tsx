'use client';

import { readJsonResponse } from '@/lib/read-json-response';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Archive, CheckCircle2, ChevronDown, ChevronUp, Clock, Copy, Download, ExternalLink, Eye, Film, Flag, Globe, ImageIcon, Loader2, PencilLine, RotateCcw, Trash2, UserRound, Volume2, Wand2, Zap } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/DesignSystem';
import MediaDetailsPreviewModal, {
    type MediaDetailsStatusNote,
    type MediaDetailsType,
} from '@/components/MediaDetailsPreviewModal';
import PostVisibilityMenu from '@/components/PostVisibilityMenu';
import StudioOverflowMenu, { type StudioOverflowMenuItem } from '@/components/StudioOverflowMenu';
import {
    forgetStudioReturnedPost,
    getCreationsWorkspaceCacheKey,
    parseCreationMediaFilter,
    parseStudioPostFilter,
    parseStudioWorkspaceView,
    readStudioReturnedPost,
    type StudioWorkspaceView,
} from '@/lib/creations-workspace-cache';
import SkeletonLoader from '@/components/SkeletonLoader';
import {
    usePostLifecycle,
    type PostLifecyclePatch,
    type PostLifecycleRemoval,
    type PostLifecycleTarget,
} from '@/components/usePostLifecycle';
import { HoverVideo } from '@/components/HoverVideo';
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
    buildCreationComposerPath,
    buildPostRecipeManagementPath,
    getCreationMediaFilters,
    getCreationMediaKindFilter,
    getStudioCreationCounts,
    getStudioPostCounts,
    getStudioPostFilters,
    moveStudioCreationTotals,
    moveStudioPostTotals,
    resolveCreationWorkspaceCardState,
    type CreationMediaFilter,
    type CreationWorkspaceCardState,
    type CreationWorkspaceMonetizationKind,
    type CreationWorkspacePublishBadge,
    type StudioPostFilter,
    type StudioPostPlace,
    type StudioTotal,
} from '@/lib/creation-workspace';
import { formatDurationShort, formatTimeAgoShort } from '@/lib/generation-timing';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import { resolvePlaybackUrl } from '@/lib/media-descriptor';
import { buildMediaProxyUrl, getDisplayMediaUrl, getStoredMediaLocation } from '@/lib/media-urls';
import { isAudioModel, isImageModel, isMotionModel } from '@/lib/client-generation-models';
import { pushToast, requestConfirmation } from '@/components/feedback-state';
import { HOME_WORKSPACE_ACTIVE_STATUSES } from '@/lib/home-dashboard';
import { reportGeneration } from '@/lib/moderation-client';
import {
    pushReelEntry,
    readCurrentReelHistoryMode,
    readReelHistoryMode,
    replaceReelEntry,
    type ReelHistoryMode,
} from '@/lib/reel-history-entry';
import { buildCreatorNameStepPath } from '@/lib/auth-onboarding';
import { getCreatorProfileReadiness, type ProfileApiResponse } from '@/lib/profile';
import { resolveRemixTool } from '@/lib/remix-tools';
import {
  formatPostResourceCompactPriceLabel,
  formatUsdCents,
  getPostResourceKindLabel,
} from '@/lib/post-resource-bundles';
import UnlockLibrary from './UnlockLibrary';
import { SHARE_SOURCE_QUERY_PARAM, buildShowcaseDetailPath, supportsPublicCreationSharing } from '@/lib/share';
import { withSharersInvite } from '@/lib/share-client';
import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';
import UnavailableMediaNote from '@/components/UnavailableMediaNote';
import IntentLink from '@/components/IntentLink';

interface Generation {
    id: string;
    media?: { renditionUrl?: string | null } | null;
    output_url: string | null;
    /** Set when the only source is gone; the API withholds every address. */
    source_unavailable_at?: string | null;
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
    /** The linked post's recipe, for a post older than the loaded posts page. */
    linked_post_bundle?: {
        accessMode: 'free' | 'paid';
        status: 'draft' | 'published';
        priceUsdCents: number;
    } | null;
    /** A failed run whose cost settlement gave back. */
    refunded?: boolean;
    /** Why a failed run failed, in public words; null for every other status. */
    error_message?: string | null;
    /** Moderation took it down: it is archived, and Restore refuses it. */
    moderation_removed_at?: string | null;
    paywallPrefill?: GenerationPaywallPrefill | null;
    origin?: 'creation' | 'template';
    template?: {
        runId: string;
        templateId: string;
        templateTitle: string | null;
        /** How the run ended; a cancelled or failed run lists its finished steps. */
        runStatus?: 'succeeded' | 'cancelled' | 'failed';
    } | null;
}

type FilterType = CreationMediaFilter;
type WorkspaceView = StudioWorkspaceView;
type OwnerPostVisibilityFilter = StudioPostFilter;

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
      sourceUnavailableAt?: string | null;
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
        /** Paid unlocks. */
        salesCount: number;
        /** Free unlocks, which stopped counting as sales on 2026-10-17 (decision 6). */
        freeUnlockCount: number;
        earningsUsdCents: number;
        resourceKinds: Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>;
        /** Set once its creator took it off while people had it: they keep it, the post has none. */
        retiredAt?: string | null;
    } | null;
}

interface CreationsWorkspaceCache {
    fetchedAt: number;
    generations: Generation[];
    posts: OwnerPost[];
    profile: ProfileApiResponse | null;
    /**
     * Whether `generations` held the whole library, the list's last page loaded: a return to
     * Studio draws the media filters' totals at once rather than when the refresh lands.
     */
    generationsComplete: boolean;
    /** Whether `posts` held every post, the list's last page loaded, as `generationsComplete`. */
    postsComplete: boolean;
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
const GENERATION_HIGHLIGHT_MS = 4000;
// The portfolio setup card's name, and its parts that Steps shows and hides on a phone.
const PORTFOLIO_SETUP_LABEL_ID = 'studio-portfolio-setup-label';
const PORTFOLIO_SETUP_MORE_ID = 'studio-portfolio-setup-more';
const PORTFOLIO_SETUP_STEPS_ID = 'studio-portfolio-setup-steps';

function getGenerationCardAnchorId(generationId: string): string {
    return `studio-generation-${generationId}`;
}

function getPostCardAnchorId(postId: string): string {
    return `studio-post-${postId}`;
}

/**
 * Paid sales and earnings, with free unlocks beside them once there are any:
 * a free unlock is not a sale since 2026-10-17 (decision 6).
 */
/**
 * A post as Studio draws it. A recipe taken off while people had it stays for
 * them (retired), but the post has none, as the editor and Recipe sales read
 * it: drawn as a draft with Manage recipe, its link reopened the editor on the
 * recipe's old mode and the removal looked undone.
 */
function withoutRetiredRecipe(post: OwnerPost): OwnerPost {
    return post.bundle?.retiredAt ? { ...post, bundle: null } : post;
}

/** Sets one parameter of an internal path, keeping its other parameters and its fragment. */
function withSearchParam(path: string, key: string, value: string): string {
    const [pathWithoutHash, hash = ''] = path.split('#');
    const [pathnamePart, query = ''] = pathWithoutHash.split('?');
    const params = new URLSearchParams(query);
    params.set(key, value);
    const nextQuery = params.toString();
    return `${pathnamePart}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
}

function formatRecipeTrackRecord(bundle: NonNullable<OwnerPost['bundle']>): string {
    const freeUnlocks = bundle.freeUnlockCount > 0
        ? ` · ${bundle.freeUnlockCount} free unlock${bundle.freeUnlockCount === 1 ? '' : 's'}`
        : '';
    return `${bundle.salesCount} sold${freeUnlocks} · ${formatUsdCents(bundle.earningsUsdCents)} earned`;
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
            posts: Array.isArray(parsed.posts) ? (parsed.posts as OwnerPost[]).map(withoutRetiredRecipe) : [],
            profile: isRecord(parsed.profile) ? parsed.profile as unknown as ProfileApiResponse : null,
            // A snapshot written before the flag, or by a list with pages still to load, says no.
            generationsComplete: parsed.generationsComplete === true,
            postsComplete: parsed.postsComplete === true,
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

function isActiveGenerationStatus(status: string): boolean {
    return (HOME_WORKSPACE_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * The creator for a Recreate of this creation, with the remix prefill. A
 * motion run is stored as category 'video', so the model decides first.
 */
function recreateHref(generation: Generation): string {
    const tool = isMotionModel(generation.model) ? 'motion' : resolveRemixTool(generation.category);
    return `/create-${tool}?remix=${encodeURIComponent(generation.id)}`;
}

/** Audio and template results have no creator to reopen in. */
function canRecreate(generation: Generation): boolean {
    return generation.origin !== 'template' && !isAudioModel(generation.model);
}

/** "40 credits returned" when settling a failed run gave its cost back; null when it kept it. */
function getReturnedCreditsLabel(generation: Generation): string | null {
    const cost = generation.cost ?? 0;
    if (generation.status !== 'failed' || generation.refunded !== true || cost <= 0) {
        return null;
    }
    return `${cost} credit${cost === 1 ? '' : 's'} returned`;
}

/**
 * How the template run behind a finished step ended, when it did not succeed.
 * Those steps are listed so you keep what you paid for, but only a succeeded
 * run's result may publish (`showcase-publish-service.ts`).
 */
function getEndedTemplateRunStatus(generation: Generation): 'cancelled' | 'failed' | null {
    const runStatus = generation.origin === 'template' ? generation.template?.runStatus : undefined;
    return runStatus === 'cancelled' || runStatus === 'failed' ? runStatus : null;
}

/**
 * The tile's file through the media route, which signs a new address on
 * every request, or the original's when the tile already plays through the
 * route (a playback rendition). Null when the route can serve neither.
 */
function getFreshTileUrl(tileUrl: string, originalUrl: string): string | null {
    return [getDisplayMediaUrl(tileUrl), getDisplayMediaUrl(originalUrl)]
        .find((candidate) => Boolean(candidate) && candidate !== tileUrl) ?? null;
}

/**
 * A download through the media route, which answers with an attachment: a
 * Storage address is cross-origin, so browsers ignore `download` on it and
 * only opened a tab. A file the route cannot serve keeps its own address.
 */
function getCreationDownloadUrl(url: string, filename: string): string {
    const location = getStoredMediaLocation(url);
    return location
        ? buildMediaProxyUrl(location.bucket, location.filePath, { download: true, filename })
        : url;
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

/** Studio's address with a creation open in its preview, or with none; the rest of it kept. */
function studioPreviewAddress(generationId: string | null): string {
    const params = new URLSearchParams(window.location.search);
    if (generationId) params.set('generation', generationId);
    else params.delete('generation');
    const query = params.toString();
    return `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
}

function getNextGenerationCursor(payload: GenerationsApiResponse): string | null {
    const nextCursor = payload.pagination?.nextCursor;
    return typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null;
}

/**
 * A finished creation, archived or not: a succeeded run with an output, or one whose only source
 * is gone (its tile stays, with a note). Studio's grid and the server's library total
 * (`owner_profile_counts`) count these, the active ones.
 */
function isFinishedCreation(generation: Generation): boolean {
    return generation.status === 'succeeded' && Boolean(generation.output_url || generation.source_unavailable_at);
}

function getGenerationCategory(generation: Generation): 'image' | 'video' | 'audio' | 'motion' | 'ugc-ad' {
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
}

/**
 * The kind the grid draws a creation as, and the media filter that lists it
 * (`getCreationMediaKindFilter`). The list sends every creation's category as
 * it reads it, from the file and then the stored category, which is the rule
 * `owner_profile_counts` splits the library's total by (`creationsByKind`).
 */
function getMediaKind(generation: Generation): 'image' | 'video' | 'audio' {
    const category = getGenerationCategory(generation);
    if (category === 'image') return 'image';
    if (category === 'audio') return 'audio';
    return 'video';
}

/**
 * The list's next cursor one row earlier, after a row before it was deleted here. The owner
 * list's cursor is the offset of its next row (`buildPagination` in
 * owner-generations-route-service.ts); one in any other form is left as it is.
 */
function stepGenerationsCursorBack(cursor: string | null): string | null {
    if (cursor === null || !/^\d+$/.test(cursor)) return cursor;
    return String(Math.max(0, Number(cursor) - 1));
}

function mergeGenerationRefresh(
    previousGenerations: Generation[],
    incomingGenerations: Generation[],
    options: {
        /**
         * Later pages are loaded: keep the rows the fresh first page no longer
         * reaches because newer work pushed them down. A row missing from
         * inside the fresh page's own range was deleted, and stays gone.
         */
        keepOlderThanFreshPage?: boolean;
        /** Rows kept whatever the fresh page says, e.g. the one a link asked for. */
        keepIds?: ReadonlySet<string>;
    } = {}
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
            // The tiles draw this one; a fresh signed address per refresh re-downloaded every tile.
            preview_url: preserveStableMediaUrl(previousGeneration.preview_url, incomingGeneration.preview_url),
            output_urls: mergedOutputUrls,
            output_count: incomingGeneration.output_count ?? previousGeneration.output_count,
            input_media: incomingGeneration.input_media ?? previousGeneration.input_media,
            paywallPrefill: incomingGeneration.paywallPrefill ?? previousGeneration.paywallPrefill,
        };
    });

    const refreshedIds = new Set(refreshedGenerations.map((generation) => generation.id));
    const freshCreatedAtMs = incomingGenerations
        .map((generation) => Date.parse(generation.created_at))
        .filter((createdAtMs) => Number.isFinite(createdAtMs));
    const oldestFreshMs = freshCreatedAtMs.length > 0 ? Math.min(...freshCreatedAtMs) : null;
    const keptGenerations = previousGenerations.filter((generation) => {
        if (refreshedIds.has(generation.id)) {
            return false;
        }
        if (options.keepIds?.has(generation.id)) {
            return true;
        }
        if (!options.keepOlderThanFreshPage) {
            return false;
        }
        const createdAtMs = Date.parse(generation.created_at);
        return oldestFreshMs === null || (Number.isFinite(createdAtMs) && createdAtMs < oldestFreshMs);
    });

    return [...refreshedGenerations, ...keptGenerations];
}

function mergeGenerationAppend(previousGenerations: Generation[], incomingGenerations: Generation[]): Generation[] {
    const previousIds = new Set(previousGenerations.map((generation) => generation.id));
    return [
        ...previousGenerations,
        ...incomingGenerations.filter((generation) => !previousIds.has(generation.id)),
    ];
}

/**
 * The posts list's next offset one place earlier, after a post before it was deleted here. The
 * owner list's offset is the place of its next post (`listOwnerPostsForRoute`) in a list of every
 * post, archived ones too, so an archive or a restore moves no post, and neither does a delete
 * that keeps a post for its buyers, archived.
 */
function stepPostsOffsetBack(offset: number | null): number | null {
    return offset === null ? null : Math.max(0, offset - 1);
}

function mergePostAppend(previousPosts: OwnerPost[], incomingPosts: OwnerPost[]): OwnerPost[] {
    const previousIds = new Set(previousPosts.map((post) => post.id));
    return [
        ...previousPosts,
        ...incomingPosts.filter((post) => !previousIds.has(post.id)),
    ];
}

const WORKSPACE_TABS: ReadonlyArray<{ key: WorkspaceView; label: string; lede: string }> = [
    { key: 'creations', label: 'Creations', lede: 'Preview private outputs, then turn the strongest ones into posts.' },
    { key: 'posts', label: 'Post Library', lede: 'Use Post Library for full post edits, archive state, and cleanup after publishing.' },
    { key: 'unlocks', label: 'Unlocked recipes', lede: 'Everything you have unlocked from other creators, yours to keep.' },
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
    const activeView = parseStudioWorkspaceView(searchParams.get('view'));
    const postVisibilityFilter = parseStudioPostFilter(searchParams.get('visibility'));
    // The creations' media filter is in the address too (owner's report, 2026-11-15: a
    // filter left by Back or a refresh came back as All).
    const filter = parseCreationMediaFilter(searchParams.get('media'));
    // Each section's filter rides along through the others, so a section left and opened again
    // is as it was left (review of #815: the media filter, kept in a state of the page before,
    // came back as All once it moved to the address).
    const buildWorkspacePath = (
        view: WorkspaceView,
        visibility: OwnerPostVisibilityFilter = 'all',
        media: FilterType = 'all',
    ) => {
        const params = new URLSearchParams();
        if (view !== 'creations') {
            params.set('view', view);
        }
        if (visibility !== 'all') {
            params.set('visibility', visibility);
        }
        if (media !== 'all') {
            params.set('media', media);
        }
        const query = params.toString();
        return query ? `${pathname}?${query}` : pathname;
    };
    const [generations, setGenerations] = useState<Generation[]>([]);
    const [posts, setPosts] = useState<OwnerPost[]>([]);
    const [profile, setProfile] = useState<ProfileApiResponse | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [generationsNextCursor, setGenerationsNextCursor] = useState<string | null>(null);
    // Whether the list has answered at all, from the server or from the snapshot of an earlier
    // visit: until then Studio knows no count, and says none.
    const [generationsAnswered, setGenerationsAnswered] = useState(false);
    // Whether the loaded creations are the whole library: the list's last page is loaded, as the
    // server said, or as the snapshot recorded. Kept in a ref too, for the snapshot's writers.
    const [generationsComplete, setGenerationsCompleteState] = useState(false);
    const generationsCompleteRef = useRef(false);
    const setGenerationsComplete = useCallback((complete: boolean) => {
        generationsCompleteRef.current = complete;
        setGenerationsCompleteState(complete);
    }, []);
    // The setup card's Steps, on a phone (it shows them all from 640px).
    const [setupStepsShown, setSetupStepsShown] = useState(false);
    const [isLoadingMoreGenerations, setIsLoadingMoreGenerations] = useState(false);
    // The list's cursor counts rows, so a delete steps it back a row (handleGenerationDelete), and
    // the two must not cross (review of #836): a delete waits for the Load more under way, whose
    // cursor would land after the step back and undo it, and Load more waits while deletes are
    // under way, as the page it asked for could be counted without the deleted row.
    const loadMoreInFlightRef = useRef<Promise<void> | null>(null);
    const [deletesInFlight, setDeletesInFlight] = useState(0);
    const deletesInFlightRef = useRef(0);
    const [generationsLoadMoreError, setGenerationsLoadMoreError] = useState<string | null>(null);
    const [postsNextOffset, setPostsNextOffset] = useState<number | null>(null);
    // The Post Library's list, as the creations' above: whether it has answered at all, and
    // whether the loaded posts are every post (its last page loaded). Kept in a ref too, for the
    // snapshot's writers.
    const [postsAnswered, setPostsAnswered] = useState(false);
    const [postsComplete, setPostsCompleteState] = useState(false);
    const postsCompleteRef = useRef(false);
    const setPostsComplete = useCallback((complete: boolean) => {
        postsCompleteRef.current = complete;
        setPostsCompleteState(complete);
    }, []);
    const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false);
    // The posts list's offset counts places, so a delete steps it back a place (removePost), and
    // the two must not cross, as Creations' cursor and its deletes (#836): a delete waits for the
    // Load more under way, whose offset would land after the step back and undo it, and Load more
    // waits while deletes are under way, as the page it asked for could be counted without the post.
    const postsLoadMoreInFlightRef = useRef<Promise<void> | null>(null);
    const [postDeletesInFlight, setPostDeletesInFlight] = useState(0);
    const postDeletesInFlightRef = useRef(0);
    // Moved on each time the posts list is replaced whole (a refresh rereads its first page, or a
    // snapshot is drawn): a page asked for before belongs to the list that is gone, and is dropped
    // when it lands rather than added after a gap (review of #860).
    const postsListGenerationRef = useRef(0);
    const [postsLoadMoreError, setPostsLoadMoreError] = useState<string | null>(null);
    const [generationDetailLoadingId, setGenerationDetailLoadingId] = useState<string | null>(null);
    const [generationDetailError, setGenerationDetailError] = useState<string | null>(null);
    const generationsRef = useRef<Generation[]>([]);
    // Pages of the creations list loaded since the last full first-page load.
    const loadedGenerationPagesRef = useRef(0);
    const generationStatusRefreshInFlightRef = useRef(false);
    const [previewGen, setPreviewGen] = useState<Generation | null>(null);
    const requestedGenerationRef = useRef<string | null>(null);
    // The preview is an entry of the browser's history, as a reel is (owner, 2026-11-15: Back
    // with it open left Studio). How its entry came (reel-history-entry.ts): pushed by a press
    // on a creation, so it closes by going Back to Studio's own entry; or named by the address
    // (an alert, a link), so it closes by taking the creation out of the address in place.
    const previewHistoryModeRef = useRef<ReelHistoryMode>(null);
    const mountedRef = useRef(false);
    // The last press on a creation's details: a load that ends after a later press, or after the
    // address moved on (Back, another view of Studio), opens nothing (review of #819).
    const previewRequestRef = useRef(0);
    // Creations deleted here: an entry that still names one (Forward onto it) opens nothing.
    const deletedGenerationIdsRef = useRef(new Set<string>());
    const [highlightedGenerationId, setHighlightedGenerationId] = useState<string | null>(null);
    const scrolledToGenerationRef = useRef<string | null>(null);
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
    // Read by the loaders at the moment they need it, so a change of view does
    // not give them a new identity and refetch the whole workspace.
    const creationsReturnPathRef = useRef(creationsReturnPath);
    useEffect(() => {
        creationsReturnPathRef.current = creationsReturnPath;
    }, [creationsReturnPath]);
    // Sign-in comes back to the view and the run the viewer was on.
    const redirectToSignIn = useCallback(() => {
        router.push(`/login?returnUrl=${encodeURIComponent(creationsReturnPathRef.current)}`);
    }, [router]);
    const buildStudioDetailPath = (postId: string, section?: string) =>
        buildShowcaseDetailPath(postId, {
            from: 'studio',
            returnTo: creationsReturnPath,
            section,
        });

    // The server's post totals this page holds, moved by a change made here, as Creations' total
    // is (moveHeldCreationsTotal): a post's change does not refresh the page, and with every page
    // loaded the counts would otherwise believe the old totals over the list (getStudioPostCounts).
    // A post moves from where it counted to where it counts now: live or archived, and under its
    // visibility, which the server counts too (`postsByVisibility`).
    const moveHeldPostTotals = useCallback((before: StudioPostPlace | null, after: StudioPostPlace | null) => {
        const moved = (current: ProfileApiResponse | null) => {
            if (!current?.stats) return current;
            const stats = moveStudioPostTotals(current.stats, before, after);
            return stats === current.stats ? current : { ...current, stats };
        };
        profileRef.current = moved(profileRef.current);
        setProfile(moved);
    }, []);

    // Lifecycle changes land in local state (and the session cache, so a
    // reload does not flash the old state) instead of refetching the whole
    // workspace. A generation card reads its linked post from `posts` first
    // and from its own linked_post_* columns only as a fallback, so both are
    // kept in step.
    const patchPost = useCallback((postId: string, patch: PostLifecyclePatch) => {
        // Archived or restored, or made public or private, or put back when that failed: from one
        // total to the other. A creation card changes the visibility of its post, which the loaded
        // pages may not hold: where it counted is then the card's copy (linked_post_*), read as the
        // card reads it (resolveCreationWorkspaceCardState) and patched below with the post, so the
        // answer and a rollback move from where the change left it (review of #865).
        const loaded = postsRef.current.find((post) => post.id === postId);
        const linkedFrom = loaded
            ? undefined
            : generationsRef.current.find((generation) => generation.linked_post_id === postId);
        const before: StudioPostPlace | null = loaded ?? (linkedFrom
            ? {
                visibility: linkedFrom.linked_post_visibility ?? 'public',
                archivedAt: linkedFrom.linked_post_archived_at ?? null,
            }
            : null);
        if (before) {
            moveHeldPostTotals(before, {
                visibility: patch.visibility ?? before.visibility,
                archivedAt: patch.archivedAt !== undefined ? patch.archivedAt : before.archivedAt,
            });
        }
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
                ...(patch.bundleStatus !== undefined && generation.linked_post_bundle
                    ? {
                        linked_post_bundle: {
                            ...generation.linked_post_bundle,
                            status: patch.bundleStatus ?? generation.linked_post_bundle.status,
                        },
                    }
                    : {}),
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
            generationsComplete: generationsCompleteRef.current,
            postsComplete: postsCompleteRef.current,
        });
    }, [moveHeldPostTotals, userId]);

    const removePost = useCallback((postId: string, removal?: PostLifecycleRemoval) => {
        // Deleted: out of its total. A post with buyers is kept on the server, archived, and comes
        // back under Archived with the next refresh, which counts it there again.
        const removed = postsRef.current.find((post) => post.id === postId);
        if (removed) {
            moveHeldPostTotals(removed, null);
            // The list's offset counts places, and this post sat before it: gone from the server,
            // every later post moved up a place, so the next page starts a place earlier, or Load
            // more would skip the one that moved into its first place. One kept for its buyers
            // keeps its place.
            if (!removal?.tombstoned) {
                setPostsNextOffset(stepPostsOffsetBack);
            }
        }
        const nextPosts = postsRef.current.filter((post) => post.id !== postId);
        const nextGenerations = generationsRef.current.map((generation) => (
            generation.linked_post_id === postId
                ? {
                    ...generation,
                    linked_post_id: null,
                    linked_post_title: null,
                    linked_post_visibility: null,
                    linked_post_archived_at: null,
                    linked_post_bundle: null,
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
            generationsComplete: generationsCompleteRef.current,
            postsComplete: postsCompleteRef.current,
        });
    }, [moveHeldPostTotals, userId]);

    // The server's library total this page holds, moved by a change made here to a finished
    // creation, so the loaded list and it still agree, and the refresh after only confirms them:
    // the counts believe the server over a list it disagrees with (getStudioCreationCounts), and
    // drew the old total, with no kind numbers, until the refresh landed, or for good when it failed.
    // Its kind's total moves with it, where the server counts kinds (`creationsByKind`).
    const moveHeldCreationsTotal = useCallback((delta: number, generation: Generation) => {
        const kind = getCreationMediaKindFilter(getMediaKind(generation));
        const moved = (current: ProfileApiResponse | null) => (current?.stats
            ? { ...current, stats: moveStudioCreationTotals(current.stats, kind, delta) }
            : current);
        profileRef.current = moved(profileRef.current);
        setProfile(moved);
    }, []);

    const dropGeneration = useCallback((generationId: string) => {
        const dropped = generationsRef.current.find((generation) => generation.id === generationId);
        if (dropped && !dropped.archived_at && isFinishedCreation(dropped)) {
            moveHeldCreationsTotal(-1, dropped);
        }
        const nextGenerations = generationsRef.current.filter((generation) => generation.id !== generationId);
        generationsRef.current = nextGenerations;
        setGenerations(nextGenerations);
        writeCreationsWorkspaceCache(userId, {
            generations: nextGenerations,
            posts: postsRef.current,
            profile: profileRef.current,
            generationsComplete: generationsCompleteRef.current,
            postsComplete: postsCompleteRef.current,
        });
    }, [moveHeldCreationsTotal, userId]);

    // Archived or restored on the server, so here too: the refresh that follows rereads only the
    // first page, and keeps a later page's rows as they were (mergeGenerationRefresh), so a row
    // from one would otherwise stay in its old section, and in the counts.
    const setGenerationArchivedAt = useCallback((generationId: string, archivedAt: string | null) => {
        const changed = generationsRef.current.find((generation) => generation.id === generationId);
        if (changed && isFinishedCreation(changed) && Boolean(changed.archived_at) !== Boolean(archivedAt)) {
            moveHeldCreationsTotal(archivedAt ? -1 : 1, changed);
        }
        const nextGenerations = generationsRef.current.map((generation) => (
            generation.id === generationId ? { ...generation, archived_at: archivedAt } : generation
        ));
        generationsRef.current = nextGenerations;
        setGenerations(nextGenerations);
        writeCreationsWorkspaceCache(userId, {
            generations: nextGenerations,
            posts: postsRef.current,
            profile: profileRef.current,
            generationsComplete: generationsCompleteRef.current,
            postsComplete: postsCompleteRef.current,
        });
    }, [moveHeldCreationsTotal, userId]);

    // A name and handle given on the way to making a post public: the
    // profile this page holds shows them from then on.
    const applySavedPublicIdentity = useCallback((saved: ProfileApiResponse) => {
        setProfile((current) => (current ? { ...current, ...saved } : saved));
    }, []);

    const postLifecycle = usePostLifecycle({
        accessToken,
        signedInUser: session?.user ?? null,
        onAuthRequired: redirectToSignIn,
        onPatch: patchPost,
        onRemoved: removePost,
        onPublicIdentitySaved: applySavedPublicIdentity,
    });

    // A delete from the Post Library. A Load more under way sets the offset when its page lands,
    // after the delete's step back (removePost), which it would undo, so the two take turns:
    // Delete is held while a Load more is under way (its menu item says so), and Load more while a
    // delete is, its question included, which is modal anyway. Review of #860: the delete waited
    // for the page before asking, so a press showed nothing, and presses made meanwhile opened
    // their questions when it landed, each closing the one before.
    const removeLibraryPost = async (post: OwnerPost) => {
        if (postsLoadMoreInFlightRef.current) return;
        postDeletesInFlightRef.current += 1;
        setPostDeletesInFlight((count) => count + 1);
        try {
            await postLifecycle.remove(post);
        } finally {
            postDeletesInFlightRef.current -= 1;
            setPostDeletesInFlight((count) => count - 1);
        }
    };

    // A generation card's linked post is the full owner record when it is
    // loaded, so policy can see its bundle; otherwise the generation's own
    // linkage columns and the list's bundle summary are enough to act on.
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
            // The summary has no unlock counts, so a confirmation leaves out its line about buyers.
            bundle: linkedPost.bundle
                ? { accessMode: linkedPost.bundle.accessMode, status: linkedPost.bundle.status, salesCount: 0 }
                : null,
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
        postsListGenerationRef.current += 1;
        setPosts(cachedWorkspace.posts);
        setProfile(cachedWorkspace.profile);
        setGenerationsComplete(cachedWorkspace.generationsComplete);
        setGenerationsAnswered(true);
        setPostsComplete(cachedWorkspace.postsComplete);
        setPostsAnswered(true);
        setIsLoading(false);
    }, [setGenerationsComplete, setPostsComplete, userId]);

    const fetchCreations = useCallback(async () => {
        if (!accessToken || !userId) {
            redirectToSignIn();
            return;
        }

        setLoadError(null);
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

            const generationsData = await readJsonResponse(generationsRes) as GenerationsApiResponse;
            let nextGenerations: Generation[] | null = null;
            if (generationsRes.ok) {
                const loadedGenerations = (generationsData.generations || []) as Generation[];
                const freshCursor = getNextGenerationCursor(generationsData);
                // With later pages loaded, they stay, and Load more goes on after
                // them; rewinding the cursor made it fetch pages already on
                // screen. One page loaded, or a first page that holds the whole
                // library, is simply replaced: keeping every row it no longer
                // has is how a deleted creation stayed in the grid.
                const keepsLaterPages = loadedGenerationPagesRef.current > 1 && freshCursor !== null;
                const requestedId = requestedGenerationRef.current;
                nextGenerations = mergeGenerationRefresh(generationsRef.current, loadedGenerations, {
                    keepOlderThanFreshPage: keepsLaterPages,
                    // The run a link opened stays on screen when it is older than the first page.
                    keepIds: requestedId ? new Set([requestedId]) : undefined,
                });
                generationsRef.current = nextGenerations;
                setGenerations(nextGenerations);
                if (!keepsLaterPages) {
                    loadedGenerationPagesRef.current = 1;
                    setGenerationsNextCursor(freshCursor);
                    setGenerationsComplete(freshCursor === null);
                }
                setGenerationsAnswered(true);
                setGenerationsLoadMoreError(null);
            } else {
                setLoadError('Could not load your creations. Check your connection and try again.');
            }

            const postsData = await readJsonResponse(postsRes) as OwnerPostsApiResponse;
            let nextPosts: OwnerPost[] | null = null;
            if (postsRes.ok) {
                const loadedPosts = ((postsData.posts || []) as OwnerPost[]).map(withoutRetiredRecipe);
                const freshPostsOffset = postsData.pageInfo?.hasMore
                    ? postsData.pageInfo.nextOffset ?? null
                    : null;
                nextPosts = loadedPosts;
                // In the ref at once, as the profile below: a post's change that lands before the
                // next render moves the totals from this list, not from the one it replaced.
                postsRef.current = loadedPosts;
                postsListGenerationRef.current += 1;
                setPosts(loadedPosts);
                setPostsNextOffset(freshPostsOffset);
                setPostsComplete(freshPostsOffset === null);
                setPostsAnswered(true);
                setPostsLoadMoreError(null);
            }

            let nextProfile: ProfileApiResponse | null = null;
            if (profileRes.ok) {
                nextProfile = await profileRes.json();
            }
            profileRef.current = nextProfile;
            setProfile(nextProfile);

            if (nextGenerations && nextPosts) {
                writeCreationsWorkspaceCache(userId, {
                    generations: nextGenerations,
                    posts: nextPosts,
                    profile: nextProfile,
                    generationsComplete: generationsCompleteRef.current,
                    postsComplete: postsCompleteRef.current,
                });
            }
        } catch (err) {
            console.error('Failed to fetch creations:', err);
            // A failed load used to end in the empty state, which reads as an empty account.
            setLoadError('Could not load your creations. Check your connection and try again.');
        } finally {
            setIsLoading(false);
        }
    }, [accessToken, redirectToSignIn, setGenerationsComplete, setPostsComplete, userId]);

    const loadMoreGenerations = useCallback(async () => {
        if (!accessToken || !userId) {
            redirectToSignIn();
            return;
        }

        // A delete under way moves the cursor this would ask from (handleGenerationDelete).
        if (!generationsNextCursor || isLoadingMoreGenerations || deletesInFlightRef.current > 0) {
            return;
        }

        setIsLoadingMoreGenerations(true);
        setGenerationsLoadMoreError(null);

        const load = (async () => {
            try {
                const response = await fetch(buildGenerationsPageUrl(generationsNextCursor), {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                });
                const data = await readJsonResponse(response) as GenerationsApiResponse;

                if (!response.ok) {
                    throw new Error('Failed to load more creations.');
                }

                const loadedGenerations = Array.isArray(data.generations) ? data.generations : [];
                const nextGenerations = mergeGenerationAppend(generationsRef.current, loadedGenerations);
                const nextCursor = getNextGenerationCursor(data);
                generationsRef.current = nextGenerations;
                loadedGenerationPagesRef.current += 1;
                setGenerations(nextGenerations);
                setGenerationsNextCursor(nextCursor);
                setGenerationsComplete(nextCursor === null);
                writeCreationsWorkspaceCache(userId, {
                    generations: nextGenerations,
                    posts: postsRef.current,
                    profile: profileRef.current,
                    generationsComplete: generationsCompleteRef.current,
                    postsComplete: postsCompleteRef.current,
                });
            } catch (error) {
                console.error('Failed to load more creations:', error);
                setGenerationsLoadMoreError(error instanceof Error ? error.message : 'Failed to load more creations.');
            } finally {
                setIsLoadingMoreGenerations(false);
            }
        })();
        loadMoreInFlightRef.current = load;
        try {
            await load;
        } finally {
            if (loadMoreInFlightRef.current === load) loadMoreInFlightRef.current = null;
        }
    }, [accessToken, generationsNextCursor, isLoadingMoreGenerations, redirectToSignIn, setGenerationsComplete, userId]);

    const refreshProcessingGenerationStatuses = useCallback(async () => {
        if (!accessToken || generationStatusRefreshInFlightRef.current) return;

        const activeIds = generationsRef.current
            .filter((generation) => (
                !generation.archived_at
                && isActiveGenerationStatus(generation.status)
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
            redirectToSignIn();
            return;
        }
        // A delete under way moves the offset this would ask from (removeLibraryPost).
        if (postsNextOffset === null || isLoadingMorePosts || postDeletesInFlightRef.current > 0) return;

        setIsLoadingMorePosts(true);
        setPostsLoadMoreError(null);
        const listGeneration = postsListGenerationRef.current;
        const load = (async () => {
            try {
                const response = await fetch(
                    `/api/posts?scope=owner&includeArchived=true&limit=${CREATIONS_POSTS_PAGE_SIZE}&offset=${postsNextOffset}`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                const data = await readJsonResponse(response) as OwnerPostsApiResponse;
                // The list was replaced meanwhile (a refresh reread its first page, and its offset
                // is the one Load more goes on from): this page followed the pages that are gone,
                // and added to the new list it would follow a gap. Its failure is that list's too.
                if (postsListGenerationRef.current !== listGeneration) return;
                if (!response.ok) throw new Error('Failed to load more posts.');

                // Onto the posts as they stand now, and with the totals as they stand now: a post
                // archived while the page was on its way stays archived, and its move stays counted.
                const nextPosts = mergePostAppend(
                    postsRef.current,
                    Array.isArray(data.posts) ? data.posts.map(withoutRetiredRecipe) : [],
                );
                const nextOffset = data.pageInfo?.hasMore ? data.pageInfo.nextOffset ?? null : null;
                postsRef.current = nextPosts;
                setPosts(nextPosts);
                setPostsNextOffset(nextOffset);
                setPostsComplete(nextOffset === null);
                writeCreationsWorkspaceCache(userId, {
                    generations: generationsRef.current,
                    posts: nextPosts,
                    profile: profileRef.current,
                    generationsComplete: generationsCompleteRef.current,
                    postsComplete: postsCompleteRef.current,
                });
            } catch (error) {
                console.error('Failed to load more posts:', error);
                if (postsListGenerationRef.current === listGeneration) {
                    setPostsLoadMoreError(error instanceof Error ? error.message : 'Failed to load more posts.');
                }
            } finally {
                setIsLoadingMorePosts(false);
            }
        })();
        postsLoadMoreInFlightRef.current = load;
        try {
            await load;
        } finally {
            if (postsLoadMoreInFlightRef.current === load) postsLoadMoreInFlightRef.current = null;
        }
    }, [accessToken, isLoadingMorePosts, postsNextOffset, redirectToSignIn, setPostsComplete, userId]);

    // The posts and the profile as they stand when it writes, beside the flags: the details of a
    // creation an alert opens are loaded by the render the page mounts with, before its posts and
    // its profile came, and wrote those, none, with the posts' flag up to date (review of #860).
    const cacheGenerations = useCallback((nextGenerations: Generation[]) => {
        generationsRef.current = nextGenerations;
        setGenerations(nextGenerations);
        writeCreationsWorkspaceCache(userId, {
            generations: nextGenerations,
            posts: postsRef.current,
            profile: profileRef.current,
            generationsComplete: generationsCompleteRef.current,
            postsComplete: postsCompleteRef.current,
        });
    }, [userId]);

    const loadGenerationById = useCallback(async (
        generationId: string,
        generation?: Generation
    ): Promise<Generation> => {
        if (generation && hasFullGenerationDetails(generation)) {
            return generation;
        }

        if (!accessToken || !userId) {
            redirectToSignIn();
            throw new Error('Authentication required.');
        }

        setGenerationDetailLoadingId(generationId);
        setGenerationDetailError(null);

        try {
            const response = await fetch(buildGenerationDetailUrl(generationId), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            const data = await readJsonResponse(response) as GenerationsApiResponse;

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
    }, [accessToken, cacheGenerations, redirectToSignIn, userId]);

    const loadGenerationDetail = useCallback(
        (generation: Generation) => loadGenerationById(generation.id, generation),
        [loadGenerationById]
    );

    useEffect(() => {
        if (!requestedGenerationId) {
            // No creation in the address (none asked for, or the preview closed): the next one
            // the address names opens. Kept until then, so a close is not undone while the
            // router's reading of the address is a render behind it.
            requestedGenerationRef.current = null;
            return;
        }

        if (!accessToken || !userId) {
            return;
        }

        if (requestedGenerationRef.current === requestedGenerationId
            || deletedGenerationIdsRef.current.has(requestedGenerationId)) {
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
                    setHighlightedGenerationId(generation.id);
                }
            })
            .catch(() => {
                if (requestedGenerationRef.current === requestedGenerationId) {
                    requestedGenerationRef.current = null;
                }
            });
    }, [accessToken, loadGenerationById, requestedGenerationId, userId]);

    // An alert opens one run: its card is brought into view once it is drawn
    // (a failed run's sits below the whole Completed grid) and ringed until a
    // few seconds after its details close.
    useEffect(() => {
        if (!highlightedGenerationId || scrolledToGenerationRef.current === highlightedGenerationId) {
            return;
        }
        const card = document.getElementById(getGenerationCardAnchorId(highlightedGenerationId));
        if (!card) {
            return;
        }
        scrolledToGenerationRef.current = highlightedGenerationId;
        card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, [generations, highlightedGenerationId, isLoading]);

    useEffect(() => {
        if (!highlightedGenerationId || previewGen?.id === highlightedGenerationId) {
            return;
        }
        const timeoutId = window.setTimeout(() => setHighlightedGenerationId(null), GENERATION_HIGHLIGHT_MS);
        return () => window.clearTimeout(timeoutId);
    }, [highlightedGenerationId, previewGen?.id]);

    // The post an edit has just saved, named by the editor on its way back
    // here: its card in Posts, or in Creations the card of the creation it was
    // made from, is brought into view and ringed for a few seconds once the
    // workspace is drawn, as an alert's run is. Read once, so Studio drawn
    // again later rings nothing.
    const [returnedPostId, setReturnedPostId] = useState<string | null>(readStudioReturnedPost);
    const scrolledToReturnedPostRef = useRef(false);
    const returnedGenerationId = returnedPostId
        ? generations.find((generation) => generation.linked_post_id === returnedPostId)?.id ?? null
        : null;
    const isGenerationRinged = (generationId: string) => (
        highlightedGenerationId === generationId || returnedGenerationId === generationId
    );

    useEffect(() => {
        forgetStudioReturnedPost();
    }, []);

    useEffect(() => {
        if (!returnedPostId || scrolledToReturnedPostRef.current) {
            return;
        }
        const anchorId = activeView === 'posts'
            ? getPostCardAnchorId(returnedPostId)
            : returnedGenerationId ? getGenerationCardAnchorId(returnedGenerationId) : null;
        const card = anchorId ? document.getElementById(anchorId) : null;
        if (!card) {
            return;
        }
        scrolledToReturnedPostRef.current = true;
        card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, [activeView, isLoading, posts, returnedGenerationId, returnedPostId]);

    useEffect(() => {
        if (!returnedPostId || isLoading) {
            return;
        }
        const timeoutId = window.setTimeout(() => setReturnedPostId(null), GENERATION_HIGHLIGHT_MS);
        return () => window.clearTimeout(timeoutId);
    }, [isLoading, returnedPostId]);

    useEffect(() => {
        void fetchCreations();
    }, [fetchCreations]);

    const hasProcessingGenerations = generations.some(
        (generation) => !generation.archived_at && isActiveGenerationStatus(generation.status)
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
        const request = previewRequestRef.current + 1;
        previewRequestRef.current = request;
        const pressedAt = window.location.href;
        try {
            const detailedGeneration = await loadGenerationDetail(generation);
            // Left meanwhile, pressed again, or Back pressed while the details loaded: nothing
            // opens, and nothing is pushed over the entry the reader went to.
            if (!mountedRef.current || previewRequestRef.current !== request || window.location.href !== pressedAt) {
                return;
            }
            setPreviewGen(detailedGeneration);
            // An entry of its own, as a reel opened from a tile has: Back closes the preview,
            // and Forward, a reload or Back from a page it links to opens it again.
            if (new URLSearchParams(window.location.search).get('generation') !== detailedGeneration.id) {
                requestedGenerationRef.current = detailedGeneration.id;
                previewHistoryModeRef.current = 'pushed';
                pushReelEntry('generation', studioPreviewAddress(detailedGeneration.id));
            }
        } catch {
            // Error state is stored in generationDetailError for the page-level notice.
        }
    };

    // Close, Escape, a press outside it, Restore, a delete: Back to Studio's own entry when the
    // press that opened the preview pushed one, else the creation leaves the address in place.
    const closePreview = useCallback(() => {
        setPreviewGen(null);
        const mode = previewHistoryModeRef.current;
        previewHistoryModeRef.current = null;
        if (!new URLSearchParams(window.location.search).get('generation')) return;
        if (mode === 'pushed') {
            window.history.back();
            return;
        }
        replaceReelEntry(studioPreviewAddress(null));
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        // The entry Studio mounts on says how its preview was opened: one a press pushed (a
        // reload, or Back from a page the preview linked to, came back to it) closes by going
        // Back to the entry under it.
        previewHistoryModeRef.current = readCurrentReelHistoryMode('generation');
        const handlePopState = (event: PopStateEvent) => {
            const params = new URLSearchParams(window.location.search);
            previewHistoryModeRef.current = readReelHistoryMode('generation', params, event.state);
            const generationId = params.get('generation');
            if (!generationId) {
                setPreviewGen(null);
                return;
            }
            // Forward onto the entry of a creation deleted here: it leaves the address.
            if (deletedGenerationIdsRef.current.has(generationId)) {
                setPreviewGen(null);
                replaceReelEntry(studioPreviewAddress(null));
                return;
            }
            // Forward onto a preview's entry: a creation the page holds opens at once; any other
            // is read by the address's own effect, as a link's is.
            const held = generationsRef.current.find((item) => item.id === generationId);
            if (held && hasFullGenerationDetails(held)) {
                requestedGenerationRef.current = generationId;
                setPreviewGen(held);
            }
        };
        window.addEventListener('popstate', handlePopState);
        return () => {
            mountedRef.current = false;
            window.removeEventListener('popstate', handlePopState);
        };
    }, []);

    // Publish opens the full composer for a creation with no post yet, as the
    // app's does. Edits and recipe changes on an existing post link to the
    // editor instead, which loads the stored bundle rather than rebuilding one
    // from the prefill. Every one carries the view it was opened from: the
    // composer's Back returns there, and so does an edit once saved.
    const withStudioReturn = (href: string): string =>
        withSearchParam(href, 'returnTo', buildWorkspacePath(activeView, postVisibilityFilter, filter));

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

        if (!session?.access_token) {
            redirectToSignIn();
            return;
        }

        setRestoringGenerationId(generation.id);
        try {
            const uploadedMedia = await uploadMediaToTemporaryStorage(file);
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
            const data = await readJsonResponse(response);
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to restore preview.');
            }

            await fetchCreations();
            setRestoreTarget(null);
        } catch (error) {
            console.error('Failed to restore creation preview:', error);
            pushToast({ tone: 'error', message: error instanceof Error ? error.message : 'Could not restore the preview.' });
        } finally {
            setRestoringGenerationId(null);
        }
    };

    const copyPostLink = async (path: string) => {
        try {
            // As it leaves the product: its surface for the share-visit count, and the sharer's
            // invite (review of 2026-11-10: a copied link carried neither).
            const target = new URL(path, window.location.origin);
            if (!target.searchParams.has(SHARE_SOURCE_QUERY_PARAM)) target.searchParams.set(SHARE_SOURCE_QUERY_PARAM, 'my-creations');
            await navigator.clipboard.writeText(withSharersInvite(target.toString()));
            pushToast({ tone: 'success', message: 'Post link copied.' });
        } catch (error) {
            console.error('Failed to copy post link:', error);
            pushToast({ tone: 'error', message: 'Could not copy the post link.' });
        }
    };

    const handleGenerationArchive = async (generationId: string) => {
        if (!session?.access_token) {
            redirectToSignIn();
            return;
        }

        const confirmed = await requestConfirmation({
            title: 'Archive this creation?',
            message: 'It leaves the active workspace until you restore it.',
            confirmLabel: 'Archive',
        });
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
            const data = await readJsonResponse(response);
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to archive creation.');
            }

            setGenerationArchivedAt(generationId, new Date().toISOString());
            await fetchCreations();
        } catch (error) {
            console.error('Failed to archive creation:', error);
            pushToast({ tone: 'error', message: error instanceof Error ? error.message : 'Could not archive the creation.' });
        }
    };

    const handleGenerationRestore = async (generationId: string) => {
        if (!session?.access_token) {
            redirectToSignIn();
            return;
        }

        try {
            const response = await fetch(`/api/generations/${generationId}/restore`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            });
            const data = await readJsonResponse(response);
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to restore creation.');
            }

            setGenerationArchivedAt(generationId, null);
            await fetchCreations();
        } catch (error) {
            console.error('Failed to restore creation:', error);
            pushToast({ tone: 'error', message: error instanceof Error ? error.message : 'Could not restore the creation.' });
        }
    };

    const handleGenerationDelete = async (generationId: string) => {
        if (!session?.access_token) {
            redirectToSignIn();
            return;
        }

        const confirmed = await requestConfirmation({
            title: 'Delete this creation?',
            message: 'Any linked post stays intact, but remixes based on this creation may stop working.',
            confirmLabel: 'Delete',
            tone: 'danger',
        });
        if (!confirmed) {
            return;
        }

        // A Load more under way lands first: the cursor it sets is the one this delete steps back.
        await loadMoreInFlightRef.current;
        deletesInFlightRef.current += 1;
        setDeletesInFlight((count) => count + 1);
        try {
            try {
                const response = await fetch(`/api/generations/${generationId}`, {
                    method: 'DELETE',
                    headers: {
                        Authorization: `Bearer ${session.access_token}`,
                    },
                });
                const data = await readJsonResponse(response);
                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Failed to delete creation.');
                }
            } catch (error) {
                console.error('Failed to delete creation:', error);
                pushToast({ tone: 'error', message: error instanceof Error ? error.message : 'Could not delete the creation.' });
                return;
            }

            // Gone on the server, so gone here: from the grid, from the snapshot a
            // reload draws first, and from an open preview, whatever the refresh
            // below brings back.
            dropGeneration(generationId);
            // The list's cursor counts rows, and this one sat before it: with it gone, the next page
            // starts a row earlier, or Load more would skip the row that moved up into its place.
            setGenerationsNextCursor(stepGenerationsCursorBack);
        } finally {
            deletesInFlightRef.current -= 1;
            setDeletesInFlight((count) => count - 1);
        }
        deletedGenerationIdsRef.current.add(generationId);
        setPreviewGen((current) => (current?.id === generationId ? null : current));
        // Only while Studio is the page: one the reader went on to may name it too.
        if (mountedRef.current && new URLSearchParams(window.location.search).get('generation') === generationId) {
            closePreview();
        }
        await fetchCreations();
    };

    const handleReportAiOutput = async (generationId: string) => {
        if (!session?.access_token) {
            redirectToSignIn();
            return;
        }

        const confirmed = await requestConfirmation({
            title: 'Report offensive AI output?',
            message: 'Send this generated result to the safety team so the model and provider output can be reviewed.',
            confirmLabel: 'Report AI output',
            tone: 'danger',
        });
        if (!confirmed) {
            return;
        }

        try {
            await reportGeneration({ generationId, accessToken: session.access_token });
            pushToast({ tone: 'success', message: 'The generated output was sent to the safety team.' });
        } catch (error) {
            console.error('Failed to report AI output:', error);
            pushToast({
                tone: 'error',
                message: error instanceof Error && error.message
                    ? `Could not report AI output. ${error.message}`
                    : 'Could not report AI output.',
            });
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
                const endedRunStatus = getEndedTemplateRunStatus(generation);
                return endedRunStatus
                    ? `A finished step of a template run that was ${endedRunStatus}. Open the run to see every step.`
                    : `Final ${mediaKind} created from a reusable template. Open the run to review its progress or publish the result.`;
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

    const appendCreationsSource = (path: string): string => withSearchParam(path, 'from', 'creations');

    // A private or archived post opens in its editor, which goes back to this
    // view once saved, as every other editor link here does; a public one opens
    // its own page.
    const getLinkedPostOpenHref = (workspaceState: CreationWorkspaceCardState): string | null => {
        const href = workspaceState.secondaryAction.href ?? null;
        return href && href === workspaceState.linkedPost?.ownerPath
            ? withStudioReturn(appendCreationsSource(href))
            : href;
    };

    const buildCreationCustomizePath = (
        generation: Generation,
        workspaceState: CreationWorkspaceCardState
    ): string => {
        if (workspaceState.linkedPost?.ownerPath) {
            return withStudioReturn(appendCreationsSource(workspaceState.linkedPost.ownerPath));
        }

        return withStudioReturn(buildCreationComposerPath(generation.id));
    };

    const getPreviewMetadata = (generation: Generation): Array<{ label: string; value: string }> => {
        const mediaKind = getMediaKind(generation);
        const mediaLabel = mediaKind === 'audio' ? 'Audio' : mediaKind === 'image' ? 'Image' : 'Video';
        const createdLabel = new Date(generation.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });
        // A failed run's end is not a render time.
        const completedLabel = generation.status === 'succeeded' ? getCompletedInLabel(generation) : null;
        const endedRunStatus = getEndedTemplateRunStatus(generation);

        return [
            { label: 'Type', value: mediaLabel },
            generation.origin === 'template'
                ? { label: 'Origin', value: endedRunStatus ? `Template · run ${endedRunStatus}` : 'Template' }
                : null,
            { label: 'Model', value: generation.model },
            { label: 'Created', value: createdLabel },
            // A refunded run's credits are told by its status note instead: it cost nothing.
            generation.cost !== null && !getReturnedCreditsLabel(generation)
                ? { label: 'Credits', value: `${generation.cost} credits` }
                : null,
            completedLabel ? { label: 'Render time', value: completedLabel.replace('Completed in ', '') } : null,
        ].filter((item): item is { label: string; value: string } => Boolean(item));
    };

    // In place of the media for a run that has none: an alert opens failed and
    // rendering runs here, and the modal used to show nothing for them.
    const getPreviewStatusNote = (generation: Generation): MediaDetailsStatusNote | null => {
        if (generation.output_url) {
            return null;
        }
        if (generation.status === 'failed') {
            return {
                label: 'Failed',
                tone: 'danger',
                message: generation.error_message?.trim() || 'The model did not return a result.',
                detail: getReturnedCreditsLabel(generation),
            };
        }
        if (isActiveGenerationStatus(generation.status)) {
            const startedAgo = getStartedAgoLabel(generation);
            return {
                label: 'Still rendering',
                tone: 'pending',
                message: `${startedAgo ? `${startedAgo}. ` : ''}It moves into Completed when the model returns it.`,
            };
        }
        if (generation.source_unavailable_at) {
            return {
                label: 'File no longer available',
                message: 'Its only copy expired at the provider before it could be saved.',
            };
        }
        return {
            label: 'No media to show',
            message: 'Its file could not be loaded. Refresh Studio to try again.',
        };
    };

    const renderPreviewActions = (generation: Generation) => {
        const primaryClass = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 sm:w-auto sm:min-w-36';
        const secondaryClass = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white sm:w-auto';
        const quietIconClass = 'inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white';
        const dangerIconClass = 'inline-flex h-11 w-11 items-center justify-center rounded-full border border-rose-400/20 bg-rose-500/10 text-rose-100 transition hover:border-rose-300/35 hover:bg-rose-500/15';
        const isTemplateResult = generation.origin === 'template';
        const deleteButton = !isTemplateResult ? (
            <button
                type="button"
                onClick={() => void handleGenerationDelete(generation.id)}
                className={dangerIconClass}
                title="Delete creation"
                aria-label="Delete creation"
            >
                <Trash2 className="h-4 w-4" />
            </button>
        ) : null;

        // A run that did not finish has nothing to publish or download: the
        // modal offers what its card does.
        if (generation.status === 'failed') {
            return (
                <>
                    {canRecreate(generation) ? (
                        <Link href={recreateHref(generation)} className={primaryClass}>
                            <RotateCcw className="h-4 w-4" />
                            Try again
                        </Link>
                    ) : null}
                    {deleteButton}
                </>
            );
        }
        if (isActiveGenerationStatus(generation.status)) {
            return null;
        }
        if (generation.archived_at) {
            return (
                <>
                    {!generation.moderation_removed_at ? (
                        <button
                            type="button"
                            onClick={() => {
                                // Without a session the restore goes to sign-in, back to these details.
                                if (session?.access_token) closePreview();
                                void handleGenerationRestore(generation.id);
                            }}
                            className={secondaryClass}
                        >
                            <RotateCcw className="h-4 w-4" />
                            Restore
                        </button>
                    ) : null}
                    {deleteButton}
                </>
            );
        }

        const workspaceState = resolveCreationWorkspaceCardState(generation, posts);
        const mediaKind = getMediaKind(generation);
        const canManageFromCreation = mediaKind !== 'audio' && isShareSupported(generation);
        // Publishing needs the file, and only a succeeded run's result may publish.
        const primaryIsPublish = workspaceState.primaryAction.type === 'publish'
            && !generation.source_unavailable_at
            && !getEndedTemplateRunStatus(generation);
        const primaryIsUnlock =
            workspaceState.primaryAction.type === 'add-paywall' ||
            workspaceState.primaryAction.type === 'manage-paywall';
        const publishHref = canManageFromCreation && primaryIsPublish && workspaceState.primaryAction.href
            ? withStudioReturn(workspaceState.primaryAction.href)
            : null;
        // Publish already opens the composer for a creation with no post yet.
        const customizeHref = canManageFromCreation && !isTemplateResult && !publishHref
            ? buildCreationCustomizePath(generation, workspaceState)
            : null;
        const downloadHref = generation.output_url
            ? getCreationDownloadUrl(
                generation.output_url,
                `creation_${generation.id}.${inferDownloadExtension(generation)}`,
            )
            : null;

        return (
            <>
                {/* Leaving for the composer keeps the preview's entry: Back from there opens it again. */}
                {publishHref ? (
                    <Link
                        href={publishHref}
                        onClick={() => setPreviewGen(null)}
                        className={primaryClass}
                    >
                        <Globe className="h-4 w-4" />
                        Publish
                    </Link>
                ) : null}

                {canManageFromCreation && primaryIsUnlock && workspaceState.primaryAction.href ? (
                    <Link
                        href={withStudioReturn(workspaceState.primaryAction.href)}
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
                    <Link href={getLinkedPostOpenHref(workspaceState) ?? workspaceState.secondaryAction.href} className={secondaryClass}>
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
                    <button
                        type="button"
                        onClick={() => void handleGenerationArchive(generation.id)}
                        className={quietIconClass}
                        title="Archive creation"
                        aria-label="Archive creation"
                    >
                        <Archive className="h-4 w-4" />
                    </button>
                ) : null}
                {deleteButton}
            </>
        );
    };

    const archivedGenerations = generations.filter((generation) => Boolean(generation.archived_at));
    const activeGenerations = generations.filter((generation) => !generation.archived_at);
    // A creation whose only source is gone keeps its place in the grid with an
    // explicit note: the API withholds its address, so `output_url` alone
    // would silently hide it, which reads as deletion.
    const successfulGenerations = activeGenerations.filter(isFinishedCreation);
    const processingGenerations = activeGenerations.filter(g => isActiveGenerationStatus(g.status));
    const failedGenerations = activeGenerations.filter(g => g.status === 'failed');

    const filteredSuccessful = successfulGenerations.filter(g => {
        const mediaKind = getMediaKind(g);
        if (filter === 'images') return mediaKind === 'image';
        if (filter === 'videos') return mediaKind === 'video';
        if (filter === 'audio') return mediaKind === 'audio';
        return true;
    });

    const loadedCreationCounts = {
        all: successfulGenerations.length,
        images: successfulGenerations.filter(g => getMediaKind(g) === 'image').length,
        videos: successfulGenerations.filter(g => getMediaKind(g) === 'video').length,
        audio: successfulGenerations.filter(g => getMediaKind(g) === 'audio').length,
    };
    // The header's total and the filters' numbers, by one rule so they agree (creation-workspace.ts).
    const creationCounts = getStudioCreationCounts({
        loaded: loadedCreationCounts,
        listAnswered: generationsAnswered,
        listComplete: generationsComplete,
        serverTotal: profile?.stats?.creations ?? null,
        serverKindTotals: profile?.stats?.creationsByKind ?? null,
    });
    // "—" until something has answered, as the profile draws a count it does not know: never 0.
    // A screen reader hears "Counting" in its place.
    const formatStudioTotal = ({ total, totalIsAtLeast }: StudioTotal) => (total === null
        ? <><span aria-hidden="true">—</span><span className="sr-only">Counting</span></>
        : `${total}${totalIsAtLeast ? '+' : ''}`);
    const creationTotalLabel = formatStudioTotal(creationCounts);
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
    const livePosts = posts.filter((post) => !post.archivedAt);
    const loadedPostCounts: Record<OwnerPostVisibilityFilter, number> = {
        all: livePosts.length,
        public: livePosts.filter((post) => post.visibility === 'public').length,
        unlisted: livePosts.filter((post) => post.visibility === 'unlisted').length,
        private: livePosts.filter((post) => post.visibility === 'private').length,
        archived: posts.length - livePosts.length,
    };
    // The Post Library's header and visibility filters, by Creations' rule so they agree
    // (creation-workspace.ts): it loads its posts 36 at a time too.
    const postCounts = getStudioPostCounts({
        loaded: loadedPostCounts,
        listAnswered: postsAnswered,
        listComplete: postsComplete,
        serverTotals: profile?.stats ?? null,
    });
    const activePortfolioPostCount = loadedPostCounts.public;
    const isProfileIncomplete = !profileReadiness.profileComplete;
    // An account with no creator name sets it up at the name step, which comes
    // back here; /profile has no setup mode of its own any more.
    const profileSetupHref = profileReadiness.publicPublishReady
        ? '/profile?next=%2Fcreations'
        : buildCreatorNameStepPath('/creations');
    const hasPortfolioProof = successfulGenerations.length > 0 && activePortfolioPostCount > 0;
    const shouldShowPortfolioStarter = activeView === 'creations' && !isLoading && (
        successfulGenerations.length === 0 ||
        activePortfolioPostCount === 0 ||
        isProfileIncomplete
    );
    // The setup card's line under its title and its way to the portfolio, drawn in one of two
    // places by the width (the card's comment below).
    const portfolioSetupDetail = hasPortfolioProof
        ? 'Your creation and public proof are in place. Add the remaining identity details so visitors and buyers know who is behind the work.'
        : 'New creators have three jobs here: shape the profile, create proof, then publish the strongest result with an optional recipe.';
    const renderPortfolioLink = (className: string) => (
        <IntentLink
            href={publicProfileUsername ? `/creators/${publicProfileUsername}` : '/profile'}
            className={`inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08] ${className}`}
        >
            <ExternalLink className="h-4 w-4" />
            {publicProfileUsername ? 'View portfolio' : 'Preview profile setup'}
        </IntentLink>
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
            ? `${formatPostResourceCompactPriceLabel(workspaceState.monetizationPriceUsdCents)} recipe`
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
            {/* Below 640px (sm) everything above the grid is drawn tighter, so the first creations
                show in a phone's first screen: the header, the section tabs and the setup card used to
                fill it (live sweep, 2026-11-17, 375 × 812). From 640px it is as it was. */}
            <div className="studio-shell relative z-10 py-6 sm:py-8">
                {/* Header. Generate and Post are the top bar's Create menu, and
                    Profile is in the navigation. */}
                <div className="mb-5 sm:mb-8">
                    <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
                        Studio
                    </h1>
                    <p className="text-sm text-zinc-500 font-medium tracking-wide">
                        {activeView === 'creations'
                            ? <>{creationTotalLabel} CREATION{creationCounts.total !== 1 ? 'S' : ''} TOTAL</>
                            : activeView === 'posts'
                                ? (
                                    <>
                                        {formatStudioTotal(postCounts.live)} POST{postCounts.live.total === 1 && !postCounts.live.totalIsAtLeast ? '' : 'S'}
                                        {postCounts.archived.total ? <> · {formatStudioTotal(postCounts.archived)} ARCHIVED</> : null}
                                    </>
                                )
                                : 'UNLOCKED RECIPES'}
                    </p>
                </div>

                <div className="mb-5 sm:mb-6 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
                    {/* Links, not buttons: each section has its own URL, so the
                        browser's history and a shared link both know which one.
                        On a phone they keep to one row, which scrolls to the screen's
                        edges where it is too narrow, with room kept for the focus ring
                        (as `.home-shelf-track`); they wrapped onto two lines. */}
                    <nav
                        aria-label="Studio sections"
                        className="hide-scrollbar -mx-4 -my-1 flex items-center gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:my-0 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:px-0 sm:py-0"
                    >
                        {WORKSPACE_TABS.map((tab) => (
                            <Link
                                key={tab.key}
                                href={buildWorkspacePath(tab.key, postVisibilityFilter, filter)}
                                scroll={false}
                                aria-current={activeView === tab.key ? 'page' : undefined}
                                className={`ui-focus-ring shrink-0 whitespace-nowrap rounded-full border px-4 py-2.5 text-sm font-semibold transition ${
                                    activeView === tab.key
                                        ? 'border-white/20 bg-white/10 text-white'
                                        : 'border-white/8 bg-zinc-900/50 text-zinc-400 hover:border-white/14 hover:bg-zinc-800 hover:text-zinc-200'
                                }`}
                            >
                                {tab.label}
                            </Link>
                        ))}
                    </nav>
                    {/* What the open section holds: the tabs say enough on a phone. */}
                    <div className="hidden text-sm text-zinc-500 sm:block">
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
                    // On a phone the card is its title and its first step, with the rest behind
                    // Steps, which opens it below itself: the line under the title and the
                    // portfolio come after the button there, so the button stays under the finger
                    // and a screen reader meets them next. From 640px the card shows everything
                    // where it always stood, with no disclosure.
                    <section
                        aria-labelledby={PORTFOLIO_SETUP_LABEL_ID}
                        className="mb-5 rounded-3xl border border-[rgba(255,122,89,0.2)] bg-[var(--ui-surface-1)] p-4 shadow-[var(--ui-shadow-panel)] sm:mb-8 sm:p-6"
                    >
                        <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <div id={PORTFOLIO_SETUP_LABEL_ID} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
                                    <UserRound className="h-3.5 w-3.5 text-[var(--ui-primary)]" />
                                    Portfolio setup
                                </div>
                                <h2 className="mt-3 max-w-2xl text-lg font-semibold tracking-tight text-white sm:mt-4 sm:text-2xl">
                                    {hasPortfolioProof
                                        ? 'Finish the profile behind your published work.'
                                        : 'Turn the first output into a profile-ready portfolio piece.'}
                                </h2>
                                <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300 max-sm:hidden">
                                    {portfolioSetupDetail}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-2 sm:flex-nowrap lg:justify-end">
                                <Link
                                    href={profileSetupHref}
                                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 sm:flex-initial"
                                >
                                    <UserRound className="h-4 w-4" />
                                    {profileReadiness.publicPublishReady ? 'Complete profile' : 'Set up profile'}
                                </Link>
                                {/* A wrapper hides it from 640px: `.ui-button`'s display is unlayered, and outranks `sm:hidden`. */}
                                <div className="sm:hidden">
                                    <Button
                                        variant="secondary"
                                        icon={setupStepsShown ? ChevronUp : ChevronDown}
                                        ariaExpanded={setupStepsShown}
                                        ariaControls={`${PORTFOLIO_SETUP_MORE_ID} ${PORTFOLIO_SETUP_STEPS_ID}`}
                                        onClick={() => setSetupStepsShown((shown) => !shown)}
                                    >
                                        Steps
                                    </Button>
                                </div>
                                {renderPortfolioLink('max-sm:hidden')}
                            </div>
                        </div>
                        <div id={PORTFOLIO_SETUP_MORE_ID} className={`mt-4 sm:hidden ${setupStepsShown ? '' : 'hidden'}`}>
                            <p className="text-sm leading-6 text-zinc-300">{portfolioSetupDetail}</p>
                            {renderPortfolioLink('mt-3 w-full')}
                        </div>
                        <div
                            id={PORTFOLIO_SETUP_STEPS_ID}
                            className={`mt-5 grid gap-3 md:grid-cols-3 ${setupStepsShown ? '' : 'max-sm:hidden'}`}
                        >
                            {[
                                {
                                    title: profileReadiness.profileComplete
                                        ? 'Creator profile ready'
                                        : profileReadiness.publicPublishReady
                                            ? 'Strengthen creator profile'
                                            : 'Finish creator identity',
                                    // Handle and name are all that publishing and selling ask
                                    // for; a photo and a bio only complete the profile.
                                    body: profileReadiness.profileComplete
                                        ? 'Your handle, name, avatar, and bio are ready for visitors and buyers.'
                                        : profileReadiness.publicPublishReady
                                            ? `Your public identity is ready to publish and sell. ${profileReadiness.missingForCompleteProfile.includes('avatar')
                                                ? profileReadiness.missingForCompleteProfile.includes('bio')
                                                    ? 'Add an avatar and a short bio so people recognize your work.'
                                                    : 'Add an avatar so people recognize your work.'
                                                : 'Add a short bio so visitors understand your work.'}`
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
                                    className="rounded-2xl border border-white/8 bg-black/25 p-4"
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
                    <div className="mb-5 flex gap-2 overflow-x-auto pb-1 sm:mb-8">
                        {getCreationMediaFilters(loadedCreationCounts, filter, creationCounts.filterTotals).map(tab => (
                            // As the post filters below: a refinement of the section, so it
                            // replaces the history entry, and Back and a refresh keep it.
                            <Link
                                key={tab.key}
                                href={buildWorkspacePath('creations', postVisibilityFilter, tab.key)}
                                replace
                                scroll={false}
                                aria-current={filter === tab.key ? 'true' : undefined}
                                className={`ui-focus-ring shrink-0 whitespace-nowrap px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200 ${filter === tab.key
                                    ? 'bg-white/10 text-white border border-white/20'
                                    : 'bg-zinc-900/50 text-zinc-500 border border-white/5 hover:text-zinc-300 hover:bg-zinc-800'
                                    }`}
                            >
                                {tab.label}
                            </Link>
                        ))}
                    </div>
                )}

                {activeView === 'posts' && !isLoading && posts.length > 0 && (
                    <div role="group" aria-label="Filter posts by visibility" className="mb-8 flex flex-wrap gap-2">
                        {/* A number only where it is a total, as the header's (getStudioPostCounts);
                            Unlisted only while a post saved as one is left (getStudioPostFilters). */}
                        {getStudioPostFilters(loadedPostCounts, postVisibilityFilter, postCounts.filterTotals)
                            .map((tab) => (
                            // A filter is a refinement of the current section, so it
                            // replaces the history entry instead of adding one.
                            <Link
                                key={tab.key}
                                href={buildWorkspacePath('posts', tab.key, filter)}
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

                {activeView === 'creations' && !isLoading && loadError ? (
                    <div role="alert" className="mb-10 flex flex-col items-center gap-4 rounded-3xl border border-rose-500/20 bg-rose-500/5 px-6 py-10 text-center">
                        <p className="text-base font-semibold text-rose-100">{loadError}</p>
                        <button
                            type="button"
                            onClick={() => {
                                setIsLoading(true);
                                void fetchCreations();
                            }}
                            className={studioActionClass('secondary', { size: 'md' })}
                        >
                            <RotateCcw className="h-4 w-4" />
                            Retry
                        </button>
                    </div>
                ) : null}

                {/* Empty State */}
                {activeView === 'creations' && !isLoading && !loadError && activeGenerations.length === 0 && archivedGenerations.length === 0 && (
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
                                    <div key={item.title} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-left">
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
                            <Link href={profileSetupHref} className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]">
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
                        {/* On a phone one row, the heading and Refresh now, so the runs come into
                            the first screen; each card says when it started. */}
                        <div className="mb-4 flex items-center justify-between gap-2 sm:items-end">
                            <div>
                                <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-yellow-400/80">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Processing ({processingGenerations.length})
                                </h2>
                                <p className="mt-2 hidden max-w-2xl text-sm text-zinc-500 sm:block">
                                    Longer provider queues keep running in the background. Each card shows when the run started, and finished outputs move into Completed automatically.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => void fetchCreations()}
                                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-200 transition hover:bg-white/[0.08] hover:text-white sm:self-start"
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
                                    anchorId={getGenerationCardAnchorId(gen.id)}
                                    highlighted={isGenerationRinged(gen.id)}
                                    media={(
                                        <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                            <div className="flex flex-col items-center gap-3">
                                                <Loader2 className="h-8 w-8 animate-spin text-yellow-400" />
                                                <span className="text-xs text-zinc-400">
                                                    {/* Not sent to the model yet: held in the queue until its turn. */}
                                                    {gen.status === 'pending'
                                                        ? 'Starts when its turn comes'
                                                        : getStartedAgoLabel(gen) ?? 'Still processing in background...'}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                    chips={<StudioChip tone="amber">{gen.status === 'pending' ? 'Queued' : 'Processing'}</StudioChip>}
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
                                const primaryIsPublish = workspaceState.primaryAction.type === 'publish';
                                const endedRunStatus = getEndedTemplateRunStatus(gen);
                                const hasPrimaryAction =
                                    canManageFromCreation &&
                                    // Publishing needs the file; a lost source keeps its post's recipe actions.
                                    !(primaryIsPublish && gen.source_unavailable_at) &&
                                    // The server publishes only a succeeded run's result.
                                    !(primaryIsPublish && endedRunStatus) &&
                                    workspaceState.primaryAction.type !== 'none' &&
                                    Boolean(workspaceState.primaryAction.label);
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
                                    ? getLinkedPostOpenHref(workspaceState)
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
                                    const downloadName = `creation_${gen.id}.${inferDownloadExtension(gen)}`;
                                    overflowItems.push({
                                        key: 'download',
                                        label: 'Download creation',
                                        icon: <Download className="h-4 w-4" />,
                                        href: getCreationDownloadUrl(primaryMediaUrl, downloadName),
                                        download: downloadName,
                                    });
                                }
                                if (!isTemplateResult && !isAudio) {
                                    overflowItems.push({
                                        key: 'recreate',
                                        label: 'Recreate',
                                        icon: <RotateCcw className="h-4 w-4" />,
                                        href: recreateHref(gen),
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
                                        // What a model made is its maker's to report, as in the app's reel.
                                        {
                                            key: 'report-ai-output',
                                            label: 'Report AI output',
                                            icon: <Flag className="h-4 w-4" />,
                                            tone: 'danger',
                                            onSelect: () => void handleReportAiOutput(gen.id),
                                        },
                                    );
                                }
                                const tileSrc = primaryMediaUrl
                                    ? isImage
                                        ? gen.preview_url ?? primaryMediaUrl
                                        : resolvePlaybackUrl({ url: primaryMediaUrl, renditionUrl: gen.media?.renditionUrl })
                                    : null;
                                return (
                                    <StudioCard
                                        key={gen.id}
                                        density="compact"
                                        testId={`creation-card-${gen.id}`}
                                        anchorId={getGenerationCardAnchorId(gen.id)}
                                        highlighted={isGenerationRinged(gen.id)}
                                        media={gen.source_unavailable_at ? (
                                            <UnavailableMediaNote testId={`creation-unavailable-${gen.id}`} />
                                        ) : primaryMediaUrl && tileSrc ? (
                                            <CreationMediaFrame
                                                key={primaryMediaUrl}
                                                id={gen.id}
                                                mediaKind={mediaKind}
                                                src={tileSrc}
                                                retrySrc={getFreshTileUrl(tileSrc, primaryMediaUrl)}
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
                                                {isTemplateResult ? (
                                                    <StudioChip tone={endedRunStatus ? 'amber' : 'emerald'}>
                                                        {endedRunStatus ? `From template · run ${endedRunStatus}` : 'From template'}
                                                    </StudioChip>
                                                ) : null}
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
                                                    <IntentLink
                                                        href={linkedPostHref}
                                                        aria-label={workspaceState.secondaryAction.label ?? 'Open post'}
                                                        className="ui-focus-ring flex items-center gap-1.5 rounded-lg text-sm font-semibold text-white transition hover:text-[var(--ui-primary)]"
                                                    >
                                                        <span className="truncate">{workspaceState.linkedPost.title}</span>
                                                        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                                                    </IntentLink>
                                                ) : (
                                                    <div className="truncate text-sm font-semibold text-white">{workspaceState.linkedPost.title}</div>
                                                )}
                                            </StudioDetail>
                                        ) : null}
                                        primaryAction={hasPrimaryAction ? (
                                            primaryIsPublish && workspaceState.primaryAction.href ? (
                                                <Link
                                                    href={withStudioReturn(workspaceState.primaryAction.href)}
                                                    // As the other card grids: nothing is fetched for cards scrolled past.
                                                    prefetch={false}
                                                    className={studioActionClass('primary', { size: 'md', full: true })}
                                                >
                                                    <Globe className="h-4 w-4" />
                                                    {workspaceState.primaryAction.label}
                                                </Link>
                                            ) : primaryIsUnlock && workspaceState.primaryAction.href ? (
                                                <Link
                                                    href={withStudioReturn(workspaceState.primaryAction.href)}
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
                                                    disabled={isGenerationDetailLoading || Boolean(gen.source_unavailable_at)}
                                                    title={gen.source_unavailable_at ? 'The source file is no longer available' : undefined}
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
                                // Settlement gives a failed run's credits back, so a refunded
                                // run says so where its cost was; one that kept them shows it.
                                const returnedCredits = getReturnedCreditsLabel(gen);
                                return (
                                    <StudioCard
                                        key={gen.id}
                                        density="compact"
                                        tone="failed"
                                        testId={`failed-card-${gen.id}`}
                                        anchorId={getGenerationCardAnchorId(gen.id)}
                                        highlighted={isGenerationRinged(gen.id)}
                                        media={(
                                            <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                                <span className="text-xs text-red-400/60">Generation failed</span>
                                            </div>
                                        )}
                                        chips={<StudioChip tone="rose">Failed</StudioChip>}
                                        title={failedTitle}
                                        subtitle={gen.error_message?.trim() || undefined}
                                        meta={[
                                            { label: 'Created', value: formatDate(gen.created_at) },
                                            ...(returnedCredits
                                                ? [{ label: 'Refund', value: returnedCredits }]
                                                : gen.cost ? [{
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
                                                items={[...(canRecreate(gen) ? [{
                                                    key: 'retry',
                                                    label: 'Try again',
                                                    icon: <RotateCcw className="h-4 w-4" />,
                                                    href: recreateHref(gen),
                                                }] : []), {
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
                                // A takedown archives the row too, and Restore refuses it
                                // with "Creation not found.", so it is named and not offered.
                                const isModerationRemoved = Boolean(gen.moderation_removed_at);
                                return (
                                    <StudioCard
                                        key={gen.id}
                                        density="compact"
                                        tone="archived"
                                        testId={`archived-card-${gen.id}`}
                                        anchorId={getGenerationCardAnchorId(gen.id)}
                                        highlighted={isGenerationRinged(gen.id)}
                                        media={(
                                            <div className="flex aspect-[4/5] items-center justify-center bg-black/60">
                                                <Archive className="h-8 w-8 text-zinc-600" />
                                            </div>
                                        )}
                                        chips={isModerationRemoved
                                            ? <StudioChip tone="rose">Removed by moderation</StudioChip>
                                            : <StudioChip tone="muted">Archived</StudioChip>}
                                        title={archivedTitle}
                                        meta={[{ label: 'Created', value: formatDate(gen.created_at) }]}
                                        actions={isModerationRemoved ? undefined : (
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
                            disabled={isLoadingMoreGenerations || deletesInFlight > 0}
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
                                disabled={isLoadingMorePosts || postDeletesInFlight > 0}
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
                                const editorHref = withStudioReturn(appendCreationsSource(post.ownerPath));
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
                                    // Held while a Load more is under way (removeLibraryPost).
                                    disabled: isBusy || isLoadingMorePosts,
                                    description: isLoadingMorePosts ? 'Waiting for more posts to load' : undefined,
                                    pending: pendingAction === 'delete',
                                    onSelect: () => void removeLibraryPost(post),
                                });

                                return (
                                    <StudioCard
                                        key={post.id}
                                        testId={`post-card-${post.id}`}
                                        anchorId={getPostCardAnchorId(post.id)}
                                        highlighted={returnedPostId === post.id}
                                        density="expanded"
                                        tone={post.archivedAt ? 'archived' : 'default'}
                                        media={post.mediaItems?.[0]?.sourceUnavailableAt ? (
                                            <UnavailableMediaNote testId={`post-unavailable-${post.id}`} />
                                        ) : post.mediaUrl ? (
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
                                                <img src={post.mediaItems?.[0]?.previewUrl ?? post.mediaUrl} alt={post.title} loading="lazy" decoding="async" className="aspect-[4/5] w-full object-cover" />
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
                                            <Link href={editorHref} className="transition hover:text-[var(--ui-primary)]">
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
                                                        {formatRecipeTrackRecord(post.bundle)}
                                                    </span>
                                                )}
                                            >
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <StudioChip tone="neutral">
                                                        {post.bundle.accessMode === 'free'
                                                            ? 'Free recipe'
                                                            : formatPostResourceCompactPriceLabel(post.bundle.priceUsdCents)}
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
                                                    href={editorHref}
                                                    className={studioActionClass('primary', { size: 'md' })}
                                                >
                                                    <PencilLine className="h-4 w-4" />
                                                    Edit post
                                                </Link>
                                                {post.publicPath ? (
                                                    <IntentLink
                                                        href={buildStudioDetailPath(post.id)}
                                                        className={studioActionClass('secondary', { size: 'md' })}
                                                    >
                                                        <ExternalLink className="h-4 w-4" />
                                                        View live
                                                    </IntentLink>
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
                                                        href={withStudioReturn(buildPostRecipeManagementPath(post))}
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
                                    disabled={isLoadingMorePosts || postDeletesInFlight > 0}
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
                onClose={closePreview}
                mediaType={previewGen ? getPreviewMediaType(previewGen) : 'image'}
                src={previewGen?.output_url ? resolvePlaybackUrl({
                    url: previewGen.output_url, renditionUrl: previewGen.media?.renditionUrl,
                }) : null}
                alt={previewGen ? getPreviewTitle(previewGen) : 'Creation preview'}
                title={previewGen ? getPreviewTitle(previewGen) : 'Creation preview'}
                prompt={previewGen?.prompt ?? ''}
                body={previewGen?.description ?? ''}
                inputMedia={previewGen?.input_media ?? []}
                additionalMedia={previewGen ? getAdditionalPreviewMedia(previewGen) : []}
                metadata={previewGen ? getPreviewMetadata(previewGen) : []}
                actions={previewGen ? renderPreviewActions(previewGen) : null}
                statusNote={previewGen ? getPreviewStatusNote(previewGen) : null}
            />
        </div>
    );
}
