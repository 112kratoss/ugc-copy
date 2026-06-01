import { Redirect } from 'expo-router';

import { ProfileDashboard } from '@/components/profile-dashboard';
import { useAuth } from '@/lib/auth';

export default function ProfileScreen() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  if (!user) {
    return <Redirect href="/auth" />;
  }

  return <ProfileDashboard />;
}
