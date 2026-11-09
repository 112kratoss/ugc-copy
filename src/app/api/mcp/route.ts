import { createMcpRouteHandlers } from '@/lib/mcp-route-adapter-service';

export const runtime = 'nodejs';
// A tool call may wait up to 45 seconds for a run (get_generation) or start one through the
// provider; a POST never streams, so the budget is the one answer's.
export const maxDuration = 60;

export const { GET, POST, DELETE } = createMcpRouteHandlers();
