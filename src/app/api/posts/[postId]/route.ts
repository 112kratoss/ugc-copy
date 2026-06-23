import { createOwnerPostRouteHandlers } from '@/lib/owner-post-route-adapter-service';

export const { DELETE, GET, PATCH, PUT } = createOwnerPostRouteHandlers();
