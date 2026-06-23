import { createProfileFollowRouteHandlers } from '@/lib/profile-follow-route-adapter-service';

export const runtime = 'nodejs';
export const { GET, POST } = createProfileFollowRouteHandlers();
