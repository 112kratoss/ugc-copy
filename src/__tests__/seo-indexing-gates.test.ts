import { describe, expect, it } from 'vitest';

import { getPostMadeWithLabel } from '@/lib/post-feed-presentation';
import { isIndexableShowcasePost, type ShowcaseSitemapRow } from '@/lib/sitemap-entries';
import {
    composeShowcaseDescription,
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
        generationId: 'gen-1',
        sourceTool: null,
        postFormat: 'media',
        category: 'video',
        model: 'seedance-2-5',
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
            { title: 'Untitled Note', expected: false },
            { title: 'test', expected: false },
            // What the composers suggest when a prompt gives no title.
            { title: 'AI image', expected: false },
            { title: 'Motion transfer recipe', expected: false },
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
            'Sunset skincare hook — AI video made with Seedance 2.5'
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
            'AI video made with Seedance 2.5 by @aria'
        );
    });

    it('distinguishes image posts from video posts', () => {
        expect(composeShowcaseTitle(postDetail({ title: 'untitled', mediaKind: 'image' })))
            .toBe('AI image made with Seedance 2.5 by @aria');
    });

    it('still produces a title when the model is unknown', () => {
        expect(composeShowcaseTitle(postDetail({ title: 'untitled', model: '' })))
            .toBe('AI video by @aria');
    });

    // A template result's model is the template's own, so its post reads
    // `template-workflow`: no model's name, as the post page and the cards say none.
    it('names no model for a template result', () => {
        expect(composeShowcaseTitle(postDetail({ model: 'template-workflow' })))
            .toBe('Sunset skincare hook — AI video');
        expect(composeShowcaseTitle(postDetail({ title: 'untitled', model: 'template-workflow' })))
            .toBe('AI video by @aria');
    });

    // The catalog names a model the way people search for it. Spacing out the
    // slug printed "Seedance 2 5" in titles while the page itself said
    // "Seedance 2.5" (SEO audit, 2026-11-13).
    it('names a catalog model by its display name', () => {
        expect(composeShowcaseTitle(postDetail({ title: 'intense', model: 'seedance-2-5' })))
            .toBe('intense — AI video made with Seedance 2.5');
        expect(composeShowcaseTitle(postDetail({ title: 'Mahabali', mediaKind: 'image', model: 'nano-banana-2' })))
            .toBe('Mahabali — AI image made with Nano Banana 2.0');
    });

    // Titles name what the post page's Made with line names, and nothing else
    // (review of #792): a retired model's slug is no name the page prints.
    it('names no model the page does not name', () => {
        expect(composeShowcaseTitle(postDetail({ model: 'kling-v2-master' })))
            .toBe('Sunset skincare hook — AI video');
    });

    // An upload was not made here, so it is no "AI video"; one that named no
    // tool reads `manual` or `external`, no model's name.
    it.each(['manual', 'external'])('calls an upload read as %j a video, with no model', (model) => {
        expect(composeShowcaseTitle(postDetail({ model, generationId: null }))).toBe('Sunset skincare hook — video');
    });

    it('names the tool an upload named as its creator wrote it', () => {
        expect(composeShowcaseTitle(postDetail({
            generationId: null, mediaKind: 'image', model: 'gpt-image-1', sourceTool: 'gpt-image-1',
        }))).toBe('Sunset skincare hook — image made with gpt-image-1');
    });

    it('does not name the app itself as an upload\'s tool', () => {
        expect(composeShowcaseTitle(postDetail({ generationId: null, model: 'magicbooklet', sourceTool: 'magicbooklet' })))
            .toBe('Sunset skincare hook — video');
    });

    it('titles a text post by its title alone, or as a post when it has none', () => {
        const textPost = { postFormat: 'text', category: 'text', mediaUrl: null, mediaKind: null } as Partial<PublicPostDetail>;
        expect(composeShowcaseTitle(postDetail({ ...textPost, title: 'My prompt pack' }))).toBe('My prompt pack');
        expect(composeShowcaseTitle(postDetail({ ...textPost, title: 'Untitled Note' }))).toBe('Post by @aria');
    });
});

describe('composeShowcaseDescription', () => {
    function withRecipe(summary: string) {
        return { summary, previewText: '' } as unknown as PublicPostDetail['resourceBundle'];
    }

    // Every post with a recipe was described by its recipe line alone,
    // "Includes the prompt.", so many pages shared one 20-character description.
    it('describes the creation, then its recipe', () => {
        expect(composeShowcaseDescription(postDetail({
            title: 'Mahabali',
            mediaKind: 'image',
            model: 'nano-banana-2',
            creator: { id: 'u2', username: 'alisa', name: 'Alisa', avatar: null } as PublicPostDetail['creator'],
            resourceBundle: withRecipe('Includes the prompt.'),
        }))).toBe('Mahabali, an AI image made with Nano Banana 2.0 by @alisa on Magic Booklet. Includes the prompt.');
    });

    it('gives two posts with the same recipe line different descriptions', () => {
        const recipe = withRecipe('Includes the prompt.');
        const first = composeShowcaseDescription(postDetail({ title: 'Mahabali', resourceBundle: recipe }));
        const second = composeShowcaseDescription(postDetail({ title: 'Neon alley', resourceBundle: recipe }));
        expect(first).not.toBe(second);
    });

    it('describes an untitled creation without its placeholder title', () => {
        expect(composeShowcaseDescription(postDetail({ title: 'Untitled Creation', model: 'seedance-2-5' })))
            .toBe('An AI video made with Seedance 2.5 by @aria on Magic Booklet.');
    });

    it('leaves out a model the page does not name and a creator with no handle', () => {
        expect(composeShowcaseDescription(postDetail({ model: 'kling-v2-master', creator: null as unknown as PublicPostDetail['creator'] })))
            .toBe('Sunset skincare hook, an AI video on Magic Booklet.');
    });

    // A creator's own camera footage is no "AI video" (review of #792).
    it('describes an upload without calling it AI', () => {
        expect(composeShowcaseDescription(postDetail({ model: 'manual', generationId: null })))
            .toBe('Sunset skincare hook, a video by @aria on Magic Booklet.');
    });

    // "Wow!, an AI image" and "Golden hour., an AI image" (review of #792).
    it.each([
        ['Golden hour.', 'Golden hour. An AI video made with Seedance 2.5 by @aria on Magic Booklet.'],
        ['Wow!', 'Wow! An AI video made with Seedance 2.5 by @aria on Magic Booklet.'],
        ['Hook:', 'Hook, an AI video made with Seedance 2.5 by @aria on Magic Booklet.'],
    ])('reads %j as a sentence of its own when it ends one', (title, expected) => {
        expect(composeShowcaseDescription(postDetail({ title }))).toBe(expected);
    });

    it('describes a text post titled "Untitled Note" without that title', () => {
        expect(composeShowcaseDescription(postDetail({
            title: 'Untitled Note', postFormat: 'text', category: 'text', mediaUrl: null, mediaKind: null,
        }))).toBe('A post by @aria on Magic Booklet.');
    });

    // A text post's words are its body; one with none is no AI creation.
    it('describes a text post with no body as a post', () => {
        expect(composeShowcaseDescription(postDetail({
            title: 'My prompt pack',
            postFormat: 'text',
            category: 'text',
            mediaKind: null,
            mediaUrl: null,
            model: 'external',
            resourceBundle: withRecipe('Includes 3 prompts.'),
        }))).toBe('My prompt pack, a post by @aria on Magic Booklet. Includes 3 prompts.');
    });

    it('falls back to the recipe preview when the recipe has no summary', () => {
        expect(composeShowcaseDescription(postDetail({
            resourceBundle: { summary: '', previewText: 'Prompt and two reference images.' } as unknown as PublicPostDetail['resourceBundle'],
        }))).toBe('Sunset skincare hook, an AI video made with Seedance 2.5 by @aria on Magic Booklet. Prompt and two reference images.');
    });
});

// The one rule for what a post was made with: the post page's Made with line,
// its title and its description all read it (review of #792).
describe('getPostMadeWithLabel', () => {
    const post = (overrides: Partial<PublicPostDetail>) => postDetail(overrides);

    it.each([
        ['a catalog model by its display name', post({ model: 'seedance-2-5' }), 'Seedance 2.5'],
        ['nothing for a retired model\'s slug', post({ model: 'kling-v2-master' }), null],
        ['an outside tool as its creator wrote it', post({ generationId: null, model: 'iPhone 15', sourceTool: 'iPhone 15' }), 'iPhone 15'],
        ['nothing for the app\'s own name', post({ generationId: null, model: 'magicbooklet', sourceTool: 'Magic Booklet' }), null],
        ['nothing for an upload that named no tool', post({ generationId: null, model: 'manual', sourceTool: null }), null],
        ['nothing for a text post', post({ postFormat: 'text', category: 'text', mediaUrl: null, mediaKind: null, model: 'external', sourceTool: 'ChatGPT' }), null],
    ])('names %s', (_case, detail, expected) => {
        expect(getPostMadeWithLabel(detail)).toBe(expected);
    });
});

describe('hasMeaningfulTitle', () => {
    it.each([
        ['Sunset skincare hook', true],
        ['Untitled Creation', false],
        // A text post with no title and no body reads "Untitled Note".
        ['Untitled Note', false],
        ['UNTITLED', false],
        ['test', false],
        ['AI video', false],
        ['Image recipe', false],
        ['ab', false],
        ['', false],
        [null, false],
    ])('scores %j as %s', (title, expected) => {
        expect(hasMeaningfulTitle(title)).toBe(expected);
    });
});
