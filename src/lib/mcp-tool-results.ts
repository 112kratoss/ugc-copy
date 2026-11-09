import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * The shape of every answer the MCP tools give.
 *
 * Each result carries `structuredContent` for clients that read it and a short text block for
 * the ones that do not, and stays under a character cap so a list that grew would page rather
 * than flood the agent's context. A failure is a tool result too, never a protocol error: it
 * sets `isError`, names a stable `code` the agent can branch on, and says in words what to do
 * next. A protocol error would hide the code behind a generic "tool failed".
 */

export const MCP_RESULT_CHARACTER_CAP = 100_000;

/** The codes a tool answer can fail with. Stable: agents and their skills branch on them. */
export const MCP_ERROR_CODES = {
  /** The run's price is not the price the agent confirmed; quote again and confirm the new one. */
  COST_CHANGED: 'COST_CHANGED',
  /** The creator's balance does not cover the run. Says the balance and the shortfall, never a purchase link. */
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  /** The creator's own limit for this action is spent; wait `retry_after_seconds`. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** No such creation of this creator's, no such post the agent may see, or no such model. */
  NOT_FOUND: 'NOT_FOUND',
  /** The creation or the post exists but is another creator's; only its owner may publish or delete it. */
  NOT_OWNER: 'NOT_OWNER',
  /** The creation has not succeeded yet (or has no media), so it cannot be published; wait for get_generation. */
  NOT_READY: 'NOT_READY',
  /** The catalog, the provider or a read is unavailable right now; try again shortly. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** The arguments do not describe a run or a request the service takes; `field_errors` says which. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The token's identity could not be read; the client should refresh its token. */
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES] | (string & {});

export type McpStructuredContent = Record<string, unknown>;

const TRUNCATION_NOTE = '… [truncated: the result was longer than the MCP server returns; ask for a smaller page]';

function truncateText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - TRUNCATION_NOTE.length))}${TRUNCATION_NOTE}`;
}

/**
 * Holds a result under the cap: the text is cut with a note, and a structured half whose JSON
 * would exceed the cap is replaced by a marker that says so, since a half-serialized object
 * helps nobody. Lists page before they get here; the cap is the guard, not the design.
 */
export function capToolResult(result: CallToolResult, cap = MCP_RESULT_CHARACTER_CAP): CallToolResult {
  const content = result.content.map((block) => (
    block.type === 'text' ? { ...block, text: truncateText(block.text, cap) } : block
  ));
  let structuredContent = result.structuredContent;
  if (structuredContent && JSON.stringify(structuredContent).length > cap) {
    structuredContent = {
      truncated: true,
      note: 'The structured result was longer than the MCP server returns. Ask for a smaller page or fewer fields.',
    };
  }
  return { ...result, content, ...(structuredContent ? { structuredContent } : {}) };
}

/** A successful answer: what happened in a sentence or two, and the same facts as data. */
export function toolSuccess(text: string, structuredContent: McpStructuredContent): CallToolResult {
  return capToolResult({
    content: [{ type: 'text', text }],
    structuredContent,
  });
}

/**
 * A failed answer: a stable code, the reason, and what to do next, in words and as data. The
 * details ride beside the code (`retry_after_seconds`, `field_errors`, a fresh quote, …).
 */
export function toolFailure(
  code: McpErrorCode,
  message: string,
  details: McpStructuredContent = {},
): CallToolResult {
  return capToolResult({
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...details } },
  });
}

/** Whether a result is a failure, and its code when it is. */
export function toolFailureCode(result: CallToolResult): string | null {
  if (!result.isError) return null;
  const error = (result.structuredContent as Record<string, unknown> | undefined)?.error;
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}
