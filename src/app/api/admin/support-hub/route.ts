import { createAdminSupportHubRouteHandlers } from '@/lib/admin-support-hub-route-adapter-service';

export const runtime = 'nodejs';
// Publishing creates the post through the composer, and an announced update's
// alerts are sent behind the response (40 s budget; Continue sending resumes).
export const maxDuration = 60;

export const { GET, POST } = createAdminSupportHubRouteHandlers();
