import { postShowcaseFeedFeedbackUndoRouteResponse } from '@/lib/showcase-feed-feedback-undo-route-adapter-service';

export async function POST(request: Request) {
  return postShowcaseFeedFeedbackUndoRouteResponse({ request });
}
