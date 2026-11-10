/**
 * The posting-only server's tools as its public page lists them (`/developers/mcp/posting`): a
 * line a person reads, and whether the tool only reads. Kept apart from `mcp-server-service.ts`,
 * which is server-only code the page must not pull in; `mcp-server-service.test.ts` holds this
 * list to `MCP_POSTS_TOOL_NAMES` and each `readOnly` to the tool's own annotation.
 */
export const MCP_POSTS_TOOL_SUMMARIES: ReadonlyArray<{ name: string; readOnly: boolean; summary: string }> = [
  {
    name: 'upload_input',
    readOnly: false,
    summary: 'Stages a picture or a video for a post, from a public link or from a file the agent sent. The staged copy is kept about two hours.',
  },
  {
    name: 'request_upload',
    readOnly: false,
    summary: 'Gives an agent that can run commands a signed address to send one file from your computer to staging.',
  },
  {
    name: 'list_creations',
    readOnly: true,
    summary: 'Lists what you have made on Magic Booklet, newest first, and whether each is already posted.',
  },
  {
    name: 'publish_post',
    readOnly: false,
    summary: 'Publishes a post: staged media, a text post, or one of your finished creations, public or private, with prompts or guides attached if you ask.',
  },
  {
    name: 'get_post',
    readOnly: true,
    summary: 'Reads one post: its state, its link and its counts. Yours in any state, anyone’s while it is live.',
  },
  {
    name: 'delete_post',
    readOnly: false,
    summary: 'Deletes one of your own posts, after you confirm.',
  },
];
