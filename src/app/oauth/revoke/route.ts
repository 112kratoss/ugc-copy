import { createAgentOAuthRevokeHandlers } from '@/lib/agent-oauth-route-adapter-service';

export const runtime = 'nodejs';

// RFC 7009: a client ends the grant one of its own tokens belongs to.
export const { POST, OPTIONS } = createAgentOAuthRevokeHandlers();
