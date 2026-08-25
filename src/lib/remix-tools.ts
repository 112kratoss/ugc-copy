/**
 * Which create tool a remix belongs to.
 *
 * This answers exactly one question — "if someone remixes this, which creator
 * tool opens?" — and it is the only place that should answer it. It used to be
 * answered independently in three places that drifted apart: the redirect the
 * remix endpoint emits, the target the post UI advertises, and the target a
 * bare generation reports. `ugc-ad` was the visible casualty, advertised as an
 * image remix while the redirect sent people to the video tool.
 *
 * It is deliberately NOT the same question as `normalizeCategory` in
 * remix-source-server, which asks "what kind of media is the result" — motion
 * output is a video, so that mapping answers 'video' for motion and is correct
 * to differ. Do not merge the two.
 */
export type RemixTool = 'image' | 'video' | 'motion';

const CREATE_PATH_BY_TOOL: Record<RemixTool, string> = {
  image: '/create-image',
  motion: '/create-motion',
  video: '/create-video',
};

export function resolveRemixTool(category: string | null | undefined): RemixTool {
  switch (category) {
    case 'motion':
      return 'motion';
    // 'ugc-ad' is a legacy category whose generations are videos.
    case 'ugc-ad':
    case 'video':
      return 'video';
    case 'image':
      return 'image';
    default:
      // Remixes only exist for generation-backed posts, and neither client can
      // carry the remix params through the bare /create hub — the web page takes
      // no searchParams and the mobile mapper has no tool for it. The image tool
      // is the safe landing that keeps the prefill alive.
      return 'image';
  }
}

export function remixToolCreatePath(tool: RemixTool): string {
  return CREATE_PATH_BY_TOOL[tool];
}

export function remixCreatePathForCategory(category: string | null | undefined): string {
  return remixToolCreatePath(resolveRemixTool(category));
}
