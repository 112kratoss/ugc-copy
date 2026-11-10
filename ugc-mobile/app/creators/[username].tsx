import { Redirect, useLocalSearchParams } from 'expo-router';

import { CreatorProfileScreen } from '@/components/creator-profile-screen';
import { normalizeCreatorProfileTab } from '@/lib/creator-profile-view-model';
import { useInviteShareCapture } from '@/lib/use-invite-share-capture';

type CreatorRouteParams = {
  username?: string | string[];
  tab?: string | string[];
  /** The invite a shared profile link carries (`lib/invite-share-link/`). */
  r?: string | string[];
};

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function CreatorProfileRoute() {
  const params = useLocalSearchParams<CreatorRouteParams>();
  const username = normalizeParam(params.username);
  // A shared profile link's invite, kept for someone with no account yet, as
  // the post page keeps a shared post's.
  useInviteShareCapture(params.r, username ? `/creators/${encodeURIComponent(username)}` : null);

  if (!username) {
    return <Redirect href="/(tabs)/showcase" />;
  }

  return (
    <CreatorProfileScreen
      username={username}
      initialTab={normalizeCreatorProfileTab(params.tab)}
    />
  );
}
