import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Shared post links land here without declaring their kind, so they route
 * through /post/[id], which reads the post and keeps prose on its own page
 * while redirecting media into the immersive reel. A shared link's `s` (the
 * surface it was shared from) goes with it: the post page records the visit.
 */
export default function ShowcaseDetailScreen() {
  const { id, s } = useLocalSearchParams<{ id: string; s?: string }>();
  const postId = Array.isArray(id) ? id[0] : id;
  const shareSurface = Array.isArray(s) ? s[0] : s;

  if (!postId) {
    return <Redirect href="/(tabs)/showcase" />;
  }

  const query = shareSurface ? `?s=${encodeURIComponent(shareSurface)}` : '';
  return <Redirect href={`/post/${encodeURIComponent(postId)}${query}` as never} />;
}
