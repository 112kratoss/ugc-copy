/**
 * Resolve the app-level model id for a generation row, for telemetry attribution.
 *
 * `generations.model` is not a single id space. Production evidence on
 * 2026-07-25 across 79 generations:
 *
 *   generations.model            workflow_settings.model   which is the app id
 *   ---------------------------  ------------------------  ------------------
 *   nano-banana-2                nano-banana-2             both
 *   gpt-image-2                  gpt-image-2               both
 *   kling-3.0/video              kling-3.0-video           workflow_settings
 *   bytedance/seedance-2         seedance-2                workflow_settings
 *   kling-2.6/motion-control     (null)                    neither
 *
 * Image start paths persist the app id in `model`; video and motion paths
 * persist the *provider* id there and keep the app id in `workflow_settings`.
 *
 * This matters because provider telemetry is attributed with the app id at task
 * creation (`createKieTask` receives it explicitly) but was previously
 * attributed with `generation.model` at status-poll time. For video and motion
 * that splits one model's traffic across two keys, halving both denominators
 * and hiding a failing model — the exact blindness per-model rates exist to
 * remove.
 *
 * Known residual gap, deliberately not papered over: legacy motion rows carry
 * the provider id in `model` and nothing in `workflow_settings`, so they still
 * resolve to the provider id. They attribute *consistently* under that one key
 * rather than splitting, which is the property the rates actually need. New
 * motion generations persist `workflow_settings.model` and resolve correctly.
 */
export function resolveGenerationAppModelId(
  generation: { model?: string | null; workflow_settings?: unknown } | null | undefined,
): string | null {
  if (!generation) return null;

  const settings = generation.workflow_settings;
  if (settings && typeof settings === 'object') {
    const candidate = (settings as { model?: unknown }).model;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return typeof generation.model === 'string' && generation.model.trim()
    ? generation.model.trim()
    : null;
}
