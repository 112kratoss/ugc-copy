import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('comment authentication return integration', () => {
  it('attaches the shared thread to text posts and restores inline comment intent', () => {
    const source = readFileSync('app/post/[id].tsx', 'utf8');

    expect(source).toContain('requestedCommentsPostId');
    expect(source).toContain('requestedReplyToId');
    expect(source).toContain('restoredCommentContextRef');
    expect(source).toContain('<PostComments');
    expect(source).toContain('presentation="inline"');
    expect(source).toContain('contentHeader={(');
    expect(source).toContain('commentsRef.current?.scrollToComments()');
    expect(source).toContain('router.setParams({ comments: undefined, replyTo: undefined }');
    expect(source).toContain('Comments become available when this post is public.');
    expect(source).toContain('Comments are unavailable while this post is archived.');
    expect(source).not.toContain('<CommentsSheet');
    expect(source).not.toContain('<ScrollView');
  });

  it('routes text-card Comment actions to the attached thread and keeps media on the sheet', () => {
    const homeSource = readFileSync('components/home-dashboard.tsx', 'utf8');
    const profileFeedSource = readFileSync('components/profile-media-feed.tsx', 'utf8');

    expect(homeSource).toContain("if (getHomeFeedCardOpenTarget(card) === 'post')");
    expect(homeSource).toContain('openCard(card, { comments: true })');
    expect(profileFeedSource).toContain("item.previewKind === 'text' && item.sourceType !== 'generation'");
    expect(profileFeedSource).toContain('openItem(item, { comments: true })');
    expect(profileFeedSource).toContain('openItem(activeItem, { comments: true })');
    expect(homeSource).toContain('<CommentsSheet');
    expect(profileFeedSource).toContain('<CommentsSheet');
  });

  it('consumes comment and reply return params in the immersive viewer', () => {
    const source = readFileSync('app/viewer.tsx', 'utf8');

    expect(source).toContain('requestedCommentsPostId = normalizeParam(params.comments)');
    expect(source).toContain('requestedReplyToId = normalizeParam(params.replyTo)');
    expect(source).toContain('setCommentsReplyToId(requestedReplyToId)');
    expect(source).toContain('setCommentsOpenItemId(target.id)');
    expect(source).toContain('router.setParams({ comments: undefined, replyTo: undefined }');
  });

  it('restores the originating home-feed discussion after sign-in', () => {
    const source = readFileSync('components/home-dashboard.tsx', 'utf8');

    expect(source).toContain('useLocalSearchParams');
    expect(source).toContain('setCommentsReplyToId(requestedReplyToId)');
    expect(source).toContain('setCommentsItem(target)');
    expect(source).toContain('authReturnTo="/(tabs)/index"');
  });

  it('updates viewer comment counts locally instead of reranking the source feed', () => {
    const source = readFileSync('app/viewer.tsx', 'utf8');
    const commentsStart = source.indexOf('<CommentsSheet');
    const commentsEnd = source.indexOf('<UnlockRemixPrompt', commentsStart);
    const commentsSource = source.slice(commentsStart, commentsEnd);

    expect(commentsSource).toContain('applyCommentCountToSourceData');
    expect(commentsSource).not.toContain('sourceQuery.refetch');
  });
});
