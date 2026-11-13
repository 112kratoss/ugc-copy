/**
 * Whether a tool's name is this app's own. A post made in the app records the
 * app as its tool (`source_tool: 'magicbooklet'`), and "Made with" the app,
 * read inside the app, says nothing: only an outside tool is worth naming.
 * Read as the web's `isAppSourceToolLabel` reads it (`src/lib/source-tools.ts`):
 * case, spaces and hyphens ignored. The app's old name counts too, as the
 * web's agent guard counts it (`src/lib/agent-upload-publish-request.ts`).
 */
const APP_TOOL_NAMES = new Set(['magicbooklet', 'emptybooklet']);

export function isAppSourceToolLabel(label: string | null | undefined): boolean {
  return APP_TOOL_NAMES.has((label ?? '').replace(/[\s-]+/g, '').toLowerCase());
}
