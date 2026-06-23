import { createMobileNotificationPreferencesRouteHandlers } from '@/lib/mobile-notification-preferences-route-adapter-service';

export const runtime = 'nodejs';
export const { GET, PATCH } = createMobileNotificationPreferencesRouteHandlers();
