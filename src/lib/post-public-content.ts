const GENERATED_SETUP_HEADING = 'saved generation setup';

export function isGeneratedRecipeSetupText(value: string | null | undefined): boolean {
  const normalized = value?.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return false;
  }

  const [firstLine] = normalized.split('\n', 1);
  return firstLine.trim().toLowerCase() === GENERATED_SETUP_HEADING;
}

export function sanitizePublicPostContent({
  body,
  description,
  hasRecipe,
  isPaidRecipe,
  prompt,
}: {
  body: string;
  description: string;
  hasRecipe: boolean;
  isPaidRecipe: boolean;
  prompt: string;
}): {
  body: string;
  description: string;
  prompt: string;
} {
  return {
    prompt: hasRecipe ? '' : prompt,
    body: isPaidRecipe && isGeneratedRecipeSetupText(body) ? '' : body,
    description: isPaidRecipe && isGeneratedRecipeSetupText(description) ? '' : description,
  };
}
