import { describe, expect, it } from 'vitest';

import { isIndexableShowcasePost, type ShowcaseSitemapRow } from '@/lib/sitemap-entries';
import {
    composeShowcaseTitle,
    hasMeaningfulTitle,
    isShowcaseDetailIndexable,
} from '@/lib/showcase-seo';
import type { PublicPostDetail } from '@/lib/public-posts';

function showcaseRow(overrides: Partial<ShowcaseSitemapRow> = {}): ShowcaseSitemapRow {
    return {
        id: 'f0316319-0000-4000-8000-000000000000',
        title: 'Sunset skincare hook',
        output_url: 'https://example.test/media.mp4',
        showcase_asset_path: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: null,
        ...overrides,
    };
}

function postDetail(overrides: Partial<PublicPostDetail> = {}): PublicPostDetail {
    return {
        visibility: 'public',
        title: 'Sunset skincare hook',
        mediaUrl: 'https://example.test/media.mp4',
        mediaKind: 'video',
        mediaItems: [],
        model: 'kling-v2-master',
        createdAt: '2026-09-01T00:00:00.000Z',
        creator: { id: 'u1', username: 'aria', name: 'Aria', avatar: null },
        ...overrides,
    } as unknown as PublicPostDetail;
}

describe('showcase sitemap gate', () => {
    it('admits a public post with media and a real title', () => {
        expect(isIndexableShowcasePost(showcaseRow())).toBe(true);
    });

    it('rejects posts with no media', () => {
        expect(isIndexableShowcasePost(
            showcaseRow({ output_url: null, showcase_asset_path: null })
        )).toBe(false);
    });

    it('accepts a post whose media is a stored asset path rather than a URL', () => {
        expect(isIndexableShowcasePost(
            showcaseRow({ output_url: null, showcase_asset_path: 'showcase/abc.mp4' })
        )).toBe(true);
    });

    // These are real titles on live posts. Indexing them produced several pages
    // sharing one <title>, which is the duplicate cluster that suppresses a
    // domain rather than the individual page.
    it.each(['Untitled Creation', 'untitled', 'test', 'New Post', '  '])(
        'rejects the placeholder title %j',
        (title) => {
            expect(isIndexableShowcasePost(showcaseRow({ title }))).toBe(false);
        }
    );

    it('rejects a null title', () => {
        expect(isIndexableShowcasePost(showcaseRow({ title: null }))).toBe(false);
    });
});

describe('showcase detail indexability', () => {
    it('admits a public, titled post with media', () => {
        expect(isShowcaseDetailIndexable(postDetail())).toBe(true);
    });

    // Unlisted means reachable by link but not discoverable. Submitting one to
    // an index breaks that promise, so it must fail here and in the sitemap.
    it('rejects unlisted posts', () => {
        expect(isShowcaseDetailIndexable(postDetail({ visibility: 'unlisted' }))).toBe(false);
    });

    it('rejects untitled posts', () => {
        expect(isShowcaseDetailIndexable(postDetail({ title: 'Untitled Creation' }))).toBe(false);
    });

    it('rejects posts with no media at all', () => {
        expect(isShowcaseDetailIndexable(
            postDetail({ mediaUrl: null, mediaItems: [] })
        )).toBe(false);
    });

    // The page gate and the sitemap gate have to agree. If they drift, the site
    // submits URLs that then tell the crawler not to index them.
    it('agrees with the sitemap gate on the same post', () => {
        const cases: Array<{ title: string | null; expected: boolean }> = [
            { title: 'Sunset skincare hook', expected: true },
            { title: 'Untitled Creation', expected: false },
            { title: 'test', expected: false },
            { title: null, expected: false },
        ];

        for (const { title, expected } of cases) {
            expect(isIndexableShowcasePost(showcaseRow({ title }))).toBe(expected);
            expect(isShowcaseDetailIndexable(postDetail({ title: title ?? '' }))).toBe(expected);
        }
    });
});

describe('composeShowcaseTitle', () => {
    it('keeps a real title and adds the model context', () => {
        expect(composeShowcaseTitle(postDetail())).toBe(
            'Sunset skincare hook — AI video made with Kling V2 Master'
        );
    });

    it('falls back to the bare title when the composed form would be too long', () => {
        const longTitle = 'A hyperrealistic cinematic portrait of this person in golden hour';
        expect(composeShowcaseTitle(postDetail({ title: longTitle }))).toBe(longTitle);
    });

    // Every untitled post used to share the string "Untitled Creation". Naming
    // the model and the creator makes them distinct from one another.
    it('describes an untitled post instead of repeating a placeholder', () => {
        expect(composeShowcaseTitle(postDetail({ title: 'Untitled Creation' }))).toBe(
            'AI video made with Kling V2 Master by @aria'
        );
    });

    it('distinguishes image posts from video posts', () => {
        expect(composeShowcaseTitle(postDetail({ title: 'untitled', mediaKind: 'image' })))
            .toBe('AI image made with Kling V2 Master by @aria');
    });

    it('still produces a title when the model is unknown', () => {
        expect(composeShowcaseTitle(postDetail({ title: 'untitled', model: '' })))
            .toBe('AI video by @aria');
    });
});

describe('hasMeaningfulTitle', () => {
    it.each([
        ['Sunset skincare hook', true],
        ['Untitled Creation', false],
        ['UNTITLED', false],
        ['test', false],
        ['ab', false],
        ['', false],
        [null, false],
    ])('scores %j as %s', (title, expected) => {
        expect(hasMeaningfulTitle(title)).toBe(expected);
    });
});
