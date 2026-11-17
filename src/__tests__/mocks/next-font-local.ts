/**
 * `next/font/local` under vitest. Next's compiler replaces each loader call at build time and the
 * package's runtime module exports nothing, so a component that imports a face
 * (`src/lib/display-font.ts`, `src/lib/handwriting-font.ts`, `src/lib/geist-font.ts`) would throw "is not a function" in a test.
 * The loader here answers what Next's would, a class and a style named for the call's CSS variable
 * (`--font-display` gives `font-display`), so a test can see which face an element was given.
 */
type FontOptions = {
  variable?: string;
  src?: Array<{ weight?: string; style?: string }> | string;
};

export default function localFont(options: FontOptions = {}) {
  const slug = (options.variable ?? '--font-local').replace(/^--font-/, '');
  const sources = Array.isArray(options.src) ? options.src : [];
  const weight = sources.length === 1 ? sources[0].weight : undefined;
  return {
    className: `font-${slug}`,
    variable: options.variable ? `variable-${slug}` : undefined,
    style: {
      fontFamily: `'${slug}'`,
      ...(weight && /^\d+$/.test(weight) ? { fontWeight: Number(weight) } : {}),
      fontStyle: 'normal',
    },
  };
}
