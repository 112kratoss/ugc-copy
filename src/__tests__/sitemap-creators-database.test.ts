import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database audit, 2026-11-27: `list_sitemap_creators` replaced the sitemap's two-step creator
 * read. Below 1,000 public posts that old read was correct, so on such data the function must
 * answer exactly what it answered. `legacyCreators` is the old code of getIndexableCreators
 * (src/lib/sitemap-entries.ts before the change), unchanged but for taking its two reads as
 * arguments; it runs here on rows read the way PostgREST serialises them.
 */
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const MIN_PUBLIC_POSTS_FOR_INDEXING = 1;
const CREATOR_URL_LIMIT = 2000;

function legacyCreators(
    postRows: Array<{ user_id: string | null; created_at: string | null }>,
    readProfiles: (ids: string[]) => Array<{ id: string; username: string | null; display_name: string | null }>,
) {
    const stats = new Map<string, { count: number; lastPostedAt: string | null }>();
    for (const row of postRows) {
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

    return readProfiles(publishingUserIds)
        .filter((row) => Boolean(row.username?.trim() && row.display_name?.trim()))
        .map((row) => ({
            username: row.username as string,
            lastPostedAt: stats.get(row.id)?.lastPostedAt ?? null,
        }));
}

describe.skipIf(!connectionString)('list_sitemap_creators equals the old two-step read', () => {
    let db: Client;

    beforeAll(async () => {
        expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
        db = new Client({ connectionString, statement_timeout: 20000 });
        await db.connect();
    });
    afterAll(async () => { await db?.end(); });

    it('answers the same creators and dates on data under 1,000 posts', async () => {
        await db.query('begin');
        try {
            // 240 creators; names, visibility, review and archive states vary with n, and some
            // creators have several posts, one of them sharing an instant with another's.
            await db.query(`
                insert into auth.users (id, email, aud, role, created_at)
                select ('5b000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
                       'sitemap-db-' || n || '@example.invalid', 'authenticated', 'authenticated', '1900-01-01'
                from generate_series(1, 240) n`);
            await db.query(`
                update public.profiles p
                set username = case when n % 31 = 0 then null else 'smdb-' || n end,
                    display_name = case when n % 17 = 0 then null when n % 19 = 0 then '  ' else 'Creator ' || n end
                from generate_series(1, 240) n
                where p.id = ('5b000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid`);
            await db.query(`
                insert into public.posts (user_id, visibility, category, source_kind, post_format, review_status, body, created_at, archived_at)
                select ('5b000000-0000-4000-8000-' || lpad((1 + (k % 240))::text, 12, '0'))::uuid,
                       case when k % 7 = 0 then 'private' else 'public' end,
                       'text', 'external', 'text',
                       case when k % 11 = 0 then 'hidden' else 'visible' end,
                       'post ' || k,
                       timestamptz '2003-01-01' + make_interval(secs => (k * 7919) % 100000) + make_interval(secs => (k % 13) * 0.25),
                       case when k % 23 = 0 then timestamptz '2004-01-01' end
                from generate_series(1, 900) k`);

            const scope = `user_id::text like '5b000000-%'`;
            const posts = (await db.query(`
                select user_id::text, to_json(created_at) #>> '{}' as created_at
                from public.posts
                where visibility = 'public' and review_status = 'visible' and archived_at is null and ${scope}`)).rows;
            expect(posts.length).toBeLessThan(1000);
            const profiles = (await db.query(`
                select id::text, username, display_name from public.profiles
                where id::text like '5b000000-%' and username is not null and display_name is not null`)).rows;
            const legacy = legacyCreators(posts, (ids) => profiles.filter((row) => ids.includes(row.id)));

            const current = (await db.query(`
                select c.username, to_json(c.last_posted_at) #>> '{}' as last_posted_at
                from public.list_sitemap_creators(1, 2000) c
                where c.username like 'smdb-%'`)).rows
                .map((row) => ({ username: row.username as string, lastPostedAt: row.last_posted_at as string | null }));

            const byName = (a: { username: string }, b: { username: string }) => a.username.localeCompare(b.username);
            expect(legacy.length).toBeGreaterThan(150);
            expect(current.sort(byName)).toEqual([...legacy].sort(byName));
        } finally {
            await db.query('rollback');
        }
    });
});
