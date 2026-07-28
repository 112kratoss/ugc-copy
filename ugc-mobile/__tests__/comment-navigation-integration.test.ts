import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('comment authentication return integration', () => {
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
