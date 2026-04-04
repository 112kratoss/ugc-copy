import { describe, expect, it } from 'vitest';
import {
  buildImageLaunchUrl,
  buildWorkflowSystemPrompt,
  buildVideoLaunchUrl,
  createWorkflowGraphFromBlueprint,
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

  it('converts a blueprint into a runnable workflow graph', () => {
    const graph = createWorkflowGraphFromBlueprint(DEFAULT_BLUEPRINT, '16:9');
    const stillNode = graph.nodes.find((node) => node.data.title === 'Shot 1 still');
    const videoNode = graph.nodes.find((node) => node.data.title === 'Shot 1 video');
    const motionNode = graph.nodes.find((node) => node.data.title === 'Shot 1 motion');
    const voiceoverNode = graph.nodes.find((node) => node.data.title === 'Voiceover');

    expect(graph.nodes).toHaveLength(9);
    expect(graph.edges).toHaveLength(7);
    expect(stillNode?.type).toBe('image-generate');
    expect(stillNode?.data).toMatchObject({ aspectRatio: '16:9', model: DEFAULT_BLUEPRINT.deliveryPlan.stillImageModel });
    expect(videoNode?.data).toMatchObject({ model: DEFAULT_BLUEPRINT.deliveryPlan.primaryModel });
    expect(motionNode?.data).toMatchObject({ model: DEFAULT_BLUEPRINT.deliveryPlan.motionModel });
    expect(voiceoverNode?.type).toBe('voiceover-generate');
  });

  it('builds model-aware workflow prompt guidance for each shot type', () => {
    const systemPrompt = buildWorkflowSystemPrompt({
      brandName: 'GlowLab',
      productName: 'Night Repair Serum',
      audience: 'Skincare shoppers',
      objective: 'ugc-ad',
      primaryMessage: 'Calms skin overnight',
      offer: '20% off',
      callToAction: 'Shop now',
      visualStyle: 'clean creator realism',
      tone: 'confident',
      aspectRatio: '9:16',
      durationSeconds: 20,
      platform: 'TikTok',
    });

    expect(systemPrompt).toContain('visualPrompt guidance:');
    expect(systemPrompt).toContain('If stillImageModel is nano-banana-2');
    expect(systemPrompt).toContain('If stillImageModel is nano-banana-pro');
    expect(systemPrompt).toContain('videoPrompt guidance:');
    expect(systemPrompt).toContain('If primaryModel is kling-3.0-video');
    expect(systemPrompt).toContain('If primaryModel is seedance-1.5-pro');
    expect(systemPrompt).toContain('If primaryModel is seedance-2');
    expect(systemPrompt).toContain('If primaryModel is seedance-2-fast');
    expect(systemPrompt).toContain('If primaryModel is veo-3.1');
    expect(systemPrompt).toContain('motionPrompt guidance:');
    expect(systemPrompt).toContain('If motionModel is kling-3.0');
    expect(systemPrompt).toContain('creator-led commercial realism');
  });
});
