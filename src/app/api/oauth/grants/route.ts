import { createAgentOAuthGrantsHandlers } from '@/lib/agent-oauth-route-adapter-service';

export const runtime = 'nodejs';

// Connected apps: the account's grants on the app's own authorization server, and Disconnect.
export const { GET, DELETE } = createAgentOAuthGrantsHandlers();
