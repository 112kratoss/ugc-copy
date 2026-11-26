import { createAgentOAuthAuthorizeHandlers } from '@/lib/agent-oauth-route-adapter-service';

export const runtime = 'nodejs';

// The authorization endpoint of the app's own OAuth server for MCP
// (docs/plans/agent-token-broker-plan-2026-11-26.md): checks the request, stores it, and sends
// the browser to the consent page. It answers 404 until MCP_AUTHORIZATION_SERVER switches it on.
export const { GET } = createAgentOAuthAuthorizeHandlers();
