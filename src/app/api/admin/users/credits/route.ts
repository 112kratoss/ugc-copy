import { createAdminCreditRouteHandlers } from '@/lib/admin-credit-route-adapter-service';

export const runtime = 'nodejs';

export const { POST } = createAdminCreditRouteHandlers();
