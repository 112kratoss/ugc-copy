import {
  getMotionGenerationForRoute,
} from '@/lib/motion-generation-route-service';
import { createGenerationRouteHandlers } from '@/lib/generation-route-adapter-service';

export const { GET, POST } = createGenerationRouteHandlers({
  getGenerationForRoute: getMotionGenerationForRoute,
});
