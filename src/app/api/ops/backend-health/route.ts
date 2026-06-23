import { collectBackendHealth } from '@/lib/backend-health';
import { createProtectedOpsRouteHandlers } from '@/lib/ops-route-adapter-service';

export const runtime = 'nodejs';

export const { GET } = createProtectedOpsRouteHandlers({
  collect: (client) => collectBackendHealth(client, undefined, process.env),
  failureLogMessage: 'backend_health_failed',
  failureResponseError: 'Failed to collect backend health.',
});
