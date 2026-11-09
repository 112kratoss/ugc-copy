/**
 * The picture a finished image run's `get_generation` answer carries inline, for the clients
 * that draw an `image` content block (Claude Code, Claude.ai): the existing preview asset,
 * fetched here from its signed URL, when it is a picture of at most a megabyte. Anything else
 * (a larger preview, a clip's poster that is not a picture, a URL that fails, a slow host)
 * leaves the answer as it was: the block is a courtesy, never a reason for a result to fail or
 * wait long.
 *
 * The block's bytes travel base64 in the result beside the text and the structured content; the
 * server's character cap (`mcp-tool-results.ts`) holds those two, and this cap holds the picture.
 */

export const MCP_IMAGE_BLOCK_MAX_BYTES = 1024 * 1024;
export const MCP_IMAGE_BLOCK_FETCH_TIMEOUT_MS = 5_000;

export type McpImageContentBlock = { type: 'image'; data: string; mimeType: string };

export async function fetchImageContentBlock(
  url: string,
  {
    fetchImpl = fetch,
    maxBytes = MCP_IMAGE_BLOCK_MAX_BYTES,
    timeoutMs = MCP_IMAGE_BLOCK_FETCH_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<McpImageContentBlock | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!response.ok) return null;
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('image/')) return null;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    if (!response.body) return null;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (received === 0) return null;
    return { type: 'image', data: Buffer.concat(chunks).toString('base64'), mimeType };
  } catch {
    return null;
  }
}
