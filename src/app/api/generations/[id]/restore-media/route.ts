import { NextRequest } from 'next/server';

import {
  postGenerationRestoreMediaRouteResponse,
  type GenerationRestoreMediaRouteContext,
} from '@/lib/generation-restore-media-route-adapter-service';

export async function POST(request: NextRequest, context: GenerationRestoreMediaRouteContext) {
  return postGenerationRestoreMediaRouteResponse({ context, request });
}
