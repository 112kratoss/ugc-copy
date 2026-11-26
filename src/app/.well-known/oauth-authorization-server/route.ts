import {
  createAuthorizationServerMetadataOptionsResponse,
  createAuthorizationServerMetadataResponse,
} from '@/lib/oauth-authorization-server-metadata';

// RFC 8414 metadata of the app's own authorization server for MCP, whose issuer is this origin.
// Served per request, as the protected-resource documents are, so a build cannot bake in the
// answer of a deployment whose flag differs. The proxy's matcher does not cover /.well-known.
export const dynamic = 'force-dynamic';

export function GET() {
  return createAuthorizationServerMetadataResponse();
}

export function OPTIONS() {
  return createAuthorizationServerMetadataOptionsResponse();
}
