import { createAdminSessionRouteHandlers } from '@/lib/admin-auth-route-adapter-service';

export const runtime = 'nodejs';

export const { POST, DELETE } = createAdminSessionRouteHandlers();
