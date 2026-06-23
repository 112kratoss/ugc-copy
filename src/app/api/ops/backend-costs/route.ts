import { collectBackendCostReport } from '@/lib/backend-cost-report';
import { createProtectedOpsRouteHandlers } from '@/lib/ops-route-adapter-service';

export const runtime = 'nodejs';

export const { GET } = createProtectedOpsRouteHandlers({
  collect: collectBackendCostReport,
  failureLogMessage: 'backend_cost_report_failed',
  failureResponseError: 'Failed to collect backend cost report.',
});
