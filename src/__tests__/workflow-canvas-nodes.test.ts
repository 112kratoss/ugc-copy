import { describe, expect, it } from 'vitest';

import {
  getImageGenerateNodeSummary,
  getImageGenerateNodeSummaryWithCapabilities,
  getMotionGenerateNodeSummary,
  getVideoGenerateNodeSummary,
  getVideoGenerateNodeSummaryWithCapabilities,
} from '@/app/create-workflow/WorkflowCanvasNodes';
import type {
  ImageGenerateNodeData,
  MotionGenerateNodeData,
  VideoGenerateNodeData,
} from '@/lib/workflow-canvas';
import { normalizeNodeData } from '@/lib/workflow-canvas';

describe('workflow canvas node summaries', () => {
  it('shows only active image-generator settings for the selected model', () => {
    const image = normalizeNodeData('image-generate', {
      model: 'nano-banana-2',
      aspectRatio: '16:9',
      resolution: '2K',
      outputFormat: 'png',
      googleSearch: true,
    } as never) as ImageGenerateNodeData;
    const proImage = normalizeNodeData('image-generate', {
      model: 'nano-banana-pro',
      googleSearch: true,
    } as never) as ImageGenerateNodeData;
    const gptImage = normalizeNodeData('image-generate', {
      model: 'gpt-image-2',
      aspectRatio: '4:5',
      resolution: '4K',
      outputFormat: 'png',
      googleSearch: true,
    } as never) as ImageGenerateNodeData;

    expect(getImageGenerateNodeSummary(image)).toEqual([
      'Aspect 16:9',
      '2K • PNG • Google Search',
    ]);
    expect(getImageGenerateNodeSummary(proImage)[1]).toBe('1K • JPG');
    expect(getImageGenerateNodeSummary(gptImage)).toEqual([
      'Aspect 4:5',
      '4K',
    ]);
  });

  it('shows only model-relevant video-generator settings', () => {
    const kling = normalizeNodeData('video-generate', {
      model: 'kling-3.0-video',
      aspectRatio: '16:9',
      duration: 10,
      mode: 'pro',
      sound: false,
      resolution: '1080p',
      fixedLens: true,
    } as never) as VideoGenerateNodeData;
    const seedance = normalizeNodeData('video-generate', {
      model: 'seedance-1.5-pro',
      aspectRatio: '9:16',
      duration: 8,
      sound: true,
      resolution: '1080p',
      fixedLens: true,
    } as never) as VideoGenerateNodeData;
    const veo = normalizeNodeData('video-generate', {
      model: 'veo-3.1',
      aspectRatio: '16:9',
      mode: 'veo3',
      duration: 8,
    } as never) as VideoGenerateNodeData;

    expect(getVideoGenerateNodeSummary(kling)).toEqual([
      '16:9 • 10s',
      'Pro (1080p, High Quality) • Silent',
      'Frames mode',
    ]);
    expect(getVideoGenerateNodeSummary(seedance)).toEqual([
      '9:16 • 8s',
      '1080p • Native audio on • Fixed lens',
      'Frames mode',
    ]);
    expect(getVideoGenerateNodeSummary(veo)).toEqual([
      '16:9 • 8s fixed',
      'Quality',
      'Frames mode',
    ]);
  });

  it('adds capability counts to image and video summaries when runtime validation is available', () => {
    const image = normalizeNodeData('image-generate', {
      model: 'nano-banana-2',
      aspectRatio: '16:9',
      resolution: '2K',
      outputFormat: 'png',
    } as never) as ImageGenerateNodeData;
    const video = normalizeNodeData('video-generate', {
      model: 'seedance-1.5-pro',
      aspectRatio: '9:16',
      duration: 8,
      sound: true,
      resolution: '1080p',
      fixedLens: true,
    } as never) as VideoGenerateNodeData;

    expect(getImageGenerateNodeSummaryWithCapabilities(image, {
      isValid: true,
      issues: [],
      referenceImageCount: 3,
      referenceImageLimit: 14,
      totalReferenceImageCount: 3,
      referenceVideoCount: 0,
      referenceAudioCount: 0,
      referenceVideoLimit: null,
      referenceVideoDurationLimitSeconds: null,
      connectedElementCount: 0,
      legacyElementCount: 0,
      namedElementCount: 0,
      namedElementLimit: 14,
      startFrameCount: 0,
      endFrameCount: 0,
      activeReferenceMode: null,
      isMultiShot: false,
      multiPromptCount: 0,
      unsupportedFeatureNotes: [],
    })).toEqual([
      'Aspect 16:9',
      '2K • PNG',
      'Refs 3/14',
    ]);

    expect(getVideoGenerateNodeSummaryWithCapabilities(video, {
      isValid: true,
      issues: [],
      referenceImageCount: 1,
      referenceImageLimit: 1,
      totalReferenceImageCount: 0,
      referenceVideoCount: 0,
      referenceAudioCount: 0,
      referenceVideoLimit: null,
      referenceVideoDurationLimitSeconds: null,
      connectedElementCount: 0,
      legacyElementCount: 0,
      namedElementCount: 0,
      namedElementLimit: 0,
      startFrameCount: 0,
      endFrameCount: 0,
      activeReferenceMode: 'frames',
      isMultiShot: false,
      multiPromptCount: 0,
      unsupportedFeatureNotes: [],
    })).toEqual([
      '9:16 • 8s',
      '1080p • Native audio on • Fixed lens',
      'Frames mode',
      'Frames: none',
    ]);
  });

  it('shows motion summary limits for current workflow-supported references', () => {
    const motion = normalizeNodeData('motion-generate', {
      model: 'kling-3.0',
      mode: '1080p',
      characterOrientation: 'image',
    } as never) as MotionGenerateNodeData;

    expect(getMotionGenerateNodeSummary(motion, {
      isValid: true,
      issues: [],
      referenceImageCount: 1,
      referenceImageLimit: 1,
      totalReferenceImageCount: 1,
      referenceVideoCount: 1,
      referenceAudioCount: 0,
      referenceVideoLimit: 1,
      referenceVideoDurationLimitSeconds: 30,
      connectedElementCount: 0,
      legacyElementCount: 0,
      namedElementCount: 0,
      namedElementLimit: null,
      startFrameCount: 0,
      endFrameCount: 0,
      activeReferenceMode: null,
      isMultiShot: false,
      multiPromptCount: 0,
      unsupportedFeatureNotes: [],
    })).toEqual([
      '1080p • image',
      'Image refs 1/1 • Video refs 1/1',
      '30s ref max',
    ]);
  });
});
