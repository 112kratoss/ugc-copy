import {
  createProtectedResourceMetadataOptionsResponse,
  createProtectedResourceMetadataResponse,
} from '@/lib/oauth-protected-resource-metadata';

// The origin's root protected-resource document (RFC 9728). It names the MCP route as the
// resource, as the path-aware document under ./api/mcp does, for clients that try the root
// well-known URL first. The proxy's matcher does not cover /.well-known. Served per request
// (the CDN caches it by its headers) rather than prerendered, so a build without the public
// env cannot bake its "not configured" answer in.
export function GET() {
  return createProtectedResourceMetadataResponse();
}

export function OPTIONS() {
  return createProtectedResourceMetadataOptionsResponse();
}
