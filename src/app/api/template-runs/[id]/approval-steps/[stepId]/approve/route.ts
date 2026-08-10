import { after } from 'next/server';

import { createTemplateRunStepApprovalRouteHandlers } from '@/lib/media-template-route-adapter-service';

export const { POST } = createTemplateRunStepApprovalRouteHandlers({ scheduleAfter: after });
