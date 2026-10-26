/**
 * A template result is a creation a template's run made: it records the run
 * (`generations.template_run_id`) or the step (`template_run_step_id`) it came
 * from. Its recipe and model are the template author's, so no read gives them
 * out: Studio names its model `template-workflow` and drops its prompt, every
 * public read of its post names the model the same way, and nobody can remix it
 * (`remix-access.ts`).
 */
export const TEMPLATE_RESULT_MODEL = 'template-workflow';

export type TemplateRunLink = {
  template_run_id?: string | null;
  template_run_step_id?: string | null;
};

export function isTemplateResultGeneration(generation: TemplateRunLink | null | undefined): boolean {
  return Boolean(generation?.template_run_id || generation?.template_run_step_id);
}
