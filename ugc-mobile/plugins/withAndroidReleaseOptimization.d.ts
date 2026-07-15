export type GradleProperty =
  | { type: 'property'; key: string; value: string }
  | { type: 'comment'; value: string };

export function setReleaseOptimizationProperties(properties: GradleProperty[]): GradleProperty[];
export function setReleaseProguardOptimization(buildGradle: string): string;
