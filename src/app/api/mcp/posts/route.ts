import { createMcpRouteHandlers } from '@/lib/mcp-route-adapter-service';

export const runtime = 'nodejs';
// The composer route's own budget, as on /api/mcp: a publish from uploads must not be cut off
// with its files claimed and no post (`MCP_ROUTE_MAX_DURATION_SECONDS` in `mcp-server-service.ts`).
export const maxDuration = 300;

// The posting-only server (`mcp-surfaces.ts`): the same admission and the same tools' code as
// /api/mcp, with no tool that starts a run or spends a credit.
export const { GET, POST, DELETE } = createMcpRouteHandlers({ surface: 'posts' });
