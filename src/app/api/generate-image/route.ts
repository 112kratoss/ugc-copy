import {
  getImageGenerationForRoute,
  postImageGenerationForRoute,
} from '@/lib/image-generation-route-service';
import { createGenerationRouteHandlers } from '@/lib/generation-route-adapter-service';

export const { GET, POST } = createGenerationRouteHandlers({
  getGenerationForRoute: getImageGenerationForRoute,
  postGenerationForRoute: postImageGenerationForRoute,
});
