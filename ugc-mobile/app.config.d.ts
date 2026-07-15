interface ExpoAutolinkingConfig {
  exclude?: string[];
}

interface ExpoConfigLike {
  autolinking?: ExpoAutolinkingConfig;
  [key: string]: unknown;
}

export function withBuildProfileAutolinking<TConfig extends ExpoConfigLike>(
  config: TConfig,
  includeDevClient: boolean
): TConfig & { autolinking?: ExpoAutolinkingConfig };
