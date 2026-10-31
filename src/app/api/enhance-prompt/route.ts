import { NextRequest } from 'next/server';
import { getApiRequestId } from '@/lib/api-cache';
import { postPromptEnhancementRouteResponse } from '@/lib/prompt-enhancement-route-adapter-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';

// Kie may take PROMPT_ENHANCER_MAX_DEADLINE_MS (55 s) after the route's own checks.
export const maxDuration = 90;
export async function POST(request: NextRequest) {
    return withProviderFetchRequestId(getApiRequestId(request), async () => (
        postPromptEnhancementRouteResponse({ request })
    ));
}
