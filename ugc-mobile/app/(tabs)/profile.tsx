import { useLocalSearchParams } from 'expo-router';

import { ProfileDashboard } from '@/components/profile-dashboard';
import { useAuth } from '@/lib/auth';
import type { ProfileMediaTab } from '@/lib/profile-view-model';

type ProfileRouteParams = {
  tab?: string | string[];
  postId?: string | string[];
};

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function normalizeProfileTab(value: string | string[] | undefined): ProfileMediaTab {
  const tab = normalizeParam(value).toLowerCase();
  if (tab === 'posts') return 'Posts';
  if (tab === 'creations') return 'Creations';
  return 'Saved';
}

export default function ProfileScreen() {
  const { isLoading } = useAuth();
  const params = useLocalSearchParams<ProfileRouteParams>();
  const initialTab = normalizeProfileTab(params.tab);
  const highlightedPostId = normalizeParam(params.postId) || null;

  if (isLoading) {
    return null;
  }

  return <ProfileDashboard initialTab={initialTab} highlightedPostId={highlightedPostId} />;
}
