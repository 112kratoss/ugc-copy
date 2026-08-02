import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Shared post links land here without declaring their kind, so they route
 * through /post/[id], which reads the post and keeps prose on its own page
 * while redirecting media into the immersive reel.
 */
export default function ShowcaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const postId = Array.isArray(id) ? id[0] : id;

  if (!postId) {
    return <Redirect href="/(tabs)/showcase" />;
  }

  return <Redirect href={`/post/${postId}` as never} />;
}
