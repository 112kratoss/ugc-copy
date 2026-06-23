import { collectBackendOpsDashboard } from '@/lib/backend-ops-dashboard';
import { createProtectedOpsRouteHandlers } from '@/lib/ops-route-adapter-service';

export const runtime = 'nodejs';

export const { GET } = createProtectedOpsRouteHandlers({
  collect: collectBackendOpsDashboard,
  failureLogMessage: 'backend_dashboard_failed',
  failureResponseError: 'Failed to collect backend dashboard.',
});
