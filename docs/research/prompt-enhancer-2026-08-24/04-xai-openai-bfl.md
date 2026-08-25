# Prompt-Enhancement Research: xAI / OpenAI / BFL models (Kie.ai endpoints)

Researched 2026-08-24. App-side facts verified against models.ts, generation-services.ts, model_api_references/; provider facts against docs.kie.ai, docs.x.ai, developers.openai.com, docs.bfl.ai. Note: the app's enhancer currently aliases `grok-imagine-image-2` to the `grok-imagine-image` profile (prompt-enhancer.ts:329) — findings below say these two want **different** prompt styles.

---

## grok-imagine-image (xAI, via `grok-imagine/text-to-image` + `grok-imagine/image-to-image`)

**Official guidance**
- xAI's Imagine docs are param-focused, essentially no prompting guide: gen "from text prompts," edit by "describe the change you want Grok Imagine to apply," up to 3 source images per edit on xAI's own API (docs.x.ai/developers/model-capabilities/imagine, .../images/editing).
- Only official edit example: "Render this as a pencil sketch with detailed shading"; chaining edits output→input is the recommended iteration loop.
- xAI positions v1 as "bold, stylized output" vs 2.0 as the "precision release" (x.ai/news/grok-imagine-image-2).

**Kie endpoint facts** (docs.kie.ai/market/grok-imagine/text-to-image, .../image-to-image)
- T2I: `prompt` required, **max 5000 chars**; `aspect_ratio` ∈ 2:3|3:2|1:1|9:16|16:9 (default 3:2); `enable_pro` boolean. **Multi-output: 4 credits → 6 images (standard), 5 credits → 4 images (pro/quality).** Kie's own default prompt is ~55 words of cinematic prose.
- I2I: `image_urls` required, **max 1 image** (10MB); prompt optional; reference via `@image1` syntax per Kie docs; **no aspect_ratio or enable_pro in edit mode** (app drops both — generation-services.ts:1687-1692). 4 credits → 2 images. `nsfw_checker` sent true.
- App exposes: 1K only, quality modes standard/quality, maxImages 1.

**Community consensus & tricks**
- Sweet spot **30–80 words of plain prose**, "briefing a photographer"; under 30 leaves gaps, over 80 dilutes (pxz.ai/blog/best-grok-imagine-prompts, seaart.ai/blog/grok-imagine-prompts).
- **No negative prompts — ignored entirely**; convert to positives.
- Photorealism: open with "Photorealistic photograph of… / Candid DSLR photo of…", name a real camera+lens ("Sony A7R V, 85mm f/1.2"), add imperfections ("visible skin texture and pores," "slight film grain," "natural window light").
- Keyword stacking underperforms natural sentences; v1 has strong stylized/cinematic aesthetic bias.

**Recommended prompt template** (T2I)
```
[Photorealistic photograph | <medium>] of <subject with 2-3 concrete attributes>, <action/pose>,
<setting>, <one lighting clause: direction + quality + temperature>,
<camera: body, lens, aperture>, <mood/style tag>, <color notes>.
```
Edit (I2I): `<one imperative change>. Keep <face/pose/background/lighting/composition> exactly as in @image1.`

**Enhancer recipe**
1. Rewrite into flowing prose sentences, 30–80 words; never comma-tag lists.
2. Put the subject in the first 5 words; style and context after.
3. Strip all negatives; restate as positive states ("no blur" → "sharp focus").
4. For realism intent, inject one camera/lens/aperture clause and one imperfection cue (skin texture, grain).
5. Exactly one lighting clause (direction + softness + temperature) — never several competing ones.
6. Text in image: put exact copy in double quotes with a simple placement — but keep expectations low; steer text-heavy jobs to image-2/flux instead.
7. Edit mode: one change per prompt, imperative voice, then an explicit keep-list ("keep everything else exactly the same"); do NOT re-describe the whole image.
8. Never emit aspect-ratio words in edit mode (param doesn't exist there); in T2I don't write ratios into the prompt — the `aspect_ratio` param handles it.
9. 6 (or 4) images come back per call — favor a single clear concept over hedged multi-concept prompts.
10. Don't add "8k, masterpiece, trending" quality spam.
11. Keep output ≤5000 chars (practically ≤600).

**Confidence & gaps**: High on Kie params. Medium on community consensus (SEO-blog heavy; consistent). Gap: no official xAI prompting guide exists.

---

## grok-imagine-image-2 (xAI Imagine Image 2.0, via `grok-imagine-image-2-0/text-to-image`)

**Official guidance** (x.ai/news/grok-imagine-image-2)
- "Follows instructions closely, down to the details"; "plans typography and layout the way a designer would"; "dense, multi-part visuals hold together and small text comes out sharp"; "preserves what you put in across generations and edits."
- A prompt with "a subject, a layout, exact wording, and a lighting note comes back with all four honored" — built for dense, multi-part briefs.
- Official example prompt: "A concert poster for a synthwave band, bold retro typography, sharp small print."
- xAI API (not Kie) offers: up to 5 reference images, region-precise edits, Smart Resize, quality low|medium, 1k/2k, many ratios incl. auto. #2 on both t2i and editing Arena leaderboards at launch.

**Kie endpoint facts** (docs.kie.ai/market/grok-imagine-image-2-0/text-to-image)
- `prompt` required (no documented max — treat 5000 as safe); `aspect_ratio` ∈ 1:1|2:3|3:2|16:9|9:16 (default 1:1). No quality/resolution/nsfw params exposed. **Text-to-image only in our app**: Kie's 2.0 edit variant keys off a prior Kie `task_id`, not an uploaded image, so maxImages: 0. 4 credits, 1K.

**Community consensus & tricks** (morphic.com/resources/how-to/grok-imagine-image-2-guide, omniart.studio/blog/models-insights/grok-imagine-image-2-what-shipped)
- "**Write a brief, not a caption.** Subject, layout, exact words, style, light."
- Exact on-image text in quotes renders "as written"; describe hierarchy structurally ("Headline across the top third," "five numbered steps down the left side").
- Worked example: "A recipe card for lemon shortbread. Title 'LEMON SHORTBREAD' across the top in a serif, five numbered steps down the left side with short captions, a finished biscuit photo lower right. Cream background, thin rule lines, soft even light. Flat, printable, no clutter."
- Failure modes: vague text instructions without quotes; bundled multi-edits.

**Recommended prompt template**
```
<deliverable type: poster/ad/card/UI frame> for <subject/brand>.
Layout: <zone-by-zone placement — top third / lower right / caption band>.
Text: "<EXACT COPY>" in <font style, weight, size role>; "<secondary copy>" <placement>.
Style: <aesthetic + palette>. Light: <one lighting clause>.
```

**Enhancer recipe**
1. Rewrite as a **design brief**, not a scene caption — key difference from v1.
2. Order: deliverable + subject → layout zones → exact text → style → lighting.
3. Every piece of on-image copy in double quotes, verbatim, with placement and a type-style word.
4. Preserve the user's exact wording character-for-character; never paraphrase quoted copy.
5. Specify hierarchy explicitly (headline / subhead / small print).
6. Keep dense briefs — this model rewards multi-part specificity where v1 punished it; every clause concrete.
7. Still no negatives — describe the clean state (prefer "generous whitespace" over "no clutter").
8. Do not reference uploaded images — this route has none; strip "like the reference" language or route to a reference-capable model.
9. Don't write aspect ratio into the prompt.
10. One lighting clause; hex-code colors unverified — prefer named palette words.
11. For photorealism, v1-style camera language still helps, but the edge is design/typography — lean composition-first.

**Confidence & gaps**: High on positioning/typography (official + consistent secondary). Medium-low on prompt-length limit and output count per Kie task. Flag: enhancer alias to v1's profile is a misfit.

---

## grok-imagine-video (xAI, via `grok-imagine/text-to-video` + `grok-imagine/image-to-video`)

**Official guidance** (docs.x.ai/developers/model-capabilities/video/generation)
- Model `grok-imagine-video-1.5`; xAI-native duration 1–15s; **"Generated videos include an audio track by default."** No official prompting tips.
- I2V: "provide a source image along with an optional prompt; the model animates the image content based on your instructions."

**Kie endpoint facts** (docs.kie.ai/market/grok-imagine/text-to-video, .../image-to-video; models.ts:753-779)
- T2V: `prompt` required, **max 5000 chars, English only** per Kie; `mode` ∈ fun|normal|spicy (default normal); `duration` **6–30s step 1**; `resolution` 480p|720p (default 480p); `aspect_ratio` 2:3(default)|3:2|1:1|9:16|16:9; `nsfw_checker`. 1.6 cr/sec (480p), 3 cr/sec (720p).
- I2V: one image via `image_urls` **or** `task_id`+`index` from a prior Grok image task — never both. **Spicy unsupported with external images (silently switches to normal).** `aspect_ratio` ignored when an image is supplied.
- Kie mode glosses: fun = "more creative and playful interpretation"; normal = "balanced"; spicy = "more dynamic and intense motion" (on consumer Grok also the NSFW-leaning mode — moderation-relevant).
- **App exposes only normal|fun, durations 6|10|15|30, 480p|720p, and `supportsSound: false`** (no sound toggle — but output MP4s still carry native audio; Kie: prompts "can include ambient sound, music direction, sound effects, or short dialogue cues").

**Community consensus & tricks** (help.scenario.com grok guide, funwithai.in, grokimagineai.net/prompt-guide)
- Structure: **open with subject + action + ONE camera move (20–30 words), develop with strong verbs, close with an AUDIO block.** "Stacking moves muddies the result."
- Audio: **dialogue in quotation marks for lip-sync**; list SFX and ambience explicitly; write **"no music"** when clean audio wanted (audio auto-injected otherwise). "T2V handles lip-sync better than a locked first frame."
- I2V: "**describe only what changes**" — never restate what the image shows; busy multi-subject stills reduce control.
- Strong kinetic verbs beat adjectives; 10s+ gives motion and audio room; one action per prompt.

**Recommended prompt template**
```
T2V: <subject> <strong action verb phrase> in <setting>, <one camera move>,
<style + lighting>, <mood>.
Audio: "<spoken line if any>" — <SFX list>, <ambience>, no music.

I2V: <what moves/changes>: <subject's action>, <one camera move>, <atmosphere evolution>.
Audio: <SFX/ambience or "no music">.
```

**Enhancer recipe**
1. Always output English (Kie constraint).
2. Lead with subject + one concrete action, kinetic verb; one action beat per ~6s of duration — for 30s, a simple progression, not ten events.
3. Exactly ONE camera move per clip; name it precisely.
4. Always append an Audio line: quoted dialogue for lip-sync, explicit SFX/ambience, and "no music" unless music wanted — silence on audio yields random music.
5. I2V: delete all appearance re-description; keep only motion, camera, atmosphere, audio.
6. Dialogue under ~10 words per 6s; prefer T2V when dialogue is the point.
7. Don't mention duration, resolution, mode, or aspect ratio in prompt text (ratio ignored in I2V anyway).
8. Mode is a param — never write "spicy mode" into the prompt.
9. No negative prompts; phrase avoidances positively.
10. Avoid multi-subject choreography; one or two subjects max.
11. Keep total under ~120 words; front-load.

**Confidence & gaps**: High on Kie params + audio-in-output. Medium on structure (4+ community guides agree, none official). Gap: how Kie achieves 16–30s vs xAI's native 15s cap (likely internal extension — drift risk at 30s unverified).

---

## gpt-image-2 (OpenAI, via `gpt-image-2-text-to-image` + `gpt-image-2-image-to-image`)

**Official guidance** (developers.openai.com/api/docs/guides/image-generation, cookbook image-gen prompting guide)
- **The model rewrites prompts internally**: "GPT Image 2 automatically revises prompts for improved performance" (`revised_prompt` via Responses API — Kie won't surface it).
- Cookbook ordering: "**background/scene → subject → key details → constraints**," plus "state the intended use" (ad / UI mockup / infographic); "short labeled segments or line breaks instead of one long paragraph."
- Editing: "**change only X**" + "**keep everything else the same**"; "**repeat the preserve list on each iteration to reduce drift**"; identity edits: "lock the person (face, body shape, pose, hair, expression)." Official example: "Remove the flower from man's hand. Do not change anything else."
- Text: "**put literal text in quotes or ALL CAPS**," specify typography; "spell them out letter-by-letter" for tricky words; still "can struggle with precise text placement and clarity."
- Reads "descriptive natural language, not keyword spam"; write ads "like a creative brief"; photorealism via "candid photography language" + texture/imperfection; camera specs are "high-level look" cues.
- No negative prompt parameter — constraints in prose ("no watermark, no extra text"). Native prompt cap **32,000 chars**.

**Kie endpoint facts** (model_api_references/gpt-image-2-*.md, verified vs docs.kie.ai)
- `prompt` required, **max 20,000 chars** (Kie cap); `aspect_ratio` ∈ auto|1:1|5:4|9:16|21:9|16:9|4:3|3:2|4:5|3:4|2:3 (default auto); `resolution` 1K|2K|4K — **auto ratio → 1K only; 1:1 → no 4K**. I2I: `input_urls` (multi-file, 30MB; app allows 16). No quality/moderation/background params via Kie. 6/10/16 credits for 1K/2K/4K.

**Community consensus & tricks** (fal.ai/learn/tools/prompting-gpt-image-2, community.openai.com issue collection)
- fal's 5-slot template: **Scene / Subject / Important details / Use case / Constraints** — "the fifth slot is where most mediocre prompts fail silently." "Excitement does not render" — swap "stunning/epic" for "overcast daylight, brushed aluminum, clean kerning."
- Edit form: "Change: [exactly what] / Preserve: [face, pose, lighting, framing, background, text, layout]."
- Known issues: visible noise on complex textures; **more literal than DALL-E 3-era models**; reference images can introduce grid artifacts (fix-up edit: "Remove the noise from the image, while keeping all the lines").
- Iterate with small follow-up edits rather than one mega-prompt.

**Recommended prompt template**
```
Scene: <where, time of day, environment>
Subject: <main focus, concrete attributes>
Details: <materials, textures, lighting, camera feel, composition, mood>
Text (if any): "<EXACT COPY>" in <font style>, <placement>
Use case: <ad / product mockup / thumbnail / infographic>
Constraints: <no watermark, no extra text; preserve list for edits>
```

**Enhancer recipe**
1. Conversational, descriptive natural language in fixed order scene → subject → details → constraints; labeled lines for complex briefs.
2. Always add a use-case line.
3. Always end with a Constraints line, minimum "no watermark, no extra text."
4. Edits: one imperative change sentence + full preserve list; regenerate the SAME preserve list verbatim every iteration.
5. Identity/product edits: explicitly lock face, skin tone, body, pose, logo, label.
6. Exact text in quotes with font style + placement; letter-spell tricky brand names; prefer 2K+ when small text matters.
7. Never write negative-prompt syntax or keyword spam.
8. Because the provider **already rewrites prompts**, the enhancer's job is intent + constraints, not flowery elaboration — compact unambiguous briefs survive the internal rewrite better.
9. Don't restate aspect ratio in prose; respect auto→1K / 1:1→no-4K rules.
10. Photorealism: candid-photo language + imperfections.
11. Keep prompts ≤~500 words.

**Confidence & gaps**: High (official guide + cookbook detailed and recent). Gaps: Kie doesn't expose quality/background/moderation/revised_prompt.

---

## flux-2-pro (BFL FLUX.2 [pro], via `flux-2/pro-text-to-image` + `flux-2/pro-image-to-image`)

**Official guidance** (docs.bfl.ai/guides/prompting_guide_flux2, bfl.ai/blog/flux-2)
- Framework: "**Subject + Action + Style + Context**"; priority order "Main subject → Key action → Critical style → Essential context → Secondary details"; "**FLUX.2 pays more attention to what comes first**."
- Length: 10–30 words quick, **30–80 ideal**, 80+ for complex scenes.
- **JSON structured prompting officially supported**: schema with scene/subjects[]/style/color_palette(hex)/lighting/mood/background/composition/camera{angle,lens,depth_of_field}. Use for "production workflows, automation, consistent structure, multiple subjects." "You can include the JSON directly in your prompt, or flatten it into natural language. FLUX.2 understands both."
- **No negative prompts** — "describe what you want, not what you don't want."
- Text rendering (a strength): exact string in quotes, placement relative to elements, named type style, hex codes + size roles.
- **Hex colors**: "work best when clearly associated with specific objects"; gradients supported.
- Multi-reference: **[pro] = up to 8 references at 1MP output**; role phrasing: "Fashion editorial combining clothing from image 1, accessories from image 2, style aesthetic from image 3."
- Photorealism: camera/lens/film-stock references; prompting in native languages yields more culturally authentic results. Lighting descriptions have "the highest single impact on output quality."

**Kie endpoint facts** (docs.kie.ai/market/flux2/pro-text-to-image, .../pro-image-to-image)
- `prompt` **3–5000 chars**; `aspect_ratio` ∈ 1:1(default)|4:3|3:4|16:9|9:16|3:2|2:3 (+`auto` on i2i = match first input); `resolution` 1K|2K; i2i `input_urls` **1–8 images**, 10MB each; `nsfw_checker` (app sends true). 5 credits 1K / 7 credits 2K. App maxImages 8.

**Community consensus & tricks** (dreampixelforge.com/blog/flux-prompts, github.com/bako02/flux2-prompt-guide, fal.ai/learn/devs/flux-2-prompt-guide)
- **FLUX.1 advice breaks on FLUX.2**: T5+CLIP replaced by a Mistral-Small-3.2 VLM encoder — comma-tag piles, `(word:1.5)` weighting, Danbooru tags are dead; write "plain prose, the way you would describe a photograph to a person."
- Waxy-skin fix is positive phrasing: "visible skin texture and fine pores under soft window light." English negation backfires — "without glasses" biases toward glasses.
- Known biases: strong **center bias** and **shallow-DOF bias**; defeat with early explicit composition ("lower-left third, negative space dominating right two-thirds") and aperture ("f/8, deep focus"). Avoid multi-hand interactions.
- Multi-reference: pre-crop refs tightly; match reference lighting/resolution to target; **disagreement**: BFL addresses refs by index ("image 1"), bako02 guide says by visual attributes in prose. Safest: BOTH — "the woman with red hair (image 1)."
- Failure table: FLUX.1-style tags → flat output; subject buried under style words → drift; identity across renders → attach identical refs every call ("adjectives cannot hold identity"); quoted text renders, vaguely described text becomes gibberish.
- Length reality: quality plateaus ~80–300 words.

**Recommended prompt template**
```
Prose: <subject with concrete attributes> <action>, <composition/placement>, <style/medium>,
<one lighting clause>, <camera: body/lens/aperture>, <color palette with hex bound to objects>,
Text: "<EXACT COPY>" in <type style> <placement>.
Refs (i2i): Keep the product from image 1 exactly (shape, label, colors); take <palette/style> from image 2; place into <scene>.
JSON (multi-subject/brand work): {scene, subjects:[{description, position, action}], style, color_palette:[#hex], lighting, mood, background, composition, camera:{angle, lens, depth_of_field}}
```

**Enhancer recipe**
1. Default to prose (30–80 words); switch to the official JSON schema when the request has 2+ subjects, strict brand palette, or exact layout demands.
2. Subject first, always; front-load load-bearing elements.
3. Convert every negative to a positive state description.
4. Exactly one detailed lighting clause — highest ROI sentence in the prompt.
5. Photorealism: camera body + focal length + aperture + optional film stock; skin-texture/pore/grain cues for people.
6. Brand colors: hex codes bound to named objects ("bottle cap in #004E89").
7. Exact text in quotes + type style + placement.
8. Multi-ref: assign each reference an explicit role, identify by attribute + index; state what to preserve from each; never leave refs unassigned.
9. Name placement/thirds early to break center bias; name aperture to control DOF bias.
10. No contradictions.
11. Never emit tag lists, weighting syntax, or "masterpiece" spam.
12. Keep ≤5000 chars (Kie hard limit), practically ≤300 words.

**Confidence & gaps**: Very high — BFL's guide is the most detailed official source in this set. Gaps: JSON-in-prompt via Kie's pro endpoint untested; index-vs-attribute ref naming has genuine disagreement (hedge with both).

---

## Cross-cutting findings

1. **Nobody in this set supports negative prompts** — FLUX.2 (guidance-distilled), Grok (ignored), gpt-image-2 (no param; prose constraints instead). Universal rule: transform "no X / avoid Y" into positive description — except gpt-image-2 where a prose Constraints line is the official pattern.
2. **Three prompt dialects, one per vendor**: FLUX.2 + grok v1 want *photographer-brief prose*; gpt-image-2 wants *labeled instruction sections* (it self-rewrites); grok-imagine-image-2 wants a *designer's layout brief* (zones + quoted copy + hierarchy). Pick dialect by model.
3. **Front-loading matters everywhere.** Practical lengths: 30–80 words (FLUX/Grok images), ≤120 words (Grok video), ≤500 words (gpt-image-2). Kie hard caps: 5000 chars (grok t2i/video, flux), 20000 (gpt-image-2).
4. **Exact-text rule identical across all**: quote the literal string, name a type style, give a placement. Text-job strength ranking: grok-image-2 ≈ flux-2-pro > gpt-image-2 > grok v1.
5. **Edit phrasing converges**: "change only X + explicit keep-list, one edit per turn, repeat keep-list every iteration." I2I routes: gpt-image-2 (16 refs), flux-2-pro (8 refs), grok v1 (1 ref, `@image1`).
6. **Server-side rewriting**: only gpt-image-2 rewrites internally — its enhancer should output compact constraint-heavy briefs; FLUX/Grok get no help, enhancer must supply all craft itself.
7. **Params, not prose**: strip ratio/duration/mode words from prompt text (grok i2v ratio ignored; grok i2i has no ratio param).
8. **Grok video audio is real but hidden in our UI** (`supportsSound: false` is a missing toggle): every clip ships with generated audio — an enhancer that doesn't append an Audio block (or "no music") ships random soundtracks on UGC ads. Likely the single highest-impact fix from this research.
9. **Kie quirks to encode**: grok t2i returns 6 images (4 in quality mode) per task; grok i2v spicy silently downgrades on external images; gpt-image-2 auto-ratio locks 1K, 1:1 locks out 4K; flux i2i `auto` follows first input. (Grok i2i "390000 char" cap in docs is boilerplate — don't trust.)
10. **App follow-up flagged**: prompt-enhancer.ts:329 aliases grok-imagine-image-2 → grok-imagine-image's profile; these dialects differ, so image-2 deserves its own profile.
