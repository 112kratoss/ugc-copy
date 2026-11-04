import type { GenerationModelOperationalConfig } from '@/lib/generation-model-runtime';

/**
 * The code build as it stood before release 2026-11-05-kling-3-image-orientation
 * (kling-3-image-orientation-manifest.test.ts; the re-read in
 * docs/model-api-references/kling-3.0/kling-3.0/kling-3.0-motion-control.md). A release test
 * written before it holds its entries to the code build of its day, so it reads today's build
 * through this and compares like with like. The release gives Kling 3.0 motion the rule Kling
 * 2.6's carries: image orientation takes a clip of at most 10 seconds.
 */

type Rule = Record<string, unknown>;

/** The image-orientation cap: a forbidden combination of `characterOrientation: image` and a duration. */
export function isImageOrientationCap(rule: Rule): boolean {
  return rule.type === 'forbidden-combination'
    && Array.isArray(rule.conditions)
    && (rule.conditions as Rule[]).some((condition) => condition.key === 'characterOrientation' && condition.value === 'image');
}

/** A model's operational config from today's build, as the build before this release made it. */
export function operationBeforeKling3ImageOrientation<T extends GenerationModelOperationalConfig>(current: T): T {
  if (current.modelId !== 'kling-3.0') return current;
  const rules = current.validationConfig.rules as Rule[];
  return {
    ...current,
    validationConfig: { ...current.validationConfig, rules: rules.filter((rule) => !isImageOrientationCap(rule)) },
  };
}
