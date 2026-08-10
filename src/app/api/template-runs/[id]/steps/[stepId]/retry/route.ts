import { after } from 'next/server';

import { createTemplateRunStepRetryRouteHandlers } from '@/lib/media-template-route-adapter-service';

export const { POST } = createTemplateRunStepRetryRouteHandlers({ scheduleAfter: after });
