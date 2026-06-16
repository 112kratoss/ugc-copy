export function setGradleCleartextPlaceholders(contents: string): string;

export function setManifestCleartextPlaceholder<TManifest extends {
  manifest?: {
    application?: Array<{
      $?: Record<string, string>;
    }>;
  };
}>(androidManifest: TManifest): TManifest;
