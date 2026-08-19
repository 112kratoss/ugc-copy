import { createAdminUserSanctionRouteHandlers } from '@/lib/admin-user-sanction-route-adapter-service';

export const runtime = 'nodejs';

export const { POST } = createAdminUserSanctionRouteHandlers();
