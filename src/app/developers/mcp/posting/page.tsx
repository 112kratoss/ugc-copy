import type { Metadata } from 'next';

import { MCP_CLIENT_IDS, MCP_POSTS_PAGE_PATH } from '@/lib/mcp-client-directory';
import { createMetadata } from '@/lib/seo';

import PostingConnectorGuide from './PostingConnectorGuide';

export const metadata: Metadata = createMetadata({
  title: 'Post to Magic Booklet from Claude',
  description:
    'The Magic Booklet posting connector lets Claude publish to your profile: pictures and videos you made elsewhere, text posts, and prompts, guides or skills you share. It creates no media and spends no credits.',
  path: MCP_POSTS_PAGE_PATH,
  keywords: ['Magic Booklet connector', 'Magic Booklet Claude connector', 'post to Magic Booklet from Claude'],
});

/**
 * `/developers/mcp/posting`: the documentation of the posting-only MCP server (`mcp-surfaces.ts`),
 * which is what its listing in Claude's connectors directory links to. Public and static.
 */
export default function PostingConnectorPage() {
  return <PostingConnectorGuide claudeClientId={MCP_CLIENT_IDS.claude} />;
}
