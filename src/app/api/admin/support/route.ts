import { createAdminSupportRouteHandlers } from '@/lib/admin-support-route-adapter-service';

export const runtime = 'nodejs';

export const { GET, POST } = createAdminSupportRouteHandlers();
