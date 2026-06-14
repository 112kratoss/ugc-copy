import { Redirect, useLocalSearchParams } from 'expo-router';

import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { normalizeParam, normalizeViewerSource } from '@/lib/immersive-preview-source-data';

export default function MediaFeedRedirectScreen() {
  const params = useLocalSearchParams<{
    source?: string | string[];
    initialId?: string | string[];
  }>();

  return (
    <Redirect
      href={immersiveViewerHref({
        source: normalizeViewerSource(params.source),
        initialId: normalizeParam(params.initialId),
      }) as never}
    />
  );
}
