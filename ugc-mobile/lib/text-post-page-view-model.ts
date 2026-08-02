import { formatRelativeTime } from './home-view-model';
import type { ImmersivePreviewItem } from './immersive-preview-view-model';

export interface TextPostPageContent {
  handle: string;
  timeLabel: string;
  flairLabel: string;
  title: string;
  body: string;
  commentLabel: string;
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The reading content of a text post page.
 *
 * `showcaseToImmersiveItem` falls back to `title = item.title || prompt ||
 * displayText`, so an untitled post arrives with its title and its body set to
 * the same paragraph. Printing both would show it twice — once at heading size,
 * once at body size — so the body yields when it only repeats the title.
 */
export function buildTextPostPage(item: ImmersivePreviewItem, now = new Date()): TextPostPageContent {
  const title = item.title.trim();
  const body = item.displayText.trim();
  const commentCount = Math.max(0, item.commentCount);

  return {
    handle: item.creatorLabel,
    timeLabel: item.createdAt ? formatRelativeTime(item.createdAt, now) : '',
    flairLabel: item.badge,
    title,
    body: normalize(body) === normalize(title) ? '' : body,
    commentLabel: commentCount === 0
      ? 'No comments yet'
      : `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`,
  };
}
