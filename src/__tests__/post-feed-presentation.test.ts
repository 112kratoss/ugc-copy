import { describe, expect, it } from 'vitest';

import {
    buildPostFeedCard,
    buildPostFeedCards,
    estimateWrappedLineCount,
    formatCompactCount,
    formatRelativeTime,
    getPostBodyClampLines,
    getPostBodyFontSize,
    getPostCategoryLabel,
    getPostFeedBody,
    getPostFeedTitle,
    isFramedPostBody,
    isTextOnlyPost,
    resolvePostPreviewKind,
} from '@/lib/post-feed-presentation';
import type { ShowcaseFeedItem } from '@/lib/showcase';

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
    return {
        id: 'post-1',
        mediaUrl: 'https://cdn.example.test/post-1.png',
        mediaKind: 'image',
        model: 'Nano Banana',
        title: 'A launch frame',
        prompt: 'a cinematic product frame',
        body: '',
        category: 'image',
        postFormat: 'media',
        saveCount: 1200,
        remixCount: 8,
        commentCount: 34,
        createdAt: '2026-07-28T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'batman', name: 'Batman', avatar: null },
        sourceKind: 'magicbooklet',
        sourceTool: null,
        generationId: 'gen-1',
        asset: null,
        canRemix: true,
        ...overrides,
    } as ShowcaseFeedItem;
}

const textItem = (overrides: Partial<ShowcaseFeedItem> = {}) => item({
    mediaUrl: null,
    mediaKind: null,
    category: 'text',
    postFormat: 'text',
    prompt: '',
    body: 'A reusable note for framing a launch post.',
    ...overrides,
});

describe('post feed presentation', () => {
    describe('preview kind', () => {
        it('treats a post with no media as text whatever the format says', () => {
            expect(resolvePostPreviewKind(textItem())).toBe('text');
            expect(resolvePostPreviewKind(item({ mediaUrl: null, postFormat: 'mixed', body: 'words' }))).toBe('text');
        });

        it('separates a captioned mixed post from a plain media post', () => {
            expect(resolvePostPreviewKind(item({ postFormat: 'mixed', body: 'Here is how I lit it.' }))).toBe('mixed');
            expect(resolvePostPreviewKind(item())).toBe('media');
        });

        it('falls back to media when a mixed post has no body to show', () => {
            expect(resolvePostPreviewKind(item({ postFormat: 'mixed', body: '   ' }))).toBe('media');
        });
    });

    describe('text-only posts', () => {
        it('identifies the posts the Showcase grid cannot tile', () => {
            expect(isTextOnlyPost({ category: 'text', postFormat: 'text', mediaUrl: null })).toBe(true);
            expect(isTextOnlyPost({ category: 'image', postFormat: 'text', mediaUrl: null })).toBe(true);
            expect(isTextOnlyPost({ category: 'text', postFormat: 'text', mediaUrl: 'https://cdn/x.png' })).toBe(false);
            expect(isTextOnlyPost({ category: 'image', postFormat: 'media', mediaUrl: null })).toBe(false);
        });
    });

    describe('title and body', () => {
        it('replaces a placeholder title with real post content', () => {
            expect(getPostFeedTitle(item({ title: 'Untitled Creation' }), 'media'))
                .toBe('a cinematic product frame');
            expect(getPostFeedTitle(textItem({ title: 'Untitled note' }), 'text'))
                .toBe('A reusable note for framing a launch post.');
        });

        it('names the format when there is nothing else to show', () => {
            expect(getPostFeedTitle(item({ title: 'Untitled', prompt: '', body: '' }), 'media'))
                .toBe('Image creation');
            expect(getPostFeedTitle(item({ title: '', prompt: '', body: '', category: 'video', mediaKind: 'video' }), 'media'))
                .toBe('Video creation');
            expect(getPostFeedTitle(textItem({ title: '', prompt: '', body: '' }), 'text'))
                .toBe('Creator note');
        });

        it('never repeats the title as the body', () => {
            const post = item({ title: '', prompt: 'a cinematic product frame', body: '' });

            expect(getPostFeedTitle(post, 'media')).toBe('a cinematic product frame');
            expect(getPostFeedBody(post, 'media')).toBe('');
        });

        it('prefers the note over the prompt for a text post, and the reverse for media', () => {
            const post = item({ title: 'Titled', prompt: 'the prompt', body: 'the note' });

            expect(getPostFeedBody(post, 'text')).toBe('the note');
            expect(getPostFeedBody(post, 'media')).toBe('the prompt');
        });
    });

    describe('body framing', () => {
        it('gives a text post the most room and its own frame', () => {
            expect(getPostBodyClampLines('text')).toBe(8);
            expect(isFramedPostBody('text')).toBe(true);
            expect(getPostBodyFontSize('text')).toBe(16);
        });

        it('keeps a caption compact and unframed', () => {
            expect(getPostBodyClampLines('mixed')).toBe(3);
            expect(getPostBodyClampLines('media')).toBe(2);
            expect(isFramedPostBody('mixed')).toBe(false);
            expect(getPostBodyFontSize('media')).toBe(14);
        });
    });

    describe('line estimation', () => {
        it('counts a hard newline as its own line', () => {
            expect(estimateWrappedLineCount('one\ntwo\nthree', 400, 16)).toBe(3);
            expect(estimateWrappedLineCount('para\n\npara', 400, 16)).toBe(3);
        });

        it('wraps long text by the available width', () => {
            const text = 'x'.repeat(200);

            expect(estimateWrappedLineCount(text, 400, 16))
                .toBeGreaterThan(estimateWrappedLineCount(text, 800, 16));
        });

        it('reports no lines for empty text or a zero width', () => {
            expect(estimateWrappedLineCount('', 400, 16)).toBe(0);
            expect(estimateWrappedLineCount('words', 0, 16)).toBe(0);
            expect(estimateWrappedLineCount('words', 400, 0)).toBe(0);
        });
    });

    describe('card building', () => {
        it('offers Read more only when the clamp hides something', () => {
            expect(buildPostFeedCard(textItem({ body: 'One short line.' })).canExpandBody).toBe(false);
            expect(buildPostFeedCard(textItem({ body: 'sentence. '.repeat(400) })).canExpandBody).toBe(true);
        });

        it('never offers Read more for a post with no body', () => {
            const card = buildPostFeedCard(item({ title: 'A launch frame', prompt: '', body: '' }));

            expect(card.body).toBe('');
            expect(card.canExpandBody).toBe(false);
        });

        it('labels category, counts, and creator', () => {
            const card = buildPostFeedCard(item(), new Date('2026-07-28T03:00:00.000Z'));

            expect(card.categoryLabel).toBe('Image');
            expect(card.creatorLabel).toBe('@batman');
            expect(card.saveLabel).toBe('1.2K');
            expect(card.commentLabel).toBe('34');
            expect(card.timeLabel).toBe('3h');
        });

        // Mirrored on mobile in home-feed-view-model.test.ts — the two clients
        // duplicate these rules on purpose.
        it('reads action labels as verbs until there is social proof', () => {
            const quiet = buildPostFeedCard(item({ saveCount: 0, commentCount: 0, remixCount: 0 }));

            expect(quiet.saveLabel).toBe('Save');
            expect(quiet.commentLabel).toBe('Comment');
            expect(quiet.remixLabel).toBe('Remix');

            const busy = buildPostFeedCard(item({ remixCount: 8 }));
            expect(busy.remixLabel).toBe('Remix · 8');
        });

        it('builds a creation metadata line for media posts only', () => {
            const known = buildPostFeedCard(item({ model: 'gpt-image-2', canRemix: true }));
            expect(known.metadataLabel).toBe('Image · GPT Image 2 · Remixable');

            // Unknown model slugs are omitted rather than leaked.
            const unknown = buildPostFeedCard(item({ model: 'mystery-model-9', canRemix: false }));
            expect(unknown.metadataLabel).toBe('Image');

            expect(buildPostFeedCard(textItem()).metadataLabel).toBeNull();
        });

        it('keeps the original item available for actions and media', () => {
            const source = item();

            expect(buildPostFeedCard(source).item).toBe(source);
            expect(buildPostFeedCards([source, textItem({ id: 'post-2' })]).map((card) => card.id))
                .toEqual(['post-1', 'post-2']);
        });
    });

    describe('labels', () => {
        it('names each post format', () => {
            expect(getPostCategoryLabel(item())).toBe('Image');
            expect(getPostCategoryLabel(item({ category: 'video', mediaKind: 'video' }))).toBe('Video');
            expect(getPostCategoryLabel(textItem())).toBe('Text');
            expect(getPostCategoryLabel(item({ creationMode: 'motion' }))).toBe('Motion');
        });

        it('compacts large counts and floors negatives at zero', () => {
            expect(formatCompactCount(0)).toBe('0');
            expect(formatCompactCount(999)).toBe('999');
            expect(formatCompactCount(1200)).toBe('1.2K');
            expect(formatCompactCount(2_400_000)).toBe('2.4M');
            expect(formatCompactCount(-5)).toBe('0');
            expect(formatCompactCount(null)).toBe('0');
        });

        it('formats relative time in feed-sized units', () => {
            const now = new Date('2026-07-28T12:00:00.000Z');
            const ago = (ms: number) => formatRelativeTime(new Date(now.getTime() - ms).toISOString(), now);

            expect(ago(5_000)).toBe('now');
            expect(ago(5 * 60_000)).toBe('5m');
            expect(ago(3 * 3_600_000)).toBe('3h');
            expect(ago(3 * 86_400_000)).toBe('3d');
            expect(ago(14 * 86_400_000)).toBe('2w');
            expect(ago(90 * 86_400_000)).toBe('3mo');
            expect(ago(800 * 86_400_000)).toBe('2y');
        });

        it('returns nothing for an unparseable timestamp', () => {
            expect(formatRelativeTime('not-a-date')).toBe('');
        });
    });
});
