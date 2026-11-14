import { describe, expect, it } from 'vitest';

import {
  getCommentThreadLines,
  getCommentThreadRows,
  type CommentThreadLine,
  type CommentThreadRowKind,
} from '@/lib/comments-view-model';
import type { PostComment } from '@/lib/types';

function comment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    id: 'comment-1',
    parentId: null,
    body: 'This prompt is unreal.',
    status: 'active',
    createdAt: '2026-11-14T10:00:00.000Z',
    replyCount: 0,
    author: { id: 'creator-2', username: 'batman', displayName: 'Batman', avatarUrl: null },
    likeCount: 0,
    viewerReaction: null,
    editedAt: null,
    hearted: false,
    pinned: false,
    ...overrides,
  };
}

const reply = (id: string) => comment({ id, parentId: 'comment-1' });

const NONE: CommentThreadLine = { spine: 'none', elbow: 'none' };
const STEM: CommentThreadLine = { spine: 'from-avatar', elbow: 'none' };
const PASS: CommentThreadLine = { spine: 'through', elbow: 'none' };
const REPLY_ON: CommentThreadLine = { spine: 'through', elbow: 'avatar' };
const REPLY_END: CommentThreadLine = { spine: 'none', elbow: 'avatar' };
const CONTROL_ON: CommentThreadLine = { spine: 'through', elbow: 'control' };
const CONTROL_END: CommentThreadLine = { spine: 'none', elbow: 'control' };

describe('getCommentThreadRows', () => {
  const closed = { expanded: false, replies: [], repliesLoading: false, repliesFailed: false, moreReplies: false };

  it('is the comment alone when it has no replies', () => {
    expect(getCommentThreadRows({ ...closed, comment: comment() }).map((row) => row.kind)).toEqual(['comment']);
  });

  it('ends a folded thread on its toggle', () => {
    expect(getCommentThreadRows({ ...closed, comment: comment({ replyCount: 3 }) }).map((row) => row.kind))
      .toEqual(['comment', 'replies-toggle']);
  });

  it('lists an open thread top to bottom, with a key of its own for every row', () => {
    const rows = getCommentThreadRows({
      comment: comment({ replyCount: 21 }),
      expanded: true,
      replies: [reply('reply-1'), reply('reply-2')],
      repliesLoading: false,
      repliesFailed: true,
      moreReplies: true,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      'comment', 'reply', 'reply', 'replies-error', 'load-more-replies', 'replies-toggle',
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('shows only the spinner until the first replies arrive, and the replies after', () => {
    const loading = { comment: comment({ replyCount: 2 }), expanded: true, repliesLoading: true, repliesFailed: false, moreReplies: false };
    expect(getCommentThreadRows({ ...loading, replies: [] }).map((row) => row.kind))
      .toEqual(['comment', 'replies-loading', 'replies-toggle']);
    // The reader's own reply, posted while the rest load, is shown at once.
    expect(getCommentThreadRows({ ...loading, replies: [reply('reply-mine')] }).map((row) => row.kind))
      .toEqual(['comment', 'reply', 'replies-toggle']);
  });
});

describe('getCommentThreadLines', () => {
  it('draws nothing for a comment without replies', () => {
    expect(getCommentThreadLines(['comment'])).toEqual([NONE]);
  });

  it('runs a folded thread from the avatar into its toggle ("View 3 replies")', () => {
    expect(getCommentThreadLines(['comment', 'replies-toggle'])).toEqual([STEM, CONTROL_END]);
  });

  it('branches into every reply of an open thread and ends on "Hide replies"', () => {
    expect(getCommentThreadLines(['comment', 'reply', 'reply', 'replies-toggle']))
      .toEqual([STEM, REPLY_ON, REPLY_ON, CONTROL_END]);
  });

  it('branches into Load more replies on its way to the toggle', () => {
    expect(getCommentThreadLines(['comment', 'reply', 'load-more-replies', 'replies-toggle']))
      .toEqual([STEM, REPLY_ON, CONTROL_ON, CONTROL_END]);
  });

  it('passes a spinner and a failed load without branching into them', () => {
    expect(getCommentThreadLines(['comment', 'replies-loading', 'replies-toggle'])).toEqual([STEM, PASS, CONTROL_END]);
    expect(getCommentThreadLines(['comment', 'reply', 'replies-error', 'replies-toggle']))
      .toEqual([STEM, REPLY_ON, PASS, CONTROL_END]);
  });

  it('ends on the last reply when no toggle follows, never hanging past it', () => {
    // A reply count that lags the replies shown: no toggle under them.
    expect(getCommentThreadLines(['comment', 'reply', 'reply'])).toEqual([STEM, REPLY_ON, REPLY_END]);
    expect(getCommentThreadLines(['comment', 'reply', 'replies-error'])).toEqual([STEM, REPLY_END, NONE]);
    expect(getCommentThreadLines(['comment', 'replies-loading'])).toEqual([NONE, NONE]);
  });

  /** Every thread shape the sheet can draw, up to a few rows of each part. */
  function everyThread(): CommentThreadRowKind[][] {
    const shapes: CommentThreadRowKind[][] = [];
    for (const toggle of [false, true]) {
      shapes.push(['comment', ...(toggle ? ['replies-toggle' as const] : [])]);
      shapes.push(['comment', 'replies-loading', ...(toggle ? ['replies-toggle' as const] : [])]);
      for (let replies = 0; replies <= 3; replies += 1) {
        for (const failed of [false, true]) {
          for (const more of [false, true]) {
            shapes.push([
              'comment',
              ...Array.from({ length: replies }, () => 'reply' as const),
              ...(failed ? ['replies-error' as const] : []),
              ...(more ? ['load-more-replies' as const] : []),
              ...(toggle ? ['replies-toggle' as const] : []),
            ]);
          }
        }
      }
    }
    return shapes;
  }

  it('keeps the line whole in every thread shape: no gap, no loose end, no stray branch', () => {
    for (const rows of everyThread()) {
      const lines = getCommentThreadLines(rows);
      const drawn = lines.map((line) => line.spine !== 'none' || line.elbow !== 'none');
      lines.forEach((line, index) => {
        const shape = rows.join(' > ');
        // A run down through a row's bottom lands on the next row's run or elbow.
        if (line.spine !== 'none') expect(drawn[index + 1], shape).toBe(true);
        // A piece below the comment hangs from the row above it.
        if (index > 0 && drawn[index]) expect(lines[index - 1].spine, shape).not.toBe('none');
        // Only the comment starts the line, from under its avatar.
        expect(line.spine === 'from-avatar', shape).toBe(rows[index] === 'comment' && line.spine !== 'none');
      });
      // The line, when there is one, ends on an elbow.
      const last = drawn.lastIndexOf(true);
      if (last >= 0) expect(lines[last].elbow, rows.join(' > ')).not.toBe('none');
      // A thread with a toggle always draws one: the comment's replies are there to open.
      if (rows.includes('replies-toggle')) expect(lines[0], rows.join(' > ')).toEqual(STEM);
    }
  });
});
