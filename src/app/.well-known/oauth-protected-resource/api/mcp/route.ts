import {
  createProtectedResourceMetadataOptionsResponse,
  createProtectedResourceMetadataResponse,
} from '@/lib/oauth-protected-resource-metadata';

// The path-aware protected-resource document for /api/mcp (RFC 9728 section 3): the URL the
// MCP route's 401 names in its WWW-Authenticate challenge. Served per request, as the root
// document is.
export function GET() {
  return createProtectedResourceMetadataResponse();
}

export function OPTIONS() {
  return createProtectedResourceMetadataOptionsResponse();
}
