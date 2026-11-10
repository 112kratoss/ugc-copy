import { createMcpRouteHandlers } from '@/lib/mcp-route-adapter-service';

export const runtime = 'nodejs';
// The composer route's own budget, so a publish from uploads is not cut off with its files
// claimed and no post: `MCP_ROUTE_MAX_DURATION_SECONDS` in `mcp-server-service.ts` says why.
export const maxDuration = 300;

export const { GET, POST, DELETE } = createMcpRouteHandlers();
