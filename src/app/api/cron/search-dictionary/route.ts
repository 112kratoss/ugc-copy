import { runSearchDictionaryBackendJob } from '@/lib/backend-job-executions';
import { createBackendJobTriggerRouteHandlers } from '@/lib/backend-job-trigger-route-adapter-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const { GET } = createBackendJobTriggerRouteHandlers({
  failureMessage: 'Failed to rebuild the search dictionary.',
  runJob: runSearchDictionaryBackendJob,
});
