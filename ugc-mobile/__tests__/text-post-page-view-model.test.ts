import { describe, expect, it } from 'vitest';

import { buildTextPostPage } from '@/lib/text-post-page-view-model';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

const NOW = new Date('2026-08-02T12:00:00.000Z');

function textItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    title: 'Three hooks that keep working',
    displayText: 'Open with tension.\nMake the first line earn attention.',
    creatorLabel: '@batman',
    badge: 'Text',
    createdAt: '2026-08-02T09:00:00.000Z',
    commentCount: 0,
    canComment: true,
    previewKind: 'text',
    mediaKind: null,
    mediaItems: [],
    showcasePostId: 'post-1',
    ...overrides,
  } as unknown as ImmersivePreviewItem;
}

describe('buildTextPostPage', () => {
  it('keeps the title and body separate when they differ', () => {
    const page = buildTextPostPage(textItem(), NOW);

    expect(page.title).toBe('Three hooks that keep working');
    expect(page.body).toBe('Open with tension.\nMake the first line earn attention.');
    expect(page.handle).toBe('@batman');
    expect(page.flairLabel).toBe('Text');
    // Mobile's own relative format, shared with the feed card.
    expect(page.timeLabel).toBe('3h ago');
  });

  it('drops a body that only repeats the title', () => {
    // An untitled post arrives with title and displayText set to the same text.
    const repeated = 'A note with no title of its own.';
    const page = buildTextPostPage(textItem({ title: repeated, displayText: repeated }), NOW);

    expect(page.title).toBe(repeated);
    expect(page.body).toBe('');
  });

  it('ignores whitespace and case when comparing title to body', () => {
    const page = buildTextPostPage(textItem({
      title: 'Same  Sentence',
      displayText: 'same sentence',
    }), NOW);

    expect(page.body).toBe('');
  });

  it('pluralises the comment label', () => {
    expect(buildTextPostPage(textItem({ commentCount: 0 }), NOW).commentLabel).toBe('No comments yet');
    expect(buildTextPostPage(textItem({ commentCount: 1 }), NOW).commentLabel).toBe('1 comment');
    expect(buildTextPostPage(textItem({ commentCount: 12 }), NOW).commentLabel).toBe('12 comments');
  });
});
