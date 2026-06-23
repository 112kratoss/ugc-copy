import { createBackendJobsRouteHandlers } from '@/lib/backend-jobs-route-adapter-service';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const { GET } = createBackendJobsRouteHandlers();
