import { Redirect, useLocalSearchParams } from 'expo-router';

import { INVITE_SHARE_QUERY_PARAM, normalizeInviteShareCode } from '@/lib/invite-share-link/invite-share-link';

/**
 * Shared post links land here without declaring their kind, so they route
 * through /post/[id], which reads the post and keeps prose on its own page
 * while redirecting media into the immersive reel. A shared link's `s` (the
 * surface it was shared from) goes with it: the post page records the visit.
 * So does its `r`, the sharer's invite (`lib/invite-share-link/`), which the
 * post page records for someone with no account yet.
 */
export default function ShowcaseDetailScreen() {
  const { id, s, r, page, section } = useLocalSearchParams<{ id: string; s?: string; r?: string; page?: string; section?: string }>();
  const postId = Array.isArray(id) ? id[0] : id;
  const shareSurface = Array.isArray(s) ? s[0] : s;
  const inviteCode = normalizeInviteShareCode(Array.isArray(r) ? r[0] : r);
  const requestedPage = Array.isArray(page) ? page[0] : page;
  const requestedSection = Array.isArray(section) ? section[0] : section;

  if (!postId) {
    return <Redirect href="/(tabs)/showcase" />;
  }

  const params: string[] = [];
  if (shareSurface) params.push(`s=${encodeURIComponent(shareSurface)}`);
  if (inviteCode) params.push(`${INVITE_SHARE_QUERY_PARAM}=${inviteCode}`);
  // A link that asks for the post's Details page at one of its sections (a
  // "Recipe unlocked" alert leads to the recipe, B-F9) keeps asking: the post
  // page reads `page` and `section`.
  if (requestedPage === 'details') {
    params.push('page=details');
    if (requestedSection) params.push(`section=${encodeURIComponent(requestedSection)}`);
  }
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return <Redirect href={`/post/${encodeURIComponent(postId)}${query}` as never} />;
}
