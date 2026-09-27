import { useLocalSearchParams } from 'expo-router';

import { ProfileDashboard } from '@/components/profile-dashboard';
import { useAuth } from '@/lib/auth';
import { DEFAULT_PROFILE_MEDIA_TAB, type ProfileMediaTab } from '@/lib/profile-view-model';

type ProfileRouteParams = {
  tab?: string | string[];
  postId?: string | string[];
  /** Set by the composer when `postId` was just published. */
  published?: string | string[];
};

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function normalizeProfileTab(value: string | string[] | undefined): ProfileMediaTab {
  const tab = normalizeParam(value).toLowerCase();
  if (tab === 'posts') return 'Posts';
  if (tab === 'creations') return 'Creations';
  if (tab === 'saved') return 'Saved';
  return DEFAULT_PROFILE_MEDIA_TAB;
}

export default function ProfileScreen() {
  const { isLoading } = useAuth();
  const params = useLocalSearchParams<ProfileRouteParams>();
  const initialTab = normalizeProfileTab(params.tab);
  const highlightedPostId = normalizeParam(params.postId) || null;
  const justPublishedPostId = normalizeParam(params.published) === '1' ? highlightedPostId : null;

  if (isLoading) {
    return null;
  }

  return (
    <ProfileDashboard
      initialTab={initialTab}
      highlightedPostId={highlightedPostId}
      justPublishedPostId={justPublishedPostId}
    />
  );
}
