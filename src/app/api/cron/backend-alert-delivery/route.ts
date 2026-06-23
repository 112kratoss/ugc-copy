import { runBackendAlertDeliveryJob } from '@/lib/backend-job-executions';
import { createBackendJobTriggerRouteHandlers } from '@/lib/backend-job-trigger-route-adapter-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const { GET } = createBackendJobTriggerRouteHandlers({
  failureMessage: 'Failed to deliver backend alerts.',
  runJob: runBackendAlertDeliveryJob,
});
