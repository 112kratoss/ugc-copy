import {
  createProtectedResourceMetadataOptionsResponse,
  createProtectedResourceMetadataResponse,
} from '@/lib/oauth-protected-resource-metadata';

// The path-aware protected-resource document for /api/mcp/posts, the posting-only server
// (RFC 9728 section 3): the URL that route's 401 names in its WWW-Authenticate challenge. Its
// `resource` is the posting server's own URL, which is what a client that connected to that URL
// checks the document against.
export function GET() {
  return createProtectedResourceMetadataResponse({ surface: 'posts' });
}

export function OPTIONS() {
  return createProtectedResourceMetadataOptionsResponse();
}
