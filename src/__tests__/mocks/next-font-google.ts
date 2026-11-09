/**
 * `next/font/google` under vitest. Next's compiler replaces each loader call at build time and the
 * package's runtime module exports nothing, so a component that imports a face
 * (`src/lib/display-font.ts`, `src/lib/handwriting-font.ts`) would throw "is not a function" in a test. Each loader here answers
 * what Next's would, a class and a style named for its family, so a test can see which face an
 * element was given (`font-<family>`).
 */
type FontOptions = { weight?: string | string[]; variable?: string };

function loader(family: string) {
  const slug = family.toLowerCase().replace(/\s+/g, '-');
  return (options: FontOptions = {}) => ({
    className: `font-${slug}`,
    variable: options.variable ? `variable-${slug}` : undefined,
    style: {
      fontFamily: `'${family}'`,
      ...(typeof options.weight === 'string' ? { fontWeight: Number(options.weight) } : {}),
      fontStyle: 'normal',
    },
  });
}

export const Geist = loader('Geist');
export const Bricolage_Grotesque = loader('Bricolage Grotesque');
export const Caveat = loader('Caveat');
