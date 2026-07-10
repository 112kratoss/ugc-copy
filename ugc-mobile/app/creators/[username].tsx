import { Redirect, useLocalSearchParams } from 'expo-router';

import { CreatorProfileScreen } from '@/components/creator-profile-screen';
import { normalizeCreatorProfileTab } from '@/lib/creator-profile-view-model';

type CreatorRouteParams = {
  username?: string | string[];
  tab?: string | string[];
};

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function CreatorProfileRoute() {
  const params = useLocalSearchParams<CreatorRouteParams>();
  const username = normalizeParam(params.username);

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
