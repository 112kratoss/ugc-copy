import { runFeedEmbeddingsBackendJob } from '@/lib/backend-job-executions';
import { createBackendJobTriggerRouteHandlers } from '@/lib/backend-job-trigger-route-adapter-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

export const { GET } = createBackendJobTriggerRouteHandlers({
  failureMessage: 'Failed to embed feed posts.',
  runJob: runFeedEmbeddingsBackendJob,
});
