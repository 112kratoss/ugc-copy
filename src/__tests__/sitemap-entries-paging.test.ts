import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Database audit, 2026-11-27: the API answers at most 1,000 rows (`max_rows` in
 * supabase/config.toml), so the sitemap's `.limit(5000)` showcase read and its `.limit(20000)`
 * creator read were both cut at 1,000 without an error. The creator list is now one grouped SQL
 * function (`list_sitemap_creators`, proved against the old logic in
 * supabase/tests/database/sitemap_creators.test.sql) and both lists are read in ordered pages.
 * This fake answers like PostgREST: never more than MAX_ROWS rows, whatever range is asked.
 */
const MAX_ROWS = 1000;

type Call = { kind: 'from' | 'rpc'; name: string; args?: unknown; filters: string[]; orders: string[]; range?: [number, number] };
const state: { posts: Array<Record<string, unknown>>; creators: Array<Record<string, unknown>>; calls: Call[]; failOnCall: number | null } = {
    posts: [],
    creators: [],
    calls: [],
    failOnCall: null,
};

function builder(call: Call, rows: () => Array<Record<string, unknown>>) {
    const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { call.filters.push(`${column}=${String(value)}`); return chain; },
        is: (column: string, value: unknown) => { call.filters.push(`${column} is ${String(value)}`); return chain; },
        not: () => chain,
        in: () => { throw new Error('no .in() read: a long id list overflows the URL'); },
        order: (column: string, options?: { ascending?: boolean }) => { call.orders.push(`${column} ${options?.ascending === false ? 'desc' : 'asc'}`); return chain; },
        limit: () => { throw new Error('no .limit(): the API cuts it at max_rows'); },
        range: (from: number, to: number) => {
            call.range = [from, to];
            const index = state.calls.indexOf(call);
            if (state.failOnCall === index) {
                return Promise.resolve({ data: null, error: { message: 'boom' } });
            }
            const all = rows();
            const page = all.slice(from, Math.min(to + 1, from + MAX_ROWS));
            return Promise.resolve({ data: page, error: null });
        },
    };
    return chain;
}

vi.mock('@/lib/backend-logger', () => ({ logBackendError: vi.fn() }));
vi.mock('@/lib/server-helpers', () => ({
    createServiceClient: () => ({
        from: (name: string) => {
            const call: Call = { kind: 'from', name, filters: [], orders: [] };
            state.calls.push(call);
            return builder(call, () => state.posts);
        },
        rpc: (name: string, args: unknown) => {
            const call: Call = { kind: 'rpc', name, args, filters: [], orders: [] };
            state.calls.push(call);
            return builder(call, () => state.creators);
        },
    }),
}));

import { getIndexableCreators, getIndexableShowcasePosts } from '@/lib/sitemap-entries';

function post(n: number) {
    return {
        id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        title: `A real title ${n}`,
        output_url: `https://example.invalid/${n}.png`,
        showcase_asset_path: null,
        created_at: new Date(Date.UTC(2026, 0, 1) - n * 1000).toISOString(),
        updated_at: null,
    };
}

beforeEach(() => {
    state.posts = [];
    state.creators = [];
    state.calls = [];
    state.failOnCall = null;
});

describe('showcase sitemap entries', () => {
    it('lists up to 5,000 posts, past the 1,000-row page', async () => {
        state.posts = Array.from({ length: 2500 }, (_, i) => post(i));
        const rows = await getIndexableShowcasePosts();
        expect(rows).toHaveLength(2500);
        expect(rows.map((row) => row.id)).toEqual(state.posts.map((row) => row.id));
    });

    it('stops at 5,000 and reads in a stable order', async () => {
        state.posts = Array.from({ length: 6200 }, (_, i) => post(i));
        const rows = await getIndexableShowcasePosts();
        expect(rows).toHaveLength(5000);
        const reads = state.calls.filter((call) => call.kind === 'from');
        expect(reads.every((call) => call.name === 'posts')).toBe(true);
        expect(reads.every((call) => call.orders.join(',') === 'created_at desc,id desc')).toBe(true);
        expect(reads[0].filters).toEqual(['visibility=public', 'review_status=visible', 'archived_at is null']);
        expect(reads.at(-1)?.range?.[1]).toBe(4999);
    });

    it('keeps the gate on titles', async () => {
        state.posts = [post(1), { ...post(2), title: 'Untitled creation' }];
        expect((await getIndexableShowcasePosts()).map((row) => row.id)).toEqual([post(1).id]);
    });

    it('lists nothing when a page fails, as a failed read always did', async () => {
        state.posts = Array.from({ length: 2500 }, (_, i) => post(i));
        state.failOnCall = 1;
        expect(await getIndexableShowcasePosts()).toEqual([]);
    });
});

describe('creator sitemap entries', () => {
    it('reads the grouped function in pages, past the 1,000-row page', async () => {
        state.creators = Array.from({ length: 1500 }, (_, i) => ({
            username: `creator-${i}`,
            last_posted_at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString(),
        }));
        const rows = await getIndexableCreators();
        expect(rows).toHaveLength(1500);
        expect(rows[0]).toEqual({ username: 'creator-0', lastPostedAt: state.creators[0].last_posted_at });
        const reads = state.calls;
        expect(reads.every((call) => call.kind === 'rpc' && call.name === 'list_sitemap_creators')).toBe(true);
        expect(reads[0].args).toEqual({ p_min_posts: 1, p_limit: 2000 });
        expect(reads.every((call) => call.orders.join(',') === 'last_posted_at desc,username asc')).toBe(true);
    });

    it('lists nothing when the read fails', async () => {
        state.creators = [{ username: 'a-creator', last_posted_at: null }];
        state.failOnCall = 0;
        expect(await getIndexableCreators()).toEqual([]);
    });
});
