import { createAdminContactTriageRouteHandlers } from '@/lib/admin-content-moderation-route-adapter-service';

export const runtime = 'nodejs';

export const { POST } = createAdminContactTriageRouteHandlers();
