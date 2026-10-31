import { NextRequest } from 'next/server';
import { getApiRequestId } from '@/lib/api-cache';
import { postPromptEnhancementRouteResponse } from '@/lib/prompt-enhancement-route-adapter-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';

export async function POST(request: NextRequest) {
    return withProviderFetchRequestId(getApiRequestId(request), async () => (
        postPromptEnhancementRouteResponse({ request })
    ));
}
