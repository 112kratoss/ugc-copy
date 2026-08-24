# Prompt-Engineering Research: Google-Family Models on Kie.ai (2026-08-24)

App-side grounding: confirmed against config/generation-model-catalog/releases/2026-08-16-*.json; Kie specs against model_api_references/ (note: veo-3-1.md is stale — live docs supersede on duration/resolution/lite).

Identity mapping (confirmed via Google docs): **nano-banana-2-lite** = gemini-3.1-flash-lite-image, **nano-banana-2** = gemini-3.1-flash-image, **nano-banana-pro** = gemini-3-pro-image, **gemini-omni-video** = gemini-omni-flash-preview, **veo-3.1** variants = veo-3.1-{generate|fast-generate|lite-generate}-preview.

---

## veo-3.1

**Official guidance** (ai.google.dev/gemini-api/docs/veo, cloud.google.com/blog/.../ultimate-prompting-guide-for-veo-3-1)
- Five-part formula, in order: **[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]** — prose, not keywords. Element list: Subject, Action, Style, Camera positioning & motion, Composition, Focus & lens effects, Ambiance.
- Camera vocabulary trained on: dolly shot, tracking shot, crane shot, aerial view, slow pan, POV, zoom; composition: wide shot, close-up, extreme close-up, low angle, two-shot; lens: shallow depth of field, wide-angle, macro, soft focus, deep focus.
- Dialogue: quotes attributed to a speaker — "A woman says, 'We have to leave now.'" Sound effects with `SFX:` prefix; ambient with `Ambient noise:`; music as a score cue.
- Multi-beat via timestamp prompting: `[00:00-00:02] Medium shot... [00:02-00:04] ...` — official, Google's structured alternative to JSON.
- Negative guidance: describe exclusions positively — "'a desolate landscape with no buildings or roads' instead of 'no man-made structures'".
- I2V: single image = first frame (prompt = motion/audio, not the image); first+last = "describe the transition and audio"; "Ingredients to Video" = up to 3 referenceImages of person/character/product, prompt names them.
- Hard limits (Gemini API): prompt **1,024 tokens**; durations 4/6/8s (8s mandatory at 1080p/4K and with reference images); 720p/1080p/4K; 16:9 or 9:16; audio always generated; seed non-deterministic.
- **Prompt rewriter always on, cannot be disabled for Veo 3/3.1** (docs.cloud.google.com/vertex-ai/generative-ai/docs/video/turn-the-prompt-rewriter-off); rewritten prompt returned only when input under ~30 words.

**Kie endpoint facts** (docs.kie.ai/veo3-api/generate-veo-3-video)
- Legacy endpoint POST /api/v1/veo/generate. model: veo3 (Quality), veo3_fast, veo3_lite. generationType: TEXT_2_VIDEO, FIRST_AND_LAST_FRAMES_2_VIDEO (1–2 imageUrls), REFERENCE_2_VIDEO (1–3 images, **fast and lite only**, 8s only). Auto-detected if omitted.
- aspect_ratio 16:9|9:16|Auto; resolution 720p/1080p/4k (4K ≈ 2x credits); duration 4/6/8 (default 8); seeds 10000–99999; watermark; enableTranslation (auto-translates to English — Kie's only server-side mutation); **no negativePrompt param**; no documented prompt cap (assume 1,024 tokens downstream).
- Kie routes via Flow ("rejected by Flow" errors), audio on by default.

**Community consensus & tricks**
- Dialogue divergence: colon format — `The detective looks at camera and says: Something's not right here.` — plus literal `(no subtitles)` is the widely-repeated subtitle-suppression recipe (replicate.com/blog/using-and-prompting-veo-3, github.com/snubroot/Veo-3-Prompting-Guide); official uses quotes. Neither 100% reliable; colon+no-subtitles has larger anecdotal base; short lines (speakable in ~5–7s) matter more.
- Always specify the ambient bed — unspecified audio invites hallucinated laughter/music.
- I2V: "The image already defines subject, setting, composition, style... Your prompt adds life through motion and sound"; state camera movement explicitly or it defaults to static/subtle handheld (dreamhost.com/blog/veo-3-1-prompt-guide).
- Failure modes: multi-subject scenes, overstuffed first attempts, conflicting camera instructions, dialogue too long → rushed speech.
- **JSON prompting**: promoted by SEO blogs, no official endorsement — "Structure matters, but format is flexible. I don't believe JSON is a magic key" (creativepossible.substack.com/p/should-you-prompt-in-json); JSON's benefit is forced completeness, not syntax; burns the 1,024-token budget.

**Recommended prompt template** (prose, ~60–150 words)
```
[Shot & camera: "Medium tracking shot, shallow depth of field,"]
[Subject: one primary character/product with 3-5 concrete attributes,]
[Action: what they do across the 8 seconds,]
[Context: setting, time, background detail,]
[Style & ambiance: film style, lighting, color, mood.]
[Speaker] says: [short line under ~15 words]. (no subtitles)
SFX: [1-2 specific effects]. Ambient noise: [environment bed]. [Optional music cue.]
```
Multi-beat: `[00:00-00:02] ...` blocks each with own SFX. I2V/frames/references: camera path + motion + audio + transition, never re-description.

**Enhancer recipe**
1. Flowing prose, order camera → subject → action → context → style/ambiance; never keyword lists, never JSON.
2. One primary subject; demote everything else to background.
3. Exactly one camera-movement term + one framing term from official vocabulary; never conflicting movements.
4. Name lighting and mood explicitly.
5. Always write an audio block: dialogue, then SFX:, then Ambient noise: — silence is never specified by omission.
6. Speech as `<speaker> says: <line>` + `(no subtitles)`; cap ~15 words per 8s; give a voice/tone descriptor.
7. Express exclusions positively; no negative-prompt field on Kie.
8. Start frame supplied → only motion, camera, audio; no restating image content.
9. First+last frames → narrate the transition and its sound.
10. Reference mode (fast/lite only): "Using the provided images of the [product]..." + new scene with action.
11. 60–150 words (ceiling ~1,024 tokens); timestamp beats for sequences.
12. Write English always (set enableTranslation explicitly).
13. No aspect ratio/resolution/duration/watermark in text — API params.
14. Don't over-polish: server-side rewriter always runs; enhancer's job is structure + slot-filling (camera/audio/lighting), not padding — padding gives the rewriter more to mangle.

**Confidence & gaps**: High on official structure/params/rewriter. Medium on colon-vs-quotes. Unknown: Kie Flow seeds semantics, exact Kie prompt cap. enableTranslation default inconsistent — set explicitly.

---

## gemini-omni-video (Gemini Omni Flash)

**Official guidance** (ai.google.dev/gemini-api/docs/omni)
- gemini-omni-flash-preview: multimodal video gen/editing, preview; conversational stateful editing; world knowledge. 16:9 default, 9:16.
- "Write prompts with details like scene description, camera movement, lighting and mood." **By default invents multi-shot narratives** — force one shot with "In a single unbroken scene", "single continuous shot", "No scene cuts".
- Reference tags core mechanism: `<FIRST_FRAME>` marks start frame; `<IMAGE_REF_N>` (zero-indexed) inline ("in the style of <IMAGE_REF_0> a woman <IMAGE_REF_1> is walking"); explicit declarations: `[# Sources <FIRST_FRAME>@Image1] [# References <IMAGE_REF_0>@Image2]`.
- Editing: "Simple prompts work best"; one change + **"Keep everything else the same"**.
- Audio in prompt prose ("Include calm background music"); negatives in prose ("No dialogue") — "negative prompts are not supported (put negatives in the regular prompt)"; no seed/temperature/system instructions.
- Timing: natural language ("After 3 seconds...") or timecode blocks `[0-3s] ...`; in-video text rendering supported, word-by-word reveals work.
- Limits: video references ≤3s not correctly processed; one video max; voice editing unsupported.

**Kie endpoint facts** (docs.kie.ai/market/gemini-omni-video)
- Jobs API, model gemini-omni-video. prompt **max 20,000 chars**. image_urls ≤7 (20MB); video_list ≤1 (100MB, ≤30s source, trimmed ≤10s); character_ids ≤3 (from gemini-omni-character); audio_ids ≤3; weighted quota images×1+videos×2+characters×1 ≤ 7. duration "4"/"6"/"8"/"10" (auto with video input); aspect_ratio 16:9|9:16; resolution 720p/1080p/4k; seed.
- Kie doesn't document tag handling; images passed as ordered array → <IMAGE_REF_N> should follow image_urls order (UNVERIFIED).

**Community consensus & tricks** (openart.ai/blog/gemini-omni-flash-prompt-guide, freepixel.com, xda-developers.com)
- Six-dimension frame: shot framing/motion, style, lighting, location, action, text rendering — covering all six consistently produces best outputs.
- "Camera vocabulary matters... 'oner,' 'locked off,' 'push in,' 'dolly zoom,' 'orbit' function as technical commands."
- "It infers better than it imagines" — references beat adjectives; restraint wins; name the "primary focus of the clip".
- "Quality depends more on prompt structure than length or detail."

**Recommended prompt template**
```
[Single continuous shot | multi-shot allowed]. [Camera term + framing].
<FIRST_FRAME> [only if start-frame intended]
[Subject — or "the character <IMAGE_REF_0>"], [action with timing], in [location/lighting/mood], [style].
Audio: [music/ambient]. [No dialogue / dialogue text].
[On-screen text: 'EXACT TEXT' if wanted.] Keep [X] as the primary focus.
```
Edit turns (video input): "[One change]. Keep everything else the same."

**Enhancer recipe**
1. Decide shot mode first: unless montage requested, prepend "In a single unbroken scene".
2. Cover all six dimensions briefly; structure over length.
3. Precise camera commands; one movement per shot.
4. Bind attached images with tags: <FIRST_FRAME> for start frame, <IMAGE_REF_N> in upload-array order, referenced inside the sentence where used.
5. Reference video attached → edit instruction, not scene description: one change + "Keep everything else the same."
6. Always describe soundtrack in prose; state "No dialogue" when none wanted.
7. Negatives in prose; no negative-prompt field.
8. Timing syntax for beats matched to chosen duration.
9. Quote exact on-screen text; list words in order for reveals.
10. One primary subject; characters attached → refer by character_name, don't re-describe.
11. Don't re-describe attached imagery; describe what changes/moves.
12. Compact — a few sentences.
13. Never aspect ratio/resolution/duration in text.

**Confidence & gaps**: High on official tag syntax + Kie params. Medium on community advice (young model). UNVERIFIED: Kie preserving <IMAGE_REF_N> ordering and [# Sources] declarations — one live A/B before hard-coding tags; character_ids name-referencing undocumented.

---

## nano-banana-2-lite (Gemini 3.1 Flash-Lite Image)

**Official guidance** (ai.google.dev/gemini-api/docs/image-generation)
- Fastest/cheapest velocity tier; 1K only; same family prompting principles; thinking minimal; no search grounding.

**Kie endpoint facts** (docs.kie.ai/market/google/nano-banana-2-lite)
- Up to **10** reference images, ARs incl. extreme banners (1:4, 4:1, 1:8, 8:1, 21:9) + auto, **1K only**, no google_search. Prompt cap 20,000 chars.

**Community**: draft/batch tier — iterate here, re-run winner on NB2/Pro at 2K/4K (fal.ai tiering logic).

**Enhancer recipe**: NB2 recipe with three deltas: (1) never reference Google Search/live data; (2) modest text asks (short labels — 1K limits legibility); (3) bias shorter — complex multi-constraint briefs are Pro territory.

**Confidence & gaps**: High on params. Low on lite-specific lore (treat NB2 guidance as transferable).

---

## nano-banana-2 (Gemini 3.1 Flash Image)

**Official guidance** (ai.google.dev/gemini-api/docs/image-generation, cloud blog ultimate-prompting-guide-for-nano-banana)
- Verbatim principles: "Be specific: concrete details on subject, lighting, composition"; "Use positive framing ('empty street' not 'no cars')"; "Control the camera: 'low angle', 'aerial view'"; "Iterate with follow-ups"; "Start with a strong verb declaring the primary operation."
- T2I formula: **[Subject] + [Action] + [Location/context] + [Composition] + [Style]**. With refs: **[Reference images] + [Relationship instruction] + [New scenario]**.
- Editing: semantic masking in words — "change only the [element] to [new element]"; explicit about what to keep.
- Text rendering: exact copy in quotes, describe font, "text-first hack" (agree text, then image). Translation/localization of in-image text supported.
- Search grounding formula: **[Search request] + [analytical task] + [visual translation]**.
- Specs: 131,072 input tokens; 1K/2K/4K; extended ARs incl. 1:8/8:1; up to 14 refs; controllable thinking; video-to-image; Google Search grounding.

**Kie endpoint facts** (docs.kie.ai/market/google/nanobanana2)
- prompt **max 20,000 chars**; image_input ≤14 (30MB); aspect_ratio 15 options incl. auto (follows input on edits); google_search bool (default false); resolution 1K/2K/4K; output_format jpg/png.

**Community consensus & tricks** (masonry.so/blog/nano-banana-2-guide, fal.ai/learn/tools/how-to-use-nano-banana-2)
- "Drop comma-tag lists and 'masterpiece' boosters" — reasoning model, parses instructions, plans composition.
- Thinking on for complex compositions/text; off for speed.
- Search grounding is the differentiator — instruct explicitly ("Search for X, then...").
- Aesthetic shorthand works ("1960s aesthetic" → film grain, desaturated palette).

**Recommended prompt template**
```
[Strong verb: Create/Edit/Combine/Transform] a [style] of [subject, 3-6 attributes] [action],
in [location, time]. [Composition: framing, angle, lens, f-stop]. [Lighting + grade]. [Texture/material].
[If text: contains the text "EXACT COPY" in a (font) at (position).]
[If refs: Using the attached <name> as (structure|style|subject); keep (features) exactly the same.]
[If grounding: Search for (fact) and reflect it by (visual consequence).]
```

**Enhancer recipe**
1. Narrative scene description opening with a strong operation verb.
2. Five slots — subject, action, location, composition, style — in order; one paragraph, no tags.
3. Every negative → positive framing; no negative-prompt field.
4. Camera like a photographer: angle, framing, lens/focal length, aperture/DOF.
5. Concrete lighting + color grade.
6. Generic nouns → materials.
7. In-image text in double quotes verbatim + font/style + placement; never paraphrase user copy.
8. Edits: single change + "Keep everything else exactly the same — style, lighting, composition."
9. References: assign each a role using the app's reference names.
10. Mention Google Search only when toggle is on; then search → analysis → visual consequence.
11. No AR/resolution in text; may reinforce composition words consistent with ratio.
12. 50–150 words sweet spot; 20k cap is for pasted source text, not descriptions.
13. Preserve user-supplied source text blocks verbatim.

**Confidence & gaps**: High — official + Kie + community agree. Minor: Kie thinking-mode default not exposed.

---

## nano-banana-pro (Gemini 3 Pro Image)

**Official guidance** (blog.google prompting-tips-nano-banana-pro, cloud blog)
- Seven tips: incredible text rendering (posters, diagrams, mockups); real-world knowledge/reasoning; translate & localize in-image text; studio-quality edits (lighting, camera, color grading); precise resize (1K/2K/4K); blend "6 to 14 unconnected images" with character consistency (up to 5 people); brand look-and-feel ("drape patterns, logos, artwork onto 3D objects").
- Five elements: Subject, Composition, Action, Location, Style. Edits: "Be direct and specific."
- "Creative director" controls: "low-angle shot with shallow DOF (f/1.8)", camera hardware ("shot on Fujifilm", "disposable camera flash aesthetic"), film stock/grade, per-line typography ("'GLOW' in flowing Brush Script... '10% OFF' in heavy blocky Impact"), translation of in-image text.
- 65,536 input tokens; thinking always on.

**Kie endpoint facts** (model_api_references/nano-banana-pro.md, kie.ai/nano-banana)
- prompt max 20,000 chars; image_input **≤8 on Kie** (Google takes 14); aspect_ratio 11 options; resolution 1K/2K/4K; output png/jpg. **No google_search on Kie's Pro endpoint** despite model support — Kie surface limitation.

**Community consensus & tricks** (imagine.art, dev.to/googleai, techradar)
- Best-in-class text rendering; ask it to "compress" dense text into infographics; specify register ("polished editorial", "technical diagram", "hand-drawn whiteboard").
- Treat prompts as design briefs: long, layered, multi-constraint is where Pro beats NB2; NB2 for iteration, Pro for hero assets.
- Holds ~5 identities across composites; describe each person's role, not appearance, when reference attached.

**Recommended prompt template**
```
Create a [deliverable] in [style register].
Subject: [product/person + material detail]. Action/staging. Location.
Composition: [framing, angle, lens, f-stop]. Lighting: [setup]. Grade: [film/color].
Text layout: top line "EXACT HEADLINE" in [font]; below "EXACT SUBCOPY" in [font]; [position/color/size].
[Localize text into <language> if asked.]
[Refs: image 1 = product, image 2 = model, image 3 = brand style; keep faces and logo exactly.]
```

**Enhancer recipe**
1. Structured design brief in prose — Pro rewards layered multi-constraint prompts.
2. Five elements + three studio layers: lighting setup, camera/lens/f-stop, color grade/film stock.
3. Quote every in-image text verbatim; per-line font/weight/placement; never invent copy.
4. Multilingual: name source/target languages, "translate the text inside the image", quoted source intact.
5. Infographics: state factual constraints/data explicitly + visual register.
6. Role per attached reference by app-given name; state what must be preserved pixel-faithfully.
7. Negatives → positive framing.
8. Materiality over adjectives.
9. Edits: one imperative + "keep everything else the same"; brand work: "apply the attached artwork onto [object], following its curvature and lighting".
10. No AR/resolution in text; do reason about layout for the ratio ("leave clear space at top for headline" on 9:16).
11. Never reference more than 8 images (Kie cap).
12. 100–300 words is normal — a feature, not a smell.

**Confidence & gaps**: High. Gaps: Kie 8-image cap vs Google 14; search grounding absent on Kie Pro.

---

## imagen-4 / imagen-4-fast / imagen-4-ultra

**Official guidance** (ai.google.dev/gemini-api/docs/imagen)
- Model IDs imagen-4.0-{generate|fast-generate|ultra-generate}-001. Prompt cap **480 tokens, English only**; 1K/2K; AR 1:1, 3:4, 4:3, 9:16, 16:9; 1–4 images; personGeneration; **no negativePrompt** ("unsupported since imagen-3.0-generate-002").
- Prompt = **subject + context + style**, then iterate.
- Text in images: "Limit text to 25 characters or less"; ≤3 phrases; general font style only; approximate placement.
- Keyword-friendly: quality modifiers ("high-quality", "4K", "HDR", "studio photo"), photography modifiers (close-up, aerial, from below; lighting; motion blur/bokeh; 35mm/50mm/fisheye/macro; black-and-white, polaroid), art movements.
- Photorealism cheat-sheet: portraits → prime/zoom 24–35mm, film noir, DOF; objects → macro 60–105mm, controlled lighting; motion → telephoto 100–400mm, fast shutter; landscape → wide-angle 10–24mm, long exposure.
- **Deprecation: Imagen API slated for shutdown 2026-08-17** (docs sunset note; ud.hk article); recommended replacement gemini-3.1-flash-image.

**Kie endpoint facts** (docs.kie.ai/market/google/imagen4)
- model "google/imagen4" (fast/ultra same family). prompt **max 5,000 chars**; **negative_prompt max 5,000 chars** — exposed by Kie even though Google dropped it upstream, real effect UNVERIFIED; aspect_ratio 1:1 default, 16:9, 9:16, 3:4, 4:3, auto; seed. App: prompt-only, 1K.

**Community consensus & tricks** (atlabs.ai/blog/imagen-4-prompting-guide, medium charmichokshi)
- "Structured sentences" but flexible: full sentences for control + appended comma-separated modifier tail — i.e., caption + keyword tail, unlike nano-banana's pure narrative.
- Start photoreal with "A photo of..."; cap with quality markers ("photorealistic, 8K, natural film grain, HDR") — "act like a quality slider".
- Short = more model freedom. No conversational editing, no references, one-shot captions only.

**Recommended prompt template**
```
A [photo | watercolor illustration | 3D render] of [subject, 2-4 attributes] [action],
[context], [composition & camera: close-up, low angle, 35mm, bokeh], [lighting], [style/film],
[quality tail: high-quality, detailed, HDR].
[Optional: with the text "MAX 25 CHARS" in a bold sans-serif style]
```

**Enhancer recipe**
1. One caption-style sentence (or two), front-loaded "A photo of / An illustration of" declaring medium first.
2. Subject → context → style, then comma-separated modifier tail (camera, lens, lighting, film, quality words) — keyword tails correct here, unlike nano-banana.
3. Lens/focal length from photorealism cheat-sheet per use case.
4. Compact: well under 480 tokens (30–80 words typical) — Kie's 5,000-char field exceeds what the model accepts.
5. English only — translate.
6. In-image text: 1–3 phrases ≤25 chars each, quoted, generic font hint; steer bigger text jobs to nano-banana-pro.
7. negative_prompt: plain nouns without "no" ("blurry, watermark, text, extra fingers") — best-effort; also imply exclusions positively.
8. Never instructions/conversation — describe the final image only.
9. No references exist: fully self-contained; never "the attached image".
10. Explicit AR param, not auto, for production.
11. fast vs ultra: same prompt; trim modifiers for fast, full tail for ultra.
12. Iterate by appending detail, not rewholesale.

**Confidence & gaps**: High on style (sentence + keyword tail, distinct from nano-banana). **MAJOR: Google sunset Imagen 4 API 2026-08-17 — a week before today — yet Kie still lists/serves. Live-test imagen-4-* soon; plan migration to nano-banana-2.** negative_prompt efficacy unverified.

---

## Cross-cutting Google findings

- **A server-side rewriter already exists for Veo — design the enhancer as its collaborator.** Veo 3/3.1 always LLM-rewrites, cannot be disabled; short prompts get invented detail. App enhancer's value = slot-filling + disambiguation (camera, audio, lighting, single subject), not creative padding. Gemini image models "think" in-model; Imagen has no rewrite; Kie's only mutation is Veo enableTranslation → output English everywhere, set translation explicitly.
- **Prose beats formats everywhere; JSON is community fashion, not Google recommendation.** Official structured alternatives are timestamp/timecode blocks. Consensus converging: "the completeness JSON forces is what helps, not the syntax."
- **Positive framing family-wide.** Negative fields only on Kie imagen4 (dubious).
- **AR, resolution, duration are params, never prompt text**; prompt only reinforces composition semantics.
- **Camera language is a real control surface** across all six — one shared cinematography lexicon transfers.
- **Text-in-image divergence**: nano-banana-pro (long, exact, multilingual, per-line typography) > nano-banana-2 (quoted short copy, fonts) > imagen-4 (≤25 chars, ≤3 phrases) — scale text ambition per model.
- **Reference-binding syntax differs per model**: Omni = <FIRST_FRAME>/<IMAGE_REF_N> tags; Veo = "using the provided images of X" prose; nano-banana = role-assignment sentences with app reference names; imagen = none.
- **Prompt budgets differ by an order of magnitude**: Veo ~1,024 tokens; Imagen 480 tokens; nano-banana/omni 20k chars on Kie. Sweet spots: Veo 60–150 words, Omni a few structured sentences, NB2 50–150, NB Pro 100–300, Imagen 30–80.
- **Policy behaviors not to fight**: SynthID watermark; person-generation restrictions (avoid naming real people or minors); audio always generated by Veo/Omni → silence must be specified as ambience.
- **Catalog drift live risk**: Imagen-4 upstream sunset already happened; local veo-3-1.md lags live Kie spec; re-verify against docs.kie.ai before shipping enhancer rules.

Key sources: ai.google.dev/gemini-api/docs/{veo,omni,image-generation,imagen} · cloud.google.com Veo 3.1 + Nano Banana prompting guides · blog.google nano-banana-pro tips · docs.kie.ai/veo3-api + /market/gemini-omni-video + /market/google/imagen4 + /market/google/nanobanana2 · replicate.com/blog/veo-3-1 · github.com/snubroot/Veo-3-Prompting-Guide · dreamhost.com veo-3-1-prompt-guide · creativepossible.substack.com JSON piece · xda-developers Omni tricks · fal.ai NB tiering · masonry.so NB2 guide · atlabs.ai imagen-4 guide
