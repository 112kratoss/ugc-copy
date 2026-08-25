# Cross-Model Prompting Meta, Audio Prompting, and UGC-Ad Craft (2026-08-24)

Labels: **[Consensus]** = multiple independent sources agree · **[Contested]** = credible sources disagree · **[Single-source]** = one source, treat as lead.

## Part A — Community meta

### 1. The JSON-prompting debate
- Origin: viral June–July 2025 around Veo 3; credited to AI filmmaker Dave Clark (Promise Studios) script→JSON shot pipelines (creativepossible.substack.com/p/should-you-prompt-in-json); amplified by TikTok explainers + prompt-pack sellers (commercial incentive caveat).
- Pro: JSON forces completeness, reusable blocks across shots (dev.to/yigit-konur best-practices-of-json-prompting).
- Skeptics: Jason Zada "highly structured prompts might add unnecessary complexity without significantly improving results"; Gabe Michael "Whether that's done in bracketed blocks or crafted language doesn't matter as much as how well the prompt communicates your intent" — JSON won some A/Bs, lost others.
- Head-to-head: VP Land n=1 diner-scene test — JSON matched intent closely, prose drifted; verdict "better structure but not necessarily superior creative control or output quality" (vp-land.com JSON test).
- Official stances: NO vendor endorses JSON — Google Veo 3.1 guide is prose formula; OpenAI Sora 2 guide prose + dialogue block; Kling/Seedance/Higgsfield natural language. Veo's Gemini rewriter cannot be disabled, so JSON is re-digested by an LLM anyway.
- **[Consensus]**: active ingredient is *structured completeness* (all slots filled), not braces. JSON's defensible wins are pipeline-shaped (machine-editable, diffable, byte-identical recurring character blocks). **[Contested]**: whether JSON ever beats equally complete prose. → Enhancer: emit richly structured PROSE; keep JSON as internal representation.

### 2. Camera-language cheat sheet
Four-slot vocabulary: **shot size** (wide/medium/close-up/extreme close-up/two-shot), **angle** (low, high, eye-level, POV, overhead/aerial), **movement** (dolly in/out, tracking, crane, slow pan, tilt, orbit/arc, handheld, static/locked), **lens/optics** (35mm anamorphic, 85mm portrait, wide-angle 24mm, macro, shallow DOF, deep focus, soft focus).
- Veo 3/3.1: parses all; official list "Dolly shot, tracking shot, crane shot, aerial view, slow pan, POV shot" + lens/DOF. Rule of thumb: one shot type + one movement + one lens per clip; movement clause 5–10 words (prompt-architects.com).
- Kling: six motions — pan, tilt, zoom, roll, track, pedestal; camera clause tied to subject, placed at END (kling.ai camera guide; fal Kling O1: "camera slowly pushes in", "camera circles subject clockwise").
- Hailuo/MiniMax Director: literal enum bracket commands `[Push in]`, `[Truck left]`, `[Pan right]`, max 3 combined per bracket, sequential if placed at different points (fal Director API, getimg.ai guide) — most deterministic camera control on the market. [Consensus]
- Seedance: "surround, aerial, zoom, pan, follow, handheld" + multi-shot cuts via "Cut to / Camera cut to" (aimlapi.com Seedance guide).
- Sora 2: full production language rewarded.
- Runway Gen-4: simple + positively phrased; compound moves ignored.
- Ignored everywhere [Consensus]: vague mood words as camera direction; negatively-phrased camera instructions.

### 3. Image-to-video craft (strongest cross-model consensus)
- Runway official: "use your prompt to describe the motion of the scene"; "Reiterating elements that exist within the image in high detail can lead to reduced motion or unexpected results"; refer to people as "the subject".
- Seedance official: "Minimize Static Descriptions... focus on describing the moving parts"; formula "subject + movement, background + movement, camera + movement". Don't contradict source image.
- Kling: movement type/direction + pacing adverbs "gradually / suddenly / smoothly".
- Named failure mode: re-describing the frame → model re-imagines it (identity drift, palette shifts, frozen motion).
- Veo i2v: occasionally needs "maintain the style of the input image" (Replicate). Locked-POV: "No cuts, no zoom, natural head movement" keeps perspective locked (Higgsfield) [Single-source].
- → i2v enhancer needs a DIFFERENT recipe from t2v: strip appearance, keep motion + camera + pacing (+ audio).

### 4. Multi-shot / continuity craft
- Reference images are the primary tool now [Consensus]: Veo 3.1 ingredients (≤3 refs), Kling Elements/Omni Reference (≤7), Runway Gen-4 References. Multi-angle character sheets beat single portraits.
- Prompt-side anchor that works [Consensus]: frozen "character/product block" — identical descriptor text repeated WORD-FOR-WORD in every shot prompt, immutable traits first; only motion/camera/scene vary. "There is no memory across generations. Same face, same room, same light only happens because you wrote it identically each time and reused the reference image" (ugcvids.ai).
- Seed reuse is weak [Consensus]; references carry the heavy lift.
- Seedance is the native multi-shot model: 2–3 coherent cuts in one generation; number shots, give escalation arc (Higgsfield).

### 5. Dialogue & lip-sync
- Veo subtitle problem [Contested — biggest formatting schism]: folklore says COLON, no quotes: "A guy says: My name is Ben" — "quotation marks… showing the model written text — exactly what it tends to render on screen" (Replicate, snubroot). Google's own guide uses quotes. Both camps agree: append "(no subtitles)" / "no captions, no on-screen text"; repetition helps.
- Length [Consensus]: ~8s of speech per clip; too long → rushed; too short → gibberish. UGC calibration: 15–20 spoken words per 8s.
- Position [contested/single-source]: delivery cues adjacent to the line; ordering is model-version-sensitive.
- Sora 2: dialogue in a labeled block BELOW prose.
- Audio hallucination control (Veo) [Consensus]: always specify ambient/SFX/music or model invents them (laugh tracks); use "SFX:" and "Ambient noise:" labels.
- Kling/Seedance 1.x: no native dialogue audio — pipeline = ElevenLabs + lip-sync tools.

### 6. Negative-prompt reality check [Consensus]
| Model | Negatives | Practice |
|---|---|---|
| Kling | Dedicated field, keywords work | "blur, distort, low quality, cartoon, anime, text, watermark, deformed face, extra limbs" (pollo.ai) |
| Veo (API) | negativePrompt param; in-prompt "(no subtitles)" works | Describe unwanted positively in main prompt; community stack "subtitles, captions, watermark, on-screen text" |
| Runway Gen-4 | NONE; negations ignored or backfire | "steady shot," not "no shaking" |
| Seedance 1.0 Lite | "Negative prompts do not work" | Phrase positively |
| Wan | Field supported; default negative stack ships in reference code | Keep/extend default |
→ Negatives are a per-model ROUTING decision.

### 7. Prompt-length folklore vs evidence
- Sora 2 official articulation: shorter = more creative freedom; longer = restricts creativity, followed less reliably.
- Veo: detail rewarded; Google's rewriter expands prompts under 30 words (treats short as deficient).
- Kling: sweet spot 50–150 words (fal).
- Open models (CogVideoX, Hunyuan, Wan): trained on long dense captions — long rewritten prompts effectively mandatory.
- Published A/B evidence thin. [Consensus shape]: "longer is better" holds up to full slot coverage (~60–150 words closed video models), then over-stuffing causes instruction dropping/drift.

### 8. UGC-ad prompting craft (core use case)
- **PJ Ace (PJ Accetturo)** Kalshi NBA Finals ad ~$2K/2 days: script first with Gemini/ChatGPT, LLM converts every shot into a detailed Veo 3 prompt, only **5 prompts at a time** ("more than that and quality starts to slip"), each prompt fully self-contained "as if Veo 3 has no context of the shot before or after", ~300–400 generations for 15 usable clips. Hand-run "enhance prompt" pipeline — validates the feature.
- UGC prompt shape [Consensus]: one paragraph, fixed order — camera behavior → subject/framing → one physical product beat → spoken line → audio bed → negatives. (ugcvids.ai; LichAmnesia repo with "fidelity guard" clauses like "Bottle holds constant shape, fill level, and matte finish throughout—no deformation, drift, melting, or flicker").
- iPhone-shot authenticity anchors [Consensus]: "9:16 vertical phone-camera shot", "phone propped on counter, frame locked, no pans, no zooms", "handheld with slight natural shake", "natural window light, no studio lighting", "close conversational voice, faint room tone, no music", "slightly hurried, slightly amused delivery", "no color grading, slightly overexposed window".
- Formats with proven hook rates: unboxing + testimonial for cold traffic; street-interview vox-pop; car-vlog confessional; bathroom-mirror testimonial.
- Realism anchors beating AI gloss [Consensus]: "natural skin texture," "visible pores," "fine lines," "vellus hair (peach fuzz)," "subtle freckles," "practical lighting"; NEVER "perfect skin"/"8K ultra HD beauty"; negative-stack "cartoon, 3D render, doll, plastic" where field exists.
- Failure modes to engineer around [Consensus]: packaging text warps (hold label large + static, or cut to real product photo); fast hand actions degrade (one slow deliberate beat per clip); uninvited UI/captions (explicit negative "no on-screen text, no captions, no subtitles, no watermark, no stickers, no fake app interface").
- Industry: Icon "AdGPT" (product data + brand voice → scripts); Arcads script→AI-actor testimonials; 3.8–4.6x ROAS claim [Single-source, promotional].

### 9. Prompt libraries worth mining
- github.com/snubroot/Veo-3-Prompting-Guide (~289★) + Veo-3-Meta-Framework (~415★) — deepest Veo playbooks (8-component structure, selfie-video formulas, "(thats where the camera is)" trick).
- **github.com/LichAmnesia/awesome-ad-video-prompts (~153★, CC BY 4.0) — 52 ad prompts across 10 formats incl. UGC/unboxing/testimonial, timing beats, fidelity guards; most Magicbooklet-relevant repo.**
- github.com/cclank/lanshu-awesome-ai-video-kit — 433 prompts, 110 cross-model comparisons, 16 models.
- github.com/geekjourneyx/awesome-ai-video-prompts — curated official-guide index.
- OSideMedia/higgsfield-ai-prompt-skill, jnMetaCode/ai-shortfilm-prompts — packaged as Claude skills (DISCIPLINE framework, 21 genre templates).
- Official: Sora 2 cookbook guide; Replicate Veo series; BytePlus Seedance guide; Vchitect/RAPO (CVPR 2025 code).

## Part B — Audio models via Kie

### 10. ElevenLabs TTS Turbo 2.5 & Multilingual v2
- Pauses: `<break time="1.5s" />` most consistent on v2 family; cap ~3s; too many break tags → instability. Ellipses/dashes = softer hesitation.
- Pronunciation: phoneme tags (Arpabet/IPA) only on Flash v2/Turbo v2/English — NOT Multilingual v2 or Turbo 2.5; use alias respelling.
- Normalization: API has apply_text_normalization but **Kie does not expose it** → number/date/symbol expansion ("$4.99" → "four dollars ninety-nine") must happen in script text. Highest-value enhancer job for TTS.
- Emotion: no tags on these models; wording/punctuation/context only; narrative cues ("she said angrily") GET READ ALOUD — enhancer must NOT inject stage directions.
- Enhancer jobs: normalize numerals/abbreviations, punctuate pacing, sparse break tags, respell hard names, chunk long scripts using Kie's previous_text/next_text.

### 11. ElevenLabs Text-to-Dialogue v3 (eleven_v3)
- Audio tags, lowercase brackets, three families: voice ([whispers], [sarcastic], [excited], [crying], [laughs], [sighs]), SFX ([applause], [explosion], [gunshot]), experimental ([strong French accent], [sings]).
- Length: >250 chars — very short prompts inconsistent; longer text gives "better sense of the emotional arc".
- Punctuation is a control surface: ellipses = pauses/weight, CAPS = emphasis.
- Match tags to voice character ("Don't expect a whispering voice to suddenly shout with a [shout] tag").
- NO SSML: v3 rejects <break> — punctuation and tags instead.
- Multi-speaker: array of {text, voice} turns; matches prosody from tags. ElevenLabs' own UI ships an "Enhance" step adding tags/punctuation — first-party precedent.
- Stability: Kie exposes exactly 0 / 0.5 / 1 (Creative/Natural/Robust); Robust less responsive to tags.

### 12. ElevenLabs Sound Effects v2
- Prompt cap **450 chars**; understands natural language AND audio terminology (foley, whoosh, braam, impacts, ambience).
- Upgrade frame: "high-quality, professionally recorded footsteps on grass, sound effects foley".
- Sequences: generate individual effects and combine in editor, not one mega-prompt.
- duration_seconds 0.5–30 (else inferred); prompt_influence default ~0.3 (higher = more literal); looping blends end into beginning for ambience beds.
- Enhancer jobs: translate lay descriptions into audio vocabulary, add material/environment/dynamics ("metal door slam with reverb tail in a stairwell"), split multi-sound requests, set loop/duration from intent.

### 13. Kie endpoint facts (verified docs.kie.ai)
- text-to-speech-turbo-2-5 / multilingual-v2: `text` req **max 5,000 chars**, `voice` (~60-voice enum, default James), `stability` 0–1 (0.5), `similarity_boost` 0–1 (0.75), `style` 0–1 (0), `speed` 0.7–1.2, `timestamps`, `previous_text`/`next_text` (5,000 each, continuity), `language_code`. **No apply_text_normalization, no pronunciation dictionaries** → normalization is our job.
- text-to-dialogue-v3: `dialogue` array of {text, voice}; combined text ≤5,000 chars; `stability` ∈ {0, 0.5, 1.0}; language_code 50+; 65-voice enum.
- sound-effect-v2: `text`, `loop`, `prompt_influence`, `output_format`; upstream 450-char prompt, 0.5–30s duration.

## Part C — Measurable evidence prompt rewriting works
1. Google ships it FORCIBLY: Veo 3/3.1 Gemini rewriter cannot be turned off; disabling (Veo 2) "may impact quality"; rewritten prompt returned when input <30 words.
2. Wan 2.1/2.2: "Extending the prompts can effectively enrich the details... enhancing the video quality"; Qwen prompt extension officially "recommended" (Wan2.1 README).
3. CogVideoX: trained on long captions; ships convert_demo.py LLM-expander.
4. HunyuanVideo: fine-tuned rewriter, TWO MODES — Normal (intent fidelity) vs Master (composition/lighting/camera, "may occasionally result in the loss of some semantic details"). Ready-made design pattern: faithful vs cinematic enhance.
5. Prompt-A-Video (arXiv 2412.15156): preference-aligned rewriter; VBench +0.201 (Open-Sora 1.2), +0.067 (CogVideoX).
6. **VPO (ICCV 2025, arXiv 2503.20491): principle-guided optimizer; human-eval win rate +37.5% over raw user queries, +14% over the model's own official rewriter (CogVideoX); transfers across models.**
7. RAPO (CVPR 2025) / RAPO++ (arXiv 2510.20206): retrieval-augmented rewriting improves LaVie, Latte, HunyuanVideo, CogVideoX, Wan2.1 across VBench/T2V-CompBench/EvalCrafter.
8. Images: Microsoft Promptist (arXiv 2212.09611) — RL rewriter beats manual prompt engineering on SD; successor RePrompt (RL + reasoning).
9. Audio: ElevenLabs' own v3 "Enhance" workflow — shipped first-party enhancer.
Caveat: VPO beating the official rewriter by 14% shows naive "longer and prettier" rewriting is beatable; Hunyuan Master-mode warning documents the risk — aesthetic gain traded against semantic fidelity.

## Top 15 transferable rules
1. Rewrite raw prompts into full-slot structured prose — subject, action, setting, camera, lighting/style, audio (mechanism behind every provider rewriter + every published win).
2. Preserve user intent verbatim; add, don't replace — quoted dialogue, on-screen text, brand names, counts pass through untouched.
3. Offer/route two enhancement intensities — "faithful" vs "cinematic" (Hunyuan Normal/Master precedent).
4. I2V prompts describe motion only — strip appearance re-description, "the subject", pacing adverbs; never contradict the frame.
5. One camera clause from the standard lexicon — shot size + one named movement + optional lens, positively phrased; bracket enums on Hailuo-style models.
6. Negatives routed per model — field where exists (Kling, Veo API, Wan), converted to positives where not (Runway, Seedance); never "no X" inside a positive prompt.
7. Dialogue: name the speaker, format the line distinctly, cap speech to clip: ~8s / 15–20 words.
8. Specify the full soundscape or the model invents one — dialogue, ambient, SFX, music (or "no music") every time on audio-native models.
9. Continuity = frozen descriptor blocks + reference images — repeat character/product/set text word-for-word; each shot prompt self-contained.
10. Target the model's trained length band — ~60–150 words closed video models, long dense captions open models, >250 chars Eleven v3; don't pad past full slot coverage.
11. UGC ads follow the six-beat order — camera behavior → subject/framing → one product beat → spoken line → audio bed → negatives; one physical action per clip, label held still.
12. Authenticity via device/context anchors, not the word "authentic" — "9:16 vertical phone-camera," "phone propped, frame locked," "handheld slight natural shake," "natural window light," "room tone, no music."
13. Kill AI gloss by naming imperfections — "natural skin texture, visible pores, fine lines," never "perfect skin"; negative-stack "cartoon, 3D render, doll, plastic" where supported.
14. TTS enhancement = text normalization + punctuation, NOT stage directions — expand numbers/dates/symbols (Kie exposes no normalization param), sparse <break> tags on v2 family, respell hard names; emotion prose gets read aloud on non-v3.
15. v3/SFX enhancement = tags and audio vocabulary — sparse bracketed tags matched to voice, punctuation pacing, ≥250 chars; SFX translated into foley/production terms, one effect per generation, ≤450 chars.

Gotchas NOT to globalize: Hailuo bracket syntax, Seedance "Cut to" multi-shot, Runway negative-blindness, Eleven v3 SSML rejection.
