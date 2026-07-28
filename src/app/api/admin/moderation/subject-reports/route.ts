import { createAdminSubjectReportRouteHandlers } from '@/lib/admin-moderation-route-adapter-service';

export const runtime = 'nodejs';

export const { POST } = createAdminSubjectReportRouteHandlers();
