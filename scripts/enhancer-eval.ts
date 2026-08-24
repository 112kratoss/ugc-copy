/**
 * Live constraint-obedience eval for the prompt enhancer.
 *
 * Runs a small fixture set through the real provider (costs a few cents) and
 * checks each model's hard rules — verbatim preservation, budgets, dialect
 * markers, banned phrasing. Not part of CI: needs KIE_AI_API_KEY and spends
 * provider credits.
 *
 *   npm run eval:enhancer            # live run
 *   npm run eval:enhancer -- --dry   # print system prompts only, no provider calls
 */

import {
  applyPromptEnhancementSafeguardsWithMetadata,
  buildEnhancerSystemPrompt,
  buildPromptEnhancementArtifacts,
  callPromptEnhancer,
  getPlannerResponseSchema,
  type EnhancerContext,
  type Medium,
} from '../src/lib/prompt-enhancer';
import { getEnhancerPlaybookById } from '../src/lib/prompt-enhancer-playbooks';

interface EvalCase {
  name: string;
  medium: Medium;
  selectedModel: string;
  prompt: string;
  context?: EnhancerContext;
  checks: Array<{
    label: string;
    severity: 'fail' | 'warn';
    test: (compiledPrompt: string) => boolean;
  }>;
}

const CASES: EvalCase[] = [
  {
    name: 'veo dialogue without quotes',
    medium: 'video',
    selectedModel: 'veo-3.1',
    prompt: 'creator says "this serum changed my skin" while holding the bottle',
    context: { duration: 8, sound: true },
    checks: [
      {
        label: 'no straight-quoted dialogue in output',
        severity: 'fail',
        test: (prompt) => !/"[^"]{4,}"/.test(prompt),
      },
      {
        label: 'audio scripted (SFX/Ambient/no music)',
        severity: 'warn',
        test: (prompt) => /ambient|sfx|no music|audio/i.test(prompt),
      },
      {
        label: 'spoken line preserved',
        severity: 'fail',
        test: (prompt) => /serum changed my skin/i.test(prompt),
      },
    ],
  },
  {
    name: 'hailuo bracket camera, no frame re-description',
    medium: 'video',
    selectedModel: 'hailuo-2.3',
    prompt: 'she slowly turns her head and smiles, camera pushes in',
    context: { duration: 6, hasStartImage: true },
    checks: [
      {
        label: 'uses a MiniMax bracket command',
        severity: 'warn',
        test: (prompt) => /\[(push in|pull out|pan |tilt |truck |zoom |static shot|tracking shot|pedestal )/i.test(prompt),
      },
      {
        label: 'no speech lines (silent route)',
        severity: 'fail',
        test: (prompt) => !/says?:|"[^"]{4,}"/i.test(prompt),
      },
    ],
  },
  {
    name: 'z-image hard character cap',
    medium: 'image',
    selectedModel: 'z-image',
    prompt: 'an elaborate renaissance banquet hall filled with musicians, dancers, candles, tapestries, golden goblets, hunting dogs, a roaring fireplace and a king toasting his court',
    checks: [
      {
        label: 'stays under 1,000 characters',
        severity: 'fail',
        test: (prompt) => prompt.length <= 1000,
      },
      {
        label: 'names the medium up front',
        severity: 'warn',
        test: (prompt) => /^(a |an )?(photo|photorealistic|film still|illustration|painting|render)/i.test(prompt),
      },
    ],
  },
  {
    name: 'gpt-image-2 labeled brief with constraints',
    medium: 'image',
    selectedModel: 'gpt-image-2',
    prompt: 'poster of our serum with the headline "GLOW FASTER"',
    context: { creativeIntent: 'ugc-ad' },
    checks: [
      {
        label: 'exact headline preserved verbatim',
        severity: 'fail',
        test: (prompt) => prompt.includes('GLOW FASTER'),
      },
      {
        label: 'labeled sections present',
        severity: 'warn',
        test: (prompt) => /subject:/i.test(prompt) && /constraints:/i.test(prompt),
      },
    ],
  },
  {
    name: 'kling element handles preserved',
    medium: 'video',
    selectedModel: 'kling-3.0-video',
    prompt: '@hero lifts @serum and smiles at the camera',
    context: {
      duration: 5,
      sound: false,
      elementReferences: [
        { handle: '@hero', displayName: 'Creator' },
        { handle: '@serum', displayName: 'Serum bottle' },
      ],
    },
    checks: [
      {
        label: '@handles survive enhancement',
        severity: 'fail',
        test: (prompt) => prompt.includes('@hero') && prompt.includes('@serum'),
      },
    ],
  },
  {
    name: 'motion transfer strips choreography',
    medium: 'motion',
    selectedModel: 'kling-3.0',
    prompt: 'make her dance energetically on a rooftop at sunset',
    context: { hasReferenceVideo: true, characterOrientation: 'video' },
    checks: [
      {
        label: 'no dance/choreography direction in output',
        severity: 'fail',
        test: (prompt) => !/\bdanc\w*/i.test(prompt),
      },
      {
        label: 'keeps the rooftop sunset environment',
        severity: 'warn',
        test: (prompt) => /rooftop|sunset/i.test(prompt),
      },
    ],
  },
  {
    name: 'tts normalization expands symbols',
    medium: 'audio',
    selectedModel: 'text-to-speech-turbo-2-5',
    prompt: 'Our serum is $4.99 this week. Visit glow.com/deal before Dec. 5!',
    checks: [
      {
        label: 'no raw currency/domain symbols left',
        severity: 'fail',
        test: (prompt) => !/\$\d|\.com\//.test(prompt),
      },
      {
        label: 'no stage directions added',
        severity: 'fail',
        test: (prompt) => !/\b(she|he|they) (said|says)\b|excitedly|angrily/i.test(prompt),
      },
    ],
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry');
  let hardFailures = 0;
  let warnings = 0;

  for (const evalCase of CASES) {
    const systemPrompt = buildEnhancerSystemPrompt(
      evalCase.medium,
      evalCase.selectedModel,
      evalCase.context,
      evalCase.prompt
    );

    console.log(`\n=== ${evalCase.name} (${evalCase.selectedModel}) ===`);

    if (dryRun) {
      console.log(`[dry] system prompt: ${systemPrompt.length} chars`);
      continue;
    }

    const responseSchema = getPlannerResponseSchema(evalCase.selectedModel);
    let result;
    try {
      result = await callPromptEnhancer(systemPrompt, evalCase.prompt, {
        ...(responseSchema ? { responseSchema } : {}),
      });
    } catch {
      // One retry — Kie intermittently 524s; a second attempt usually lands.
      try {
        result = await callPromptEnhancer(systemPrompt, evalCase.prompt, {
          ...(responseSchema ? { responseSchema } : {}),
        });
      } catch (secondError) {
        warnings += 1;
        console.log(`⚠ provider error, case skipped: ${String(secondError)}`);
        continue;
      }
    }
    const artifacts = buildPromptEnhancementArtifacts(
      evalCase.medium,
      evalCase.selectedModel,
      result.enhancedPrompt,
      evalCase.context,
      evalCase.prompt
    );
    // Mirror the service: safeguards run on the compiled prompt before it is
    // returned to the user, so the checks must see the post-safeguard text.
    const safeguarded = applyPromptEnhancementSafeguardsWithMetadata(
      evalCase.prompt,
      artifacts.compiledPrompt,
      evalCase.context
    );
    const finalPrompt = safeguarded.enhancedPrompt;

    const playbook = getEnhancerPlaybookById(evalCase.selectedModel);
    const words = finalPrompt.split(/\s+/).length;
    const safeguardNote = safeguarded.appliedSafeguards.length > 0
      ? `, safeguards: ${safeguarded.appliedSafeguards.map((safeguard) => safeguard.code).join('+')}`
      : '';
    console.log(`compiled (${words} words, ${finalPrompt.length} chars, agent ${artifacts.agentId}${safeguardNote}):`);
    console.log(finalPrompt);

    if (playbook && words > playbook.budget.targetWords[1] * 1.6) {
      warnings += 1;
      console.log(`⚠ over word budget target (${words} > ${playbook.budget.targetWords[1]})`);
    }

    for (const check of evalCase.checks) {
      const passed = check.test(finalPrompt);
      if (passed) {
        console.log(`✓ ${check.label}`);
      } else if (check.severity === 'fail') {
        hardFailures += 1;
        console.log(`✗ FAIL ${check.label}`);
      } else {
        warnings += 1;
        console.log(`⚠ ${check.label}`);
      }
    }
  }

  if (!dryRun) {
    console.log(`\n${hardFailures} hard failure(s), ${warnings} warning(s) across ${CASES.length} cases.`);
    if (hardFailures > 0) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
