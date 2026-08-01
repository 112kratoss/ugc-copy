import { createAdminPayoutRouteHandlers } from '@/lib/admin-payout-route-adapter-service';

export const runtime = 'nodejs';

export const { POST } = createAdminPayoutRouteHandlers();
