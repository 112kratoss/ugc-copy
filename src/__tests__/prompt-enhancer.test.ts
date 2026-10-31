import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  applyPromptEnhancementSafeguards,
  applyPromptEnhancementSafeguardsWithMetadata,
  buildEnhancerSystemPrompt,
  buildPromptEnhancementArtifacts,
  buildPromptStrategyGuidance,
  buildWorkflowPromptFieldGuidance,
  callPromptEnhancer,
  getPromptEnhancementCost,
  PROMPT_ENHANCER_CALLER_MARGIN_MS,
  PROMPT_ENHANCER_DEFAULT_DEADLINE_MS,
  PROMPT_ENHANCER_HEDGE_AFTER_MS,
  PROMPT_ENHANCER_MAX_DEADLINE_MS,
  PROMPT_ENHANCER_WAIT_HEADER,
  resolvePromptEnhancementAgent,
  resolvePromptEnhancerDeadlineMs,
  resolvePromptScenario,
} from '@/lib/prompt-enhancer';
import { inspectPromptQuality } from '@/lib/prompt-quality';
import { PROMPT_ENHANCER_FIXTURES } from '@/__tests__/fixtures/prompt-enhancer-fixtures';
import { PROMPT_ENHANCEMENT_COST_CREDITS } from '../../ugc-mobile/lib/model-catalog/protocol';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('prompt enhancement price', () => {
  it('debits the one price both apps print on their Enhance buttons', () => {
    expect(getPromptEnhancementCost()).toBe(PROMPT_ENHANCEMENT_COST_CREDITS);
    expect(PROMPT_ENHANCEMENT_COST_CREDITS).toBe(2);
  });
});

describe('how long the enhancer waits for Kie', () => {
  const answer = (content: string) => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  /** An ask Kie never answers: it ends only when its signal is aborted. */
  const hangUntilAborted = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });

  let deadlines: AbortController[];
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('KIE_AI_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Each ask's deadline is a signal the test ends by hand.
    deadlines = [];
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds an ask whose caller has not said how long it waits to what every installed app waits for', async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return answer('Enhanced product prompt');
    }));

    await expect(callPromptEnhancer('system prompt', 'user prompt')).resolves.toEqual({
      enhancedPrompt: 'Enhanced product prompt',
    });
    expect(timeoutSpy).toHaveBeenCalledWith(PROMPT_ENHANCER_DEFAULT_DEADLINE_MS);
    expect(PROMPT_ENHANCER_DEFAULT_DEADLINE_MS).toBe(25_000);
    expect(requestInit?.signal?.aborted).toBe(false);
    deadlines[0].abort();
    expect(requestInit?.signal?.aborted).toBe(true);
  });

  it('asks Kie again when it has not answered in 12 s, keeps the first answer and lets the stuck ask go', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal!);
      return signals.length === 1 ? hangUntilAborted(init) : answer('Answered on the second ask');
    });
    vi.stubGlobal('fetch', fetchMock);

    const enhanced = callPromptEnhancer('system prompt', 'user prompt', { deadlineMs: 55_000 });
    await vi.advanceTimersByTimeAsync(PROMPT_ENHANCER_HEDGE_AFTER_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(enhanced).resolves.toEqual({ enhancedPrompt: 'Answered on the second ask' });
    expect(PROMPT_ENHANCER_HEDGE_AFTER_MS).toBe(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second ask gets what is left of the same deadline, not a new one.
    expect(timeoutSpy.mock.calls).toEqual([[55_000], [43_000]]);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks again at once when Kie answers with a server error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('internal error, please try again later', { status: 500 }))
      .mockResolvedValueOnce(answer('Answered on the second ask'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callPromptEnhancer('system prompt', 'user prompt', { deadlineMs: 55_000 })).resolves.toEqual({
      enhancedPrompt: 'Answered on the second ask',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks again at once when Kie wraps a server error in a 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 500, msg: 'internal error' }), { status: 200 }))
      .mockResolvedValueOnce(answer('Answered on the second ask'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callPromptEnhancer('system prompt', 'user prompt', { deadlineMs: 55_000 })).resolves.toEqual({
      enhancedPrompt: 'Answered on the second ask',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not ask again when Kie refuses the account, however long is left', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('insufficient balance', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);

    const failure = expect(callPromptEnhancer('system prompt', 'user prompt', { deadlineMs: 55_000 }))
      .rejects.toThrow('Kie API returned 402: insufficient balance');
    await vi.advanceTimersByTimeAsync(55_000);
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks at most twice, and reports what the first ask met', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('first failure', { status: 503 }))
      .mockResolvedValueOnce(new Response('second failure', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callPromptEnhancer('system prompt', 'user prompt', { deadlineMs: 55_000 }))
      .rejects.toThrow('Kie API returned 503: first failure');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline when neither ask is answered, naming the whole wait', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => hangUntilAborted(init));
    vi.stubGlobal('fetch', fetchMock);

    const failure = expect(callPromptEnhancer('system prompt', 'user prompt', { deadlineMs: 25_000 }))
      .rejects.toMatchObject({
        name: 'ExternalServiceTimeoutError',
        message: 'KIE prompt enhancer request timed out after 25000ms.',
      });
    await vi.advanceTimersByTimeAsync(PROMPT_ENHANCER_HEDGE_AFTER_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(25_000 - PROMPT_ENHANCER_HEDGE_AFTER_MS);
    for (const deadline of deadlines) {
      deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }

    await failure;
    expect(timeoutSpy.mock.calls).toEqual([[25_000], [13_000]]);
  });
});

describe('the deadline each caller gets', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it('gives the web page, whose request has no deadline of its own, the whole budget', () => {
    expect(resolvePromptEnhancerDeadlineMs(headers({}))).toBe(PROMPT_ENHANCER_MAX_DEADLINE_MS);
    expect(PROMPT_ENHANCER_MAX_DEADLINE_MS).toBe(55_000);
  });

  it('keeps an app that has not said how long it waits inside the 30 s it gives every request', () => {
    expect(resolvePromptEnhancerDeadlineMs(headers({ 'x-magicbooklet-client': 'mobile' })))
      .toBe(30_000 - PROMPT_ENHANCER_CALLER_MARGIN_MS);
  });

  it('never waits longer than the caller says it will, nor longer than the budget', () => {
    expect(resolvePromptEnhancerDeadlineMs(headers({
      'x-magicbooklet-client': 'mobile',
      [PROMPT_ENHANCER_WAIT_HEADER]: '20000',
    }))).toBe(20_000 - PROMPT_ENHANCER_CALLER_MARGIN_MS);
    expect(resolvePromptEnhancerDeadlineMs(headers({
      'x-magicbooklet-client': 'mobile',
      [PROMPT_ENHANCER_WAIT_HEADER]: '600000',
    }))).toBe(PROMPT_ENHANCER_MAX_DEADLINE_MS);
  });

  it('reads a wait it cannot use as no wait at all', () => {
    for (const stated of ['', 'soon', '-5', '0']) {
      expect(resolvePromptEnhancerDeadlineMs(headers({
        'x-magicbooklet-client': 'mobile',
        [PROMPT_ENHANCER_WAIT_HEADER]: stated,
      }))).toBe(PROMPT_ENHANCER_DEFAULT_DEADLINE_MS);
    }
  });

  it('gives the app, which states the wait the contract pins, the whole budget with time to spare', () => {
    const { clientWait } = mobileApiContract.endpoints.enhancePrompt;
    expect(clientWait.header).toBe(PROMPT_ENHANCER_WAIT_HEADER);
    expect(resolvePromptEnhancerDeadlineMs(headers({
      'x-magicbooklet-client': 'mobile',
      [clientWait.header]: String(clientWait.timeoutMs),
    }))).toBe(PROMPT_ENHANCER_MAX_DEADLINE_MS);
    expect(PROMPT_ENHANCER_MAX_DEADLINE_MS + PROMPT_ENHANCER_CALLER_MARGIN_MS).toBeLessThanOrEqual(clientWait.timeoutMs);
  });
});

describe('prompt enhancer strategy', () => {

  it.each(PROMPT_ENHANCER_FIXTURES)('resolves scenario for $name', (fixture) => {
    expect(resolvePromptScenario(fixture.medium, fixture.selectedModel, fixture.context)).toBe(
      fixture.expectedScenario
    );
  });

  it.each(PROMPT_ENHANCER_FIXTURES)('builds scenario-aware guidance for $name', (fixture) => {
    const guidance = buildPromptStrategyGuidance({
      medium: fixture.medium,
      selectedModel: fixture.selectedModel,
      context: fixture.context,
      includeExamples: true,
    });

    for (const expected of fixture.expectedIncludes) {
      expect(guidance).toContain(expected);
    }

    for (const excluded of fixture.expectedExcludes ?? []) {
      expect(guidance).not.toContain(excluded);
    }
  });

  it('only adds text rendering guidance when the image prompt asks for text', () => {
    const withText = buildEnhancerSystemPrompt(
      'image',
      'nano-banana-2',
      { aspectRatio: '1:1' },
      'Create a poster and the text reads SALE'
    );
    const withoutText = buildEnhancerSystemPrompt(
      'image',
      'nano-banana-2',
      { aspectRatio: '1:1' },
      'Create a founder portrait in the studio'
    );

    expect(withText).toContain('Text rendering guidance:');
    expect(withoutText).not.toContain('Text rendering guidance:');
    expect(withText).toContain('ImagePromptSpec schema');
  });

  it('only includes Google Search grounding guidance when it is enabled', () => {
    const grounded = buildPromptStrategyGuidance({
      medium: 'image',
      selectedModel: 'nano-banana-2',
      context: { googleSearch: true },
    });
    const notGrounded = buildPromptStrategyGuidance({
      medium: 'image',
      selectedModel: 'nano-banana-2',
      context: { googleSearch: false },
    });

    expect(grounded).toContain('Google Search grounding is enabled');
    expect(notGrounded).not.toContain('Google Search grounding is enabled');
  });

  it('routes video enhancement through model-specific agents', () => {
    expect(resolvePromptEnhancementAgent('kling-3.0-video').id).toBe('kling-video-director');
    expect(resolvePromptEnhancementAgent('kling-3.0/video').id).toBe('kling-video-director');
    expect(resolvePromptEnhancementAgent('seedance-2').id).toBe('seedance-2-reference-director');
    expect(resolvePromptEnhancementAgent('veo-3.1').id).toBe('veo-31-director');

    const guidance = buildEnhancerSystemPrompt(
      'video',
      'veo-3.1',
      { duration: 8, hasStartImage: true, hasEndImage: true },
      'Turn the product box into the final hero setup'
    );

    expect(guidance).toContain('Enhancement agent: Veo 3.1 director (veo-31-director)');
    expect(guidance).toContain('For first/last frames, describe the transition mechanics');
  });

  it('flags risky video prompts before expensive generation', () => {
    const inspection = inspectPromptQuality({
      medium: 'video',
      selectedModel: 'veo-3.1',
      prompt: 'Cool cinematic video then it opens then it explodes and says "buy now"',
      context: { duration: 8, sound: true },
    });

    expect(inspection.qualityScore).toBeLessThan(100);
    expect(inspection.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'too_many_events_for_duration',
        'missing_camera_intent',
        'veo_quoted_dialogue',
      ])
    );
  });

  it('builds structured image artifacts for Nano Banana 2 with concise readable-text output', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'nano-banana-2',
      JSON.stringify({
        subject: 'a founder holding a serum bottle',
        setting: 'a bright daylight studio',
        composition: 'centered portrait composition',
        cameraFraming: 'eye-level medium shot',
        lighting: 'soft diffused window light',
        materialDetail: 'natural skin texture and crisp glass reflections',
        readableText: {
          exactText: 'SALE',
          placement: 'on the poster header',
          treatment: 'clean sans-serif lettering',
        },
        finish: 'polished commercial finish',
      }),
      { aspectRatio: '9:16' },
      'Founder poster with SALE text'
    );

    expect(artifacts.plannerMode).toBe('structured-image');
    expect(artifacts.compiledPrompt).toContain('a founder holding a serum bottle');
    expect(artifacts.compiledPrompt).toContain('Include readable text "SALE"');
    expect(artifacts.compiledPrompt).toContain('polished commercial finish');
  });

  it('builds richer image artifacts for Nano Banana Pro with reference anchors', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'nano-banana-pro',
      JSON.stringify({
        subject: 'a premium skincare product hero still',
        setting: 'on a marble vanity in a warm editorial bathroom',
        composition: 'clean poster-style layout with strong negative space',
        cameraFraming: 'three-quarter product framing',
        lighting: 'soft golden-hour light',
        materialDetail: 'tactile packaging detail and crisp glass highlights',
        referenceAnchors: ['the attached creator identity', 'the exact product packaging'],
        readableText: {
          exactText: 'Build Your Routine',
          placement: 'as the top headline',
          treatment: 'high-contrast premium sans-serif typography',
        },
        constraints: ['the branding legible', 'the product label unobstructed'],
        finish: 'high-fidelity commercial polish',
      }),
      { referenceImageCount: 2 },
      'Premium skincare poster'
    );

    expect(artifacts.compiledPrompt).toContain('premium skincare product hero still');
    expect(artifacts.compiledPrompt).toContain('Preserve the attached creator identity and the exact product packaging');
    expect(artifacts.compiledPrompt).toContain('Include readable text "Build Your Routine"');
    expect(artifacts.compiledPrompt).toContain('Keep the branding legible and the product label unobstructed');
  });

  it('builds structured image artifacts for GPT Image 2', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'gpt-image-2',
      JSON.stringify({
        subject: 'a ChatGPT-style product campaign still',
        setting: 'on a warm amber studio set',
        composition: 'clean ad composition with strong headline space',
        cameraFraming: 'three-quarter product framing',
        lighting: 'warm directional key light',
        materialDetail: 'crisp packaging texture and realistic reflections',
        referenceAnchors: ['the exact product shape'],
        readableText: {
          exactText: 'Glow Faster',
          placement: 'top-left headline area',
          treatment: 'bold editorial sans-serif',
        },
        finish: 'premium commercial polish',
      }),
      { referenceImageCount: 1 },
      'ChatGPT image product ad'
    );

    expect(artifacts.playbookId).toBe('gpt-image-2');
    expect(artifacts.plannerMode).toBe('structured-image');
    // gpt-image-2 compiles to the official labeled-sections brief.
    expect(artifacts.compiledPrompt).toContain('Scene: on a warm amber studio set.');
    expect(artifacts.compiledPrompt).toContain('Subject: a ChatGPT-style product campaign still');
    expect(artifacts.compiledPrompt).toContain('Preserve: the exact product shape.');
    expect(artifacts.compiledPrompt).toContain('Text: Include readable text "Glow Faster"');
    expect(artifacts.compiledPrompt).toContain('Use case:');
    expect(artifacts.compiledPrompt).toContain('Constraints: no watermark.');
  });

  it('compiles Veo prompts without quoted dialogue and keeps one scene per clip', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'veo-3.1',
      JSON.stringify({
        sceneGoal: 'show the creator discovering the product benefit',
        subjectAction: 'a creator lifts the serum and smiles to camera',
        environment: 'inside a bright modern bathroom',
        cameraMovement: 'gentle push-in',
        ambience: 'clean natural daylight',
        pacing: 'one focused 8-second beat',
        durationBudget: '8-second clip',
        dialogue: 'Creator says: "Glow in one swipe."',
      }),
      { duration: 8 },
      'Creator reveals the serum benefit'
    );

    expect(artifacts.compiledPrompt).toContain('a creator lifts the serum and smiles to camera');
    expect(artifacts.compiledPrompt).toContain('Creator says: Glow in one swipe.');
    expect(artifacts.compiledPrompt).not.toContain('"Glow in one swipe."');
  });

  it('compiles Seedance prompts with fixed-lens and audio cues only when enabled', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'seedance-1.5-pro',
      JSON.stringify({
        sceneGoal: 'bartender greeting guests',
        subjectAction: 'a bartender leans forward to welcome the group',
        environment: 'inside a lively Portuguese tavern',
        cameraMovement: 'medium shot with subtle drift',
        ambience: 'warm evening atmosphere',
        audioCue: 'clinking glasses and soft crowd chatter',
        pacing: 'relaxed but responsive pacing',
        durationBudget: '8-second clip',
      }),
      { duration: 8, sound: true, fixedLens: true },
      'Bartender greets guests'
    );

    expect(artifacts.compiledPrompt).toContain('static locked camera');
    expect(artifacts.compiledPrompt).toContain('Audio cues: clinking glasses and soft crowd chatter.');
  });

  it('compiles Seedance 2 prompts using the matching playbook', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'seedance-2',
      JSON.stringify({
        sceneGoal: 'creator demo in a kitchen',
        subjectAction: 'a creator lifts the frother and demonstrates it to camera',
        environment: 'inside a bright modern kitchen',
        cameraMovement: 'steady medium shot',
        continuityAnchors: ['the same creator', 'the same countertop'],
        ambience: 'warm daylight',
        audioCue: 'gentle appliance hum and light room tone',
        pacing: 'clear and paced',
        durationBudget: '12-second clip',
      }),
      { duration: 12, sound: true, hasReferenceVideo: true },
      'Creator kitchen demo'
    );

    expect(artifacts.plannerMode).toBe('structured-video');
    expect(artifacts.compiledPrompt).toContain('steady medium shot');
    expect(artifacts.compiledPrompt).toContain('Audio cues: gentle appliance hum and light room tone.');
    expect(artifacts.compiledPrompt).toContain('Preserve the same creator and the same countertop');
  });

  it('compiles Kling multi-shot prompts into the current shot when shot index is known', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'kling-3.0/video',
      JSON.stringify({
        sceneGoal: 'premium unboxing sequence',
        subjectAction: 'hands reveal a premium device',
        environment: 'on a moody premium tabletop',
        cameraMovement: 'slow cinematic push-in',
        continuityAnchors: ['the same matte black box', 'the same pair of hands'],
        ambience: 'controlled studio atmosphere',
        pacing: 'measured premium pacing',
        durationBudget: '4-second shot',
        shots: [
          {
            index: 1,
            title: 'Box arrival',
            startState: 'the unopened box lands on the table',
            actionBeat: 'hands square the product to camera',
            endState: 'the lid is ready to lift',
            camera: 'low-angle dolly-in',
          },
          {
            index: 2,
            title: 'Product reveal',
            startState: 'the lid lifts away',
            actionBeat: 'the device is revealed on velvet',
            endState: 'hands pause for a hero hold',
            camera: 'slow overhead glide',
            transition: 'keep the same premium tabletop lighting',
          },
        ],
      }),
      { isMultiShot: true, shotIndex: 1, shotCount: 2, duration: 4 },
      'Two-shot premium unboxing'
    );

    expect(artifacts.compiledPrompt).toContain('Product reveal');
    expect(artifacts.compiledPrompt).toContain('slow overhead glide');
    expect(artifacts.compiledPrompt).not.toContain('Shot 1:');
  });

  it('emits ordered shot prompts only when multi-shot mode requests a full sequence', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'kling-3.0/video',
      JSON.stringify({
        sceneGoal: 'premium unboxing sequence',
        subjectAction: 'hands reveal a premium device',
        environment: 'on a moody premium tabletop',
        cameraMovement: 'slow cinematic push-in',
        shots: [
          {
            index: 1,
            title: 'Box arrival',
            startState: 'the unopened box lands on the table',
            actionBeat: 'hands square the product to camera',
            endState: 'the lid is ready to lift',
            camera: 'low-angle dolly-in',
          },
          {
            index: 2,
            title: 'Product reveal',
            startState: 'the lid lifts away',
            actionBeat: 'the device is revealed on velvet',
            endState: 'hands pause for a hero hold',
            camera: 'slow overhead glide',
          },
        ],
      }),
      { isMultiShot: true, shotCount: 2 },
      'Two-shot premium unboxing'
    );

    expect(artifacts.compiledPrompt).toContain('Shot 1:');
    expect(artifacts.compiledPrompt).toContain('Shot 2:');
  });

  it('falls back to raw enhancer text when structured output is malformed', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'nano-banana-2',
      'A concise founder portrait in a bright studio with crisp product visibility.',
      { aspectRatio: '1:1' },
      'Founder portrait'
    );

    expect(artifacts.compiledPrompt).toBe('A concise founder portrait in a bright studio with crisp product visibility.');
  });

  it('preserves missing named handles in standard safeguard mode', () => {
    const safeguarded = applyPromptEnhancementSafeguards(
      'Place @serum on a marble vanity',
      'A premium product still on a marble vanity.',
      {
        elementReferences: [{ handle: '@serum', displayName: 'Serum bottle' }],
      }
    );

    expect(safeguarded).toContain('@serum');
    expect(safeguarded).toContain('Preserve the named reference elements @serum exactly as referenced.');
  });

  it('reverts append-only element prompts when the enhanced prompt breaks the locked opening', () => {
    const safeguarded = applyPromptEnhancementSafeguards(
      'Use @serum in a bright studio',
      'A premium product shot in a bright studio with crisp highlights.',
      {
        elementEnhancementMode: 'append-only',
        elementReferences: [{ handle: '@serum', displayName: 'Serum bottle' }],
      }
    );

    expect(safeguarded).toBe('Use @serum in a bright studio');
  });

  it('builds workflow field guidance that changes by model and objective', () => {
    const guidance = buildWorkflowPromptFieldGuidance({
      fieldName: 'videoPrompt',
      modelSelector: 'primaryModel',
      medium: 'video',
      scenario: 'video.image_to_video_start_frame',
      modelIds: ['kling-3.0-video', 'seedance-1.5-pro', 'seedance-2', 'seedance-2-fast', 'veo-3.1'],
      context: { creativeIntent: 'ugc-ad' },
      additionalRules: ['These prompts should remain reference-friendly.'],
    });

    expect(guidance).toContain('videoPrompt guidance:');
    expect(guidance).toContain('These prompts should remain reference-friendly.');
    expect(guidance).toContain('If primaryModel is kling-3.0-video');
    expect(guidance).toContain('If primaryModel is seedance-1.5-pro');
    expect(guidance).toContain('If primaryModel is seedance-2');
    expect(guidance).toContain('If primaryModel is seedance-2-fast');
    expect(guidance).toContain('If primaryModel is veo-3.1');
    expect(guidance).toContain('creator-led commercial realism');
    expect(guidance).toContain('one scene with explicit subject, action, context, camera, and ambience');
  });
});

/**
 * The safeguards read a prompt's mentions with a pattern of their own,
 * /@[\p{L}\p{N}_-]+/gu, and not the one the server reads a prompt with
 * (extractPromptHandles in src/lib/image-elements.ts). Theirs ran a handle on
 * through a hyphen and through the letters of any script, took the end of an
 * address for a mention, and counted a handle once for each time it was written.
 * So "@product-style" and "@productを" did not mention "@product" to them, though
 * they do to a generation, and "studio@product.example" did (2026-10-03).
 */
describe('the mentions the enhancement safeguards read', () => {
  const product = { elementReferences: [{ handle: '@product', displayName: 'Product' }] };
  const lockedProduct = { ...product, elementEnhancementMode: 'append-only' as const };
  const restoring = (enhanced: string, handles: string) =>
    `${enhanced} Preserve the named reference elements ${handles} exactly as referenced.`;
  const codes = (result: { appliedSafeguards: Array<{ code: string }> }) =>
    result.appliedSafeguards.map((safeguard) => safeguard.code);

  it('restores a handle the enhancement dropped, where the prompt joined a word to it with a hyphen', () => {
    const enhanced = 'A premium still with stylised lighting on a marble vanity.';

    expect(applyPromptEnhancementSafeguards('Show @product-style lighting on a marble vanity', enhanced, product))
      .toBe(restoring(enhanced, '@product'));
  });

  it('restores a handle the enhancement dropped, where another script follows it without a space', () => {
    // Japanese sets the particle straight after the word: "put @product on the marble vanity".
    const enhanced = '大理石の洗面台に置かれた上質な商品写真。';

    expect(applyPromptEnhancementSafeguards('@productを大理石の洗面台に置く', enhanced, product))
      .toBe(restoring(enhanced, '@product'));
  });

  it.each([
    'A @product-inspired still on a marble vanity.',
    '机の上の@productを柔らかい光で撮る。',
  ])('adds nothing where the enhanced prompt kept the handle and joined a word to it: %s', (enhanced) => {
    expect(applyPromptEnhancementSafeguardsWithMetadata('Place @product on a marble vanity', enhanced, product))
      .toEqual({ enhancedPrompt: enhanced, appliedSafeguards: [] });
  });

  it('reads no mention in an address, so it writes none the author did not', () => {
    const enhanced = 'A clean studio poster with booking details.';

    expect(applyPromptEnhancementSafeguardsWithMetadata(
      'A studio poster, mail studio@product.example for bookings',
      enhanced,
      product
    )).toEqual({ enhancedPrompt: enhanced, appliedSafeguards: [] });
  });

  it('names a restored handle once, however often the prompt mentioned it', () => {
    const enhanced = 'A premium still on a marble vanity, lit from the left.';

    expect(applyPromptEnhancementSafeguards(
      'Place @product on a marble vanity, then light @product from the left',
      enhanced,
      product
    )).toBe(restoring(enhanced, '@product'));
  });

  describe('in a prompt whose named elements are locked', () => {
    it('reverts for the handle that was removed, where the prompt joined a word to it', () => {
      const result = applyPromptEnhancementSafeguardsWithMetadata(
        'Show @product-style lighting',
        'A premium still with stylised lighting.',
        lockedProduct
      );

      expect(result.enhancedPrompt).toBe('Show @product-style lighting');
      expect(codes(result)).toEqual(['append_only_handle_preserved']);
    });

    it('reverts a prompt that holds an address for its changed opening, not for a handle it never held', () => {
      const result = applyPromptEnhancementSafeguardsWithMetadata(
        'Poster, mail studio@product.example',
        'A clean studio poster with booking details.',
        lockedProduct
      );

      expect(result.enhancedPrompt).toBe('Poster, mail studio@product.example');
      expect(codes(result)).toEqual(['append_only_opening_preserved']);
    });

    it('keeps what was added where the added words run on from the handle', () => {
      // The opening is intact and a generation still reads "@product" here.
      const enhanced = 'Soft daylight on @product-centred framing with a crisp finish.';

      expect(applyPromptEnhancementSafeguardsWithMetadata('Soft daylight on @product', enhanced, lockedProduct))
        .toEqual({ enhancedPrompt: enhanced, appliedSafeguards: [] });
    });
  });
});
