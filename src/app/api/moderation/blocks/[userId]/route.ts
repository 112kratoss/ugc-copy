import { createUserBlockRouteHandlers } from '@/lib/moderation-route-adapter-service';

export const { DELETE, POST } = createUserBlockRouteHandlers();
