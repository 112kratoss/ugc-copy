import { createMcpRouteHandlers } from '@/lib/mcp-route-adapter-service';

export const runtime = 'nodejs';
// The composer route's own budget (`/api/posts`): publish_post from uploads runs the same create,
// which downloads and previews each staged file before the post's row exists. Cut off at 60
// seconds, a post of several clips would leave its files claimed and no post, and every repeat
// would be told to wait for a publish that had died. An MCP client gives up on a request after
// about 60 seconds of its own, so the waits and the upload caps stay sized for that; past it the
// publish finishes here, and the agent's repeat finds the post by its derived id.
// `MCP_ROUTE_MAX_DURATION_SECONDS` in `mcp-server-service.ts` is this number.
export const maxDuration = 300;

export const { GET, POST, DELETE } = createMcpRouteHandlers();
