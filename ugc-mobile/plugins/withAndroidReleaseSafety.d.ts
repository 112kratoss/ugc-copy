export type GradleProperty =
  | { type: 'property'; key: string; value: string }
  | { type: 'comment'; value: string };

export function setReleaseSafetyProperties(properties: GradleProperty[]): GradleProperty[];
export function setReleaseProguardSafety(buildGradle: string): string;
