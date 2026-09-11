import { createServiceClient } from '@/lib/server-helpers';
import { logBackendError } from '@/lib/backend-logger';

/**
 * Discovery for everything the product generates.
 *
 * The sitemap used to list twelve static routes plus the blog, which meant the
 * entire user-generated corpus — the only content that grows without someone
 * writing it — was undiscoverable. The detail pages were always server-rendered
 * and indexable; nothing linked to them that a crawler could follow, because the
 * `/showcase` index renders client-side.
 *
 * Everything here is gated. Indexing every row would trade one problem for a
 * worse one: a few hundred thin, untitled, or half-published pages entering the
 * index drags the whole domain, and the pages that deserve to rank compete with
 * placeholders for crawl budget.
 */

/** Sitemaps cap at 50k URLs; stay well inside it until this warrants splitting. */
const SHOWCASE_URL_LIMIT = 5000;
const CREATOR_URL_LIMIT = 2000;
const TEMPLATE_URL_LIMIT = 2000;

/** A creator with nothing published has no page worth indexing. */
const MIN_PUBLIC_POSTS_FOR_INDEXING = 1;

/**
 * Titles the product itself writes when a user supplied none. These are real
 * page titles on live posts today, duplicated across every untitled creation,
 * which is exactly the duplicate-title cluster that suppresses a domain.
 */
const PLACEHOLDER_TITLES = new Set([
    'untitled creation',
    'untitled',
    'untitled post',
    'new post',
    'creation',
    'test',
]);

const MIN_TITLE_LENGTH = 3;

export type ShowcaseSitemapRow = {
    id: string;
    title: string | null;
    output_url: string | null;
    showcase_asset_path: string | null;
    created_at: string;
    updated_at?: string | null;
};

/**
 * The indexing gate for a single post, kept pure so the policy can be tested
 * without a database. A post has to be publicly visible, moderation-approved,
 * carry media, and have a title a human chose.
 *
 * `unlisted` deliberately fails: an unlisted post is reachable by link but is
 * not meant to be discoverable, and putting one in a sitemap is the most direct
 * way to break that promise.
 */
export function isIndexableShowcasePost(row: ShowcaseSitemapRow): boolean {
    const hasMedia = Boolean(row.output_url || row.showcase_asset_path);
    if (!hasMedia) {
        return false;
    }

    const title = row.title?.trim().toLowerCase() ?? '';
    if (title.length < MIN_TITLE_LENGTH) {
        return false;
    }

    return !PLACEHOLDER_TITLES.has(title);
}

/**
 * Published posts that clear the gate, newest first.
 *
 * Reads run through the service client because `posts` is not readable by an
 * anonymous role, and a sitemap is generated without a session. The moderation
 * and visibility filters are applied in the query rather than in
 * `isIndexableShowcasePost` so an unapproved row never leaves the database.
 */
export async function getIndexableShowcasePosts(): Promise<ShowcaseSitemapRow[]> {
    try {
        const supabase = createServiceClient();
        const { data, error } = await supabase
            .from('posts')
            .select('id, title, output_url, showcase_asset_path, created_at, updated_at')
            .eq('visibility', 'public')
            .eq('review_status', 'visible')
            .is('archived_at', null)
            .order('created_at', { ascending: false })
            .limit(SHOWCASE_URL_LIMIT);

        if (error) {
            logBackendError('failed_to_load_showcase_sitemap_entries', { error });
            return [];
        }

        return ((data ?? []) as ShowcaseSitemapRow[]).filter(isIndexableShowcasePost);
    } catch (error) {
        logBackendError('failed_to_load_showcase_sitemap_entries', { error });
        return [];
    }
}

export type CreatorSitemapRow = {
    username: string;
    lastPostedAt: string | null;
};

/**
 * Creators with something published.
 *
 * The post count is the gate that matters: it excludes abandoned signups and
 * the test accounts that are currently indexable, without maintaining a
 * hand-written blocklist of usernames that would go stale the moment someone
 * makes a new one.
 *
 * `lastModified` comes from the creator's most recent post rather than from the
 * profile row: `profiles` has no `updated_at` column, and a profile page's
 * content is its posts anyway, so the newest one is the honest answer. It costs
 * nothing extra — the same rows are already being read to count them.
 */
export async function getIndexableCreators(): Promise<CreatorSitemapRow[]> {
    try {
        const supabase = createServiceClient();

        const { data: postRows, error: postError } = await supabase
            .from('posts')
            .select('user_id, created_at')
            .eq('visibility', 'public')
            .eq('review_status', 'visible')
            .is('archived_at', null)
            .limit(20000);

        if (postError) {
            logBackendError('failed_to_load_creator_sitemap_entries', { error: postError });
            return [];
        }

        const stats = new Map<string, { count: number; lastPostedAt: string | null }>();
        for (const row of (postRows ?? []) as Array<{ user_id: string | null; created_at: string | null }>) {
            if (!row.user_id) continue;
            const existing = stats.get(row.user_id);
            const lastPostedAt = !existing?.lastPostedAt
                || (row.created_at && row.created_at > existing.lastPostedAt)
                ? row.created_at ?? existing?.lastPostedAt ?? null
                : existing.lastPostedAt;
            stats.set(row.user_id, {
                count: (existing?.count ?? 0) + 1,
                lastPostedAt,
            });
        }

        const publishingUserIds = [...stats.entries()]
            .filter(([, entry]) => entry.count >= MIN_PUBLIC_POSTS_FOR_INDEXING)
            .map(([userId]) => userId)
            .slice(0, CREATOR_URL_LIMIT);

        if (publishingUserIds.length === 0) {
            return [];
        }

        const { data, error } = await supabase
            .from('profiles')
            .select('id, username, display_name')
            .in('id', publishingUserIds)
            .not('username', 'is', null)
            .not('display_name', 'is', null);

        if (error) {
            logBackendError('failed_to_load_creator_sitemap_entries', { error });
            return [];
        }

        return ((data ?? []) as Array<{ id: string; username: string | null; display_name: string | null }>)
            .filter((row) => Boolean(row.username?.trim() && row.display_name?.trim()))
            .map((row) => ({
                username: row.username as string,
                lastPostedAt: stats.get(row.id)?.lastPostedAt ?? null,
            }));
    } catch (error) {
        logBackendError('failed_to_load_creator_sitemap_entries', { error });
        return [];
    }
}

export type TemplateSitemapRow = {
    slug: string;
    updated_at: string | null;
};

/**
 * Active templates, matching the same filters the public catalogue applies —
 * a template that would 404 or render empty must never enter a sitemap.
 */
export async function getIndexableTemplates(): Promise<TemplateSitemapRow[]> {
    try {
        const supabase = createServiceClient();
        const { data, error } = await supabase
            .from('templates')
            .select('slug, updated_at')
            .eq('status', 'active')
            .eq('is_active', true)
            .not('active_version_id', 'is', null)
            .not('creator_user_id', 'is', null)
            .not('slug', 'is', null)
            .order('created_at', { ascending: false })
            .limit(TEMPLATE_URL_LIMIT);

        if (error) {
            logBackendError('failed_to_load_template_sitemap_entries', { error });
            return [];
        }

        return ((data ?? []) as Array<{ slug: string | null; updated_at: string | null }>)
            .filter((row) => Boolean(row.slug?.trim()))
            .map((row) => ({ slug: row.slug as string, updated_at: row.updated_at }));
    } catch (error) {
        logBackendError('failed_to_load_template_sitemap_entries', { error });
        return [];
    }
}
