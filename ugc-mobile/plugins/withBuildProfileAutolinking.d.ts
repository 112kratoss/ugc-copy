export const DEVELOPMENT_ONLY_NATIVE_MODULES: readonly string[];

export function setAndroidBuildProfileAutolinking(contents: string): string;
export function setIosBuildProfileAutolinking(contents: string): string;
export function setPathSafeIosBundleScript<TProject>(project: TProject): TProject;
