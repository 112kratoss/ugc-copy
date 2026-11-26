import { createAgentOAuthAuthorizeHandlers } from '@/lib/agent-oauth-route-adapter-service';

export const runtime = 'nodejs';

// The authorization endpoint of the app's own OAuth server for MCP
// (docs/archive/agent-token-broker-plan-2026-11-26.md): checks the request, stores it, and sends
// the browser to the consent page.
export const { GET } = createAgentOAuthAuthorizeHandlers();
