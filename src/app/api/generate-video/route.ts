import {
  getVideoGenerationForRoute,
  postVideoGenerationForRoute,
} from '@/lib/video-generation-route-service';
import { createGenerationRouteHandlers } from '@/lib/generation-route-adapter-service';

export const { GET, POST } = createGenerationRouteHandlers({
  getGenerationForRoute: getVideoGenerationForRoute,
  postGenerationForRoute: postVideoGenerationForRoute,
});
