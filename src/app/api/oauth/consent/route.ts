import { createAgentOAuthConsentHandlers } from '@/lib/agent-oauth-route-adapter-service';

export const runtime = 'nodejs';

// The consent page's answer to a request of the app's own authorization server.
export const { POST } = createAgentOAuthConsentHandlers();
