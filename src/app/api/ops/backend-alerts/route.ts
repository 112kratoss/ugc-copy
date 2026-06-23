import { collectBackendAlerts } from '@/lib/backend-alerts';
import { createProtectedOpsRouteHandlers } from '@/lib/ops-route-adapter-service';

export const runtime = 'nodejs';

export const { GET } = createProtectedOpsRouteHandlers({
  collect: collectBackendAlerts,
  failureLogMessage: 'backend_alerts_failed',
  failureResponseError: 'Failed to collect backend alerts.',
});
