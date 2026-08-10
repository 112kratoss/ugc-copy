import { after } from 'next/server';

import { createTemplateRunStartRouteHandlers } from '@/lib/media-template-route-adapter-service';

export const { POST } = createTemplateRunStartRouteHandlers({ scheduleAfter: after });
