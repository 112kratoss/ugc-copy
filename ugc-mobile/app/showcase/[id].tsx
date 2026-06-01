import { Redirect, useLocalSearchParams } from 'expo-router';

import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';

export default function ShowcaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const postId = Array.isArray(id) ? id[0] : id;

  if (!postId) {
    return <Redirect href="/(tabs)/showcase" />;
  }

  return <Redirect href={immersiveViewerHref({ source: 'showcase-feed', initialId: postId }) as never} />;
}
