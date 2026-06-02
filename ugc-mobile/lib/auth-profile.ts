import type { MagicbookletApiClient } from './api-client';

type ProfileApi = Pick<MagicbookletApiClient, 'getProfile'>;

export async function getProfileCreditsOrNull(
  api: ProfileApi,
  warn: (message: string, error: unknown) => void = console.warn
) {
  try {
    const profile = await api.getProfile();
    return profile.credits ?? null;
  } catch (error) {
    warn('Failed to refresh profile after auth', error);
    return null;
  }
}
