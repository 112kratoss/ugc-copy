import { createServiceClient } from '@/lib/server-helpers';
import { logBackendError } from '@/lib/backend-logger';
import { GENERIC_SUGGESTED_TITLES } from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';

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
 * The most rows one API response carries (`max_rows` in supabase/config.toml). A `.limit()`
 * above it is cut silently, so the lists below are read in ordered pages instead.
 */
const API_PAGE_SIZE = 1000;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * Up to `limit` distinct rows, read page by page. Each page starts where the rows received so far
 * end, and the read stops at the first empty page, so a server cap below API_PAGE_SIZE costs
 * pages, not rows. `readPage` must apply a total order, or pages can repeat or skip rows.
 *
 * Live data moves between two reads: a post created, or a creator posting, ahead of the offset
 * shifts the next page by one, which then repeats the last row of the page before. Rows are kept
 * once by `keyOf`; a row shifted past the end of the list waits for the next sitemap. A page
 * that adds no new row ends the read, so rows arriving faster than pages cannot keep it going.
 */
async function readOrderedPages<T>(
    limit: number,
    keyOf: (row: T) => string,
    readPage: (from: number, to: number) => PageResult<T>,
): Promise<{ rows: T[]; error: unknown }> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let received = 0;
    while (rows.length < limit) {
        const from = received;
        const to = from + Math.min(API_PAGE_SIZE, limit - rows.length) - 1;
        const { data, error } = await readPage(from, to);
        if (error) {
            return { rows: [], error };
        }
        if (!data || data.length === 0) {
            break;
        }
        received += data.length;
        const before = rows.length;
        for (const row of data) {
            const key = keyOf(row);
            if (seen.has(key) || rows.length >= limit) continue;
            seen.add(key);
            rows.push(row);
        }
        if (rows.length === before) {
            break;
        }
    }
    return { rows, error: null };
}

/**
 * Titles the product itself writes when a user supplied none. These are real
 * page titles on live posts today, duplicated across every untitled creation,
 * which is exactly the duplicate-title cluster that suppresses a domain.
 */
const PLACEHOLDER_TITLES = new Set([
    'untitled creation',
    // What a text post with no title and no body reads (`getPublicPostDetail`).
    'untitled note',
    'untitled',
    'untitled post',
    'new post',
    'creation',
    'test',
    // What the composers suggest for a creation whose prompt gives no title
    // ("AI image", "Image recipe"): shared by many posts, so never a page title.
    ...GENERIC_SUGGESTED_TITLES,
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
        // `id` breaks ties between posts created in the same instant, so pages neither repeat nor skip.
        const { rows, error } = await readOrderedPages<ShowcaseSitemapRow>(SHOWCASE_URL_LIMIT, (row) => row.id, (from, to) => supabase
            .from('posts')
            .select('id, title, output_url, showcase_asset_path, created_at, updated_at')
            .eq('visibility', 'public')
            .eq('review_status', 'visible')
            .is('archived_at', null)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to));

        if (error) {
            logBackendError('failed_to_load_showcase_sitemap_entries', { error });
            return [];
        }

        return rows.filter(isIndexableShowcasePost);
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
 * Creators with something published, the most recently active first.
 *
 * The post count is the gate that matters: it excludes abandoned signups and
 * the test accounts that are currently indexable, without maintaining a
 * hand-written blocklist of usernames that would go stale the moment someone
 * makes a new one.
 *
 * `lastModified` comes from the creator's most recent post rather than from the
 * profile row: `profiles` has no `updated_at` column, and a profile page's
 * content is its posts anyway, so the newest one is the honest answer.
 *
 * `list_sitemap_creators` groups the public posts per creator and joins the
 * profile in the database (same gates: public, visible, unarchived posts, at
 * least MIN_PUBLIC_POSTS_FOR_INDEXING of them, a username and a non-blank
 * display name). Reading the posts here was cut at the API's 1,000 rows, and
 * the profiles read carried every id in its URL.
 */
export async function getIndexableCreators(): Promise<CreatorSitemapRow[]> {
    try {
        const supabase = createServiceClient();
        // `username` is unique, so the order is total and the pages are stable.
        const { rows, error } = await readOrderedPages<{ username: string; last_posted_at: string | null }>(
            CREATOR_URL_LIMIT,
            (row) => row.username,
            (from, to) => supabase
                .rpc('list_sitemap_creators', { p_min_posts: MIN_PUBLIC_POSTS_FOR_INDEXING, p_limit: CREATOR_URL_LIMIT })
                .order('last_posted_at', { ascending: false })
                .order('username', { ascending: true })
                .range(from, to),
        );

        if (error) {
            logBackendError('failed_to_load_creator_sitemap_entries', { error });
            return [];
        }

        return rows.map((row) => ({ username: row.username, lastPostedAt: row.last_posted_at ?? null }));
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
 * a template that would 404 or render empty must never enter a sitemap. Null
 * when the read failed: that says nothing about the catalog, so the sitemap
 * keeps listing `/templates`, as its page stays indexable then too.
 */
export async function getIndexableTemplates(): Promise<TemplateSitemapRow[] | null> {
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
            return null;
        }

        return ((data ?? []) as Array<{ slug: string | null; updated_at: string | null }>)
            .filter((row) => Boolean(row.slug?.trim()))
            .map((row) => ({ slug: row.slug as string, updated_at: row.updated_at }));
    } catch (error) {
        logBackendError('failed_to_load_template_sitemap_entries', { error });
        return null;
    }
}
