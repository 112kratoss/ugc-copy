import { createAgentOAuthTokenHandlers } from '@/lib/agent-oauth-route-adapter-service';

export const runtime = 'nodejs';

// The token endpoint of the app's own OAuth server for MCP: an authorization code, or a refresh
// token, for an opaque access token and the next refresh token.
export const { POST, OPTIONS } = createAgentOAuthTokenHandlers();
