import { describe, expect, it } from 'vitest';
import {
  buildImageLaunchUrl,
  buildVideoLaunchUrl,
  extractBlueprintFromResponse,
  sanitizeBlueprint,
  DEFAULT_BLUEPRINT,
} from '@/lib/workflow-blueprint';

describe('workflow blueprint helpers', () => {
  it('extracts blueprint JSON from fenced responses', () => {
    const blueprint = extractBlueprintFromResponse(`Here you go\n\n\`\`\`json\n{"title":"Test plan","creativeStrategy":"Strategy","hook":"Hook","narrative":"Narrative","voiceover":"VO","editingNotes":["Note"],"assetChecklist":["Asset"],"shots":[{"id":"shot-1","title":"Intro","purpose":"Purpose","beat":"Beat","visualPrompt":"Image prompt","videoPrompt":"Video prompt","motionPrompt":"Motion prompt","duration":5}],"deliveryPlan":{"primaryModel":"kling-3.0-video","stillImageModel":"nano-banana-pro","motionModel":"kling-3.0","recommendedSequence":["Step 1"]}}\n\`\`\``);
    expect(blueprint.title).toBe('Test plan');
    expect(blueprint.shots[0].videoPrompt).toBe('Video prompt');
  });

  it('falls back to defaults when content is invalid', () => {
    const blueprint = extractBlueprintFromResponse('not valid json');
    expect(blueprint).toEqual(DEFAULT_BLUEPRINT);
  });

  it('sanitizes partial data and builds launch urls', () => {
    const blueprint = sanitizeBlueprint({ shots: [{ title: '', purpose: '', beat: '', visualPrompt: '', videoPrompt: '', motionPrompt: '', duration: 99 }] as never[] });
    expect(blueprint.shots[0].duration).toBeLessThanOrEqual(12);
    expect(buildImageLaunchUrl('hello world')).toContain('/create-image?');
    expect(buildVideoLaunchUrl('scene prompt', 'kling-3.0-video', '9:16', '5')).toContain('duration=5');
  });
});
