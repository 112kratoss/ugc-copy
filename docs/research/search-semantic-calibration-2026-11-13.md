# Search by meaning: how the similarity bar was set

Date: 2026-11-13. Scope: the one number `search_related_posts` cannot guess, `c_min_similarity`
(migration `20261112215420_search_semantic_related_posts.sql`). Everything here ran on a local
replay stack with the real `embed-post` Edge Function and the real `gte-small` model (Supabase.ai in
the local edge runtime). Nothing was read from or run against production, so the texts are written
by hand, not real posts. Operations (the job, the cap, the kill switch, re-embedding) are in
`docs/production-deployment-runbook.md`, "Search By Meaning".

## Why a bar at all

`gte-small` scores any two short English texts high. Across the 7,531 query and post pairs below
that are about different things, the median cosine similarity is 0.76, one pair in a hundred
is above 0.818 and the highest is 0.848; pairs on the same topic have a median of 0.806
and reach 0.922. So "the eight nearest posts" with no bar is eight posts about anything, and the
useful band is a few hundredths wide.

## What was measured

- **204 posts over 12 unrelated topics**, 17 each (portraits, food, cars, anime, architecture,
  product shots, landscapes, logos, fashion, pets, sci-fi, abstract): a short title, a line of
  caption, and for about a third a prompt, as creators post them. They were inserted as real public
  posts, each with a tool and for five in six a model (Magicbooklet with Nano Banana Pro, Seedream
  4.5, Veo 3.1 or Kling 2.6, Midjourney, Flux), so the text embedded is what production embeds:
  `post_search_documents.search_text`, made by the real triggers, tool and model names included
  (`sea after sunset waves under a violet sky magicbooklet magicbooklet … veo 3.1 veo 3 1 veo31 …`).
- **40 queries**, 35 with the topic or topics a returned post may belong to and 5 about nothing in
  the corpus. Most are paraphrases that share few or no words with any post ("ocean at dusk" for
  "Sea after sunset"), since words are what the search itself already finds.
- The posts were embedded through `embed-post`'s `search` mode (204 posts, 26 requests, 13 s) and
  the queries through its `query` mode: the path production uses.
- For each query, **the 8 nearest posts at or above the bar** were counted, which is what an answer
  carries. A post is on topic when its topic is one the query lists. The labels are strict: "ocean
  at dusk" returning "Sunglasses on sand" (a product shot) and "cute puppies" returning "Pet shop
  logo" count as wrong.

## Result

| Bar | Posts returned | On topic | Precision | Queries answered | On-topic posts a query | Queries about nothing answered |
|---|---|---|---|---|---|---|
| 0.80 | 280 | 219 | 0.782 | 35 of 35 | 6.26 | 3 of 5 |
| 0.81 | 259 | 208 | 0.803 | 35 of 35 | 5.94 | 0 of 5 |
| 0.82 | 208 | 173 | 0.832 | 35 of 35 | 4.94 | 0 of 5 |
| 0.83 | 140 | 126 | 0.900 | 32 of 35 | 3.60 | 0 of 5 |
| 0.84 | 88 | 84 | 0.955 | 30 of 35 | 2.40 | 0 of 5 |
| 0.85 | 44 | 44 | 1.000 | 25 of 35 | 1.26 | 0 of 5 |
| 0.86 | 25 | 25 | 1.000 | 18 of 35 | 0.71 | 0 of 5 |
| 0.87 | 11 | 11 | 1.000 | 9 of 35 | 0.31 | 0 of 5 |

**The bar is 0.84**: 0.955 of the posts returned are on topic, 30 of the 35 queries get at least one
related post (2.4 on average), and no query about nothing gets any (their nearest posts score 0.78
to 0.81). 0.83 just meets the aim of 0.9 with nothing to spare on a corpus this small; 0.85 returns
no wrong post but answers ten fewer queries and half as many posts. Below 0.81 the queries about
nothing start to be answered.

### One-word queries

A second set of 25 single words, 20 of them words no post holds ("feline", "attire", "cuisine",
"motorsport") and 5 about nothing ("invoice", "algebra"), against the same posts:

| Bar | Posts returned | On topic | Precision | Queries answered | On-topic posts a query | Queries about nothing answered |
|---|---|---|---|---|---|---|
| 0.82 | 96 | 77 | 0.802 | 17 of 20 | 3.85 | 2 of 5 |
| 0.83 | 61 | 53 | 0.869 | 16 of 20 | 2.65 | 1 of 5 |
| 0.84 | 30 | 27 | 0.900 | 12 of 20 | 1.35 | 0 of 5 |
| 0.85 | 13 | 12 | 0.923 | 9 of 20 | 0.60 | 0 of 5 |
| 0.86 | 7 | 7 | 1.000 | 7 of 20 | 0.35 | 0 of 5 |

At 0.84 a single word holds the 0.9 aim (27 of 30 posts on topic, none for a word about nothing),
so one-word searches are answered like any other. They are the commonest searches, and a word no
post holds is exactly where related posts help.

### What the tool and model names cost

The same posts embedded from the title, caption and prompt alone, without the names:

| Bar | Posts returned | On topic | Precision | Queries answered | On-topic posts a query | Queries about nothing answered |
|---|---|---|---|---|---|---|
| 0.82 | 203 | 178 | 0.877 | 35 of 35 | 5.09 | 0 of 5 |
| 0.83 | 154 | 143 | 0.929 | 35 of 35 | 4.09 | 0 of 5 |
| 0.84 | 109 | 102 | 0.936 | 33 of 35 | 2.91 | 0 of 5 |
| 0.85 | 64 | 63 | 0.984 | 28 of 35 | 1.80 | 0 of 5 |
| 0.86 | 33 | 33 | 1.000 | 23 of 35 | 0.94 | 0 of 5 |

A little better (at 0.83, 0.929 against 0.900, with every query answered), not a different result.
It was not taken: `search_text` is the one projection of a post that is already held to what a
visitor may see (a paid recipe's caption and prompt left out, a template result's model hidden),
and a second projection for embedding would be a second place for that rule to be got wrong.

### Posts with no words of their own

Some posts show a visitor nothing but names: a stand-in title ("Untitled", "Test video", none at
all) and no public caption or prompt, so `search_text` is the stand-in word and the tool and model
names, `untitled magicbooklet magicbooklet … kling 2.6 kling 2 6 kling26`. A paid recipe's post
under such a title is one of them: its setup caption and prompt are hidden, and nothing else is
left. They are not embedded (`post_search_document_has_own_words`: a title that is not a
placeholder by `marketplace_text_is_placeholder`, or a word of public caption or public prompt),
as the feed's embedder leaves out a post with no text of its own. Twelve of them were measured:

| # | Title | Made with | Why nothing else is public |
|---|---|---|---|
| 1 | Untitled | Magicbooklet, Kling 2.6 | no caption |
| 2 | Test | Magicbooklet, Veo 3.1 | no caption |
| 3 | Demo video | Magicbooklet, Nano Banana Pro | no caption |
| 4 | (none) | Magicbooklet, Seedream 4.5 | no caption |
| 5 | Sample | Midjourney | no caption |
| 6 | My test render | Flux, Flux 1.1 Pro | no caption |
| 7 | Draft | Magicbooklet, Kling 2.6 | no caption |
| 8 | Untitled 2 | Magicbooklet, Nano Banana Pro | no caption |
| 9 | Untitled | Midjourney | paid recipe: setup caption and prompt hidden |
| 10 | Demo | Magicbooklet, Veo 3.1 | paid recipe: setup caption and prompt hidden |
| 11 | Test video | Magicbooklet, Kling 2.6 | no caption |
| 12 | Example | Flux, Flux 1.1 Pro | no caption |

**Through the real pipeline** (inserted as public posts beside the 204, then sent to `embed-post`
in its `search` mode): `post_search_embedding_texts` returned none of the 12, the function answered
`skipped_unsearchable: 12, embedded: 0`, no vector was stored, none is listed as pending, and the
job has no work for them. They match nothing, because they have nothing to match with.

**Had they been embedded** (their `search_text` put through the `query` mode, for this measure
only), against the bar of 0.84:

| Against | Pairs | At or above the bar | Highest |
|---|---|---|---|
| the 40 queries above | 480 | 0 | 0.822 |
| the 25 one-word queries | 300 | 0 | 0.818 |
| 12 queries naming a tool, a model or a stand-in word ("kling 2.6", "kling", "veo 3.1", "nano banana pro", "seedream", "midjourney", "flux", "magicbooklet", "untitled", "test video", "made with kling", "ai video model") | 144 | 31 | 0.964 |
| each other | 66 | 31 | 0.968 |

So an ordinary query would not have found them either way. A query that names a tool or a model
would: "magicbooklet" sits at or above the bar with 8 of the 12, "untitled" and "test video" with
3 each, and nearly half of all pairs of them are within the bar of each other. That is the cluster the
rule keeps out: posts returned for sharing a tool with the query, with nothing to say they are
about what was asked. With the rule, the same 12 name queries return related posts only from the
204 that have words of their own (0 text-poor posts in every answer).

A post with words of its own still carries its tool and model names, so a query that is only a
model's name finds posts made with it ("flux" and "midjourney" return 12 each). Such a query is
answered by words and by the models and tools search already offers; related posts are added only
where that answer is thin.

## Limits

- 204 hand-written posts and 60 queries. Real posts are messier (long prompts, few words, other
  languages); a long prompt lowers a post's similarity to a short query, which costs recall, not
  precision.
- English only. `gte-small` is an English model.
- The measure is topic, not quality: a related post is "about the same thing", nothing finer.

## Doing it again

After a change of model or of what `search_text` holds, on a local stack with the edge runtime:

1. Insert the posts below as public posts (title, caption in `body`, prompt, a tool, and a Made with
   row for the model) and let the triggers write their documents. Add the twelve text-poor posts
   above: the function must answer `skipped_unsearchable` for each.
2. Embed them: `POST /functions/v1/embed-post` with `{"mode":"search","postIds":[…]}`, eight ids
   a request, until `list_posts_pending_search_embedding('gte-small', 96)` returns none.
3. Embed each query with `{"mode":"query","query":"…"}` and keep the vectors in a scratch table.
4. For each query take the 8 posts with the highest `1 - (embedding <=> query)` and count, bar by
   bar, how many are kept and how many of those are on topic.
5. Put the chosen bar in a new migration that re-creates `search_related_posts` with another
   `c_min_similarity`, and in the test that pins it (`search-semantic-migration.test.ts`).

## The corpus

Tool and model per post, in order, repeating: Magicbooklet / Seedream 4.5, Magicbooklet / Veo 3.1, Magicbooklet / Kling 2.6, Midjourney, Flux / Flux 1.1 Pro, Magicbooklet / Nano Banana Pro.

### portraits

- Window light portrait. Soft morning light on her face, shot on 85mm.
- Old fisherman. Weathered skin and a quiet stare. Prompt: close-up portrait of an elderly fisherman, deep wrinkles, grey beard, overcast light.
- Freckles. Natural skin texture test. Prompt: studio headshot of a young woman with freckles, green eyes, neutral backdrop.
- Rembrandt lighting study. One key light, black background.
- The boxer. Sweat and tape after the fight. Prompt: dramatic black and white portrait of a boxer, hard side light.
- Grandmother laughing. Candid moment in the kitchen.
- Golden hour headshot. Backlit hair and warm skin tones. Prompt: headshot of a man in his thirties at sunset, shallow depth of field.
- Twin sisters. Matching braids, different moods.
- Smoke and shadow. Moody low-key face study. Prompt: portrait of a man exhaling smoke, single rim light, film grain.
- Face in the rain. Water drops on her eyelashes.
- The violinist. Eyes closed mid performance. Prompt: half-body portrait of a violinist on stage, spotlight.
- Profile silhouette. Side view against a bright window.
- Child with a red scarf. Winter cheeks and a shy smile. Prompt: portrait of a child wearing a red scarf, snowflakes, soft focus.
- Editorial beauty close-up. Glossy lips, wet-look skin.
- Self portrait at thirty. Honest, no retouching.
- Tattooed chef. Arms crossed, proud look. Prompt: environmental portrait of a tattooed chef in a steel kitchen.
- Eyes of the desert. Nomad elder wrapped in indigo cloth.

### food

- Ramen night. Rich tonkotsu broth with a soft egg. Prompt: overhead photo of a steaming bowl of ramen, chashu pork, nori, wooden table.
- Sourdough crumb shot. Finally got an open crumb.
- Neapolitan pizza. Leopard spots from a wood fired oven. Prompt: margherita pizza with blistered crust, fresh basil, rustic table.
- Breakfast spread. Pancakes, berries and maple syrup.
- Sushi platter. Nigiri and maki on black slate. Prompt: assorted sushi platter, salmon nigiri, tuna rolls, wasabi, dark slate.
- Street tacos. Al pastor with pineapple and lime.
- Chocolate lava cake. Molten centre flowing onto the plate. Prompt: dessert photo, chocolate fondant cut open, vanilla ice cream.
- Espresso pour. Crema swirling in a small cup.
- Burger stack. Double smash patty with melted cheddar. Prompt: juicy cheeseburger with sesame bun, dripping sauce, fries on the side.
- Mango sticky rice. Thai dessert with coconut cream.
- Pasta carbonara. Silky egg sauce and crispy guanciale.
- Farmers market haul. Heirloom tomatoes and fresh herbs. Prompt: flat lay of colourful vegetables on linen, natural light.
- Croissant layers. Buttery lamination cross section.
- Spicy curry bowl. Chicken tikka masala with naan.
- Ice cream cones. Three scoops melting in the sun. Prompt: pastel gelato cones held up against a blue wall.
- Cheese board. Brie, figs, walnuts and honey.
- Dumplings in a steamer. Handmade pork and chive. Prompt: bamboo steamer full of dumplings, rising steam, chopsticks.

### cars

- Midnight supercar. Low and wide under street lamps. Prompt: black Lamborghini parked on a wet street at night, reflections.
- Classic Mustang. 1967 fastback in candy red.
- Rally stage. Gravel flying on a forest corner. Prompt: rally car drifting through a dirt road, dust cloud, motion blur.
- Porsche on the pass. Alpine switchbacks at sunrise.
- JDM garage. Skyline and Supra side by side. Prompt: two tuned Japanese sports cars in a neon lit garage.
- Vintage Beetle. Pastel blue with a roof rack.
- Formula race start. Twenty cars into turn one. Prompt: formula one cars racing at speed, grandstand blur.
- Off-road truck. Mud up to the door handles.
- Electric concept. Sleek silver coupe with no door handles. Prompt: futuristic electric vehicle concept in a white studio.
- Drift smoke. Tyres screaming sideways.
- Engine bay detail. Polished V8 with red valve covers.
- Desert highway cruise. Convertible with the top down. Prompt: vintage convertible driving an empty desert highway.
- Wheel close-up. Bronze rims and big brake calipers.
- Le Mans prototype. Headlights cutting through the night.
- Rusty pickup. Abandoned farm truck in tall grass. Prompt: old rusted pickup truck in a field, overcast sky.
- Motorcycle lean. Knee down on the apex. Prompt: sport bike rider cornering hard on a race track.
- Car interior. Tan leather and a wooden steering wheel.

### anime

- Shonen hero. Spiky hair and a determined grin. Prompt: anime style teenage boy hero with a sword, dynamic pose, cel shading.
- Magical girl transformation. Ribbons, sparkles and a wand.
- Ghibli afternoon. A girl and her cat on a grassy hill. Prompt: studio ghibli style illustration, countryside, fluffy clouds.
- Mecha pilot. Cockpit glow on her visor. Prompt: anime mecha pilot girl in a plugsuit, giant robot behind.
- Chibi friends. Tiny characters sharing bubble tea.
- Samurai duel. Two ronin under falling petals. Prompt: anime samurai fight scene, cherry blossoms, speed lines.
- School rooftop. Lunch break and a summer breeze.
- Villain reveal. One glowing eye in the dark. Prompt: menacing anime antagonist, long coat, dramatic shadows.
- Manga panel study. Black ink and screentone.
- Waifu in a kimono. Festival night with paper lanterns. Prompt: anime girl in a floral kimono at a summer festival, fireworks.
- Isekai tavern. Adventurers around a wooden table.
- Catgirl maid. Ears, tail and a tray of cakes.
- Final form. Aura exploding around the fighter. Prompt: anime power-up scene, glowing energy aura, screaming warrior.
- Slice of life kitchen. Siblings cooking curry together.
- Demon slayer fan art. Breathing technique with water effects.
- Idol concert. Pink lights and a cheering crowd. Prompt: anime idol group performing on stage, glow sticks.
- Lo-fi study girl. Headphones, rain on the window.

### architecture

- Brutalist tower. Raw concrete against a grey sky. Prompt: brutalist apartment block, repeating balconies, overcast.
- Gothic cathedral. Flying buttresses and stained glass.
- Minimal villa. White cube house with a pool. Prompt: modern minimalist house, flat roof, floor to ceiling glass.
- Spiral staircase. Looking up through the atrium.
- Tokyo alley. Narrow buildings and tangled wires.
- Glass skyscraper. Clouds reflected in the facade. Prompt: low angle of a glass office tower, blue hour.
- Timber cabin. A-frame in a pine forest.
- Mosque courtyard. Arches and geometric tiles. Prompt: islamic architecture courtyard, symmetrical arches, fountain.
- Art deco lobby. Brass, marble and sunburst motifs.
- Bridge at dawn. Suspension cables in the fog.
- Santorini rooftops. Whitewashed walls and blue domes.
- Parametric pavilion. Curved timber ribs. Prompt: organic parametric architecture pavilion, flowing wooden structure.
- Abandoned factory. Broken windows and rusted beams.
- Japanese tea house. Sliding doors open to a garden.
- Library interior. Endless shelves under a dome. Prompt: grand old library reading room, wooden ladders, warm lamps.
- Courtyard housing. Brick terraces around a shared garden.
- Museum facade. Folded titanium panels.

### product

- Perfume bottle. Amber glass on wet stone. Prompt: luxury perfume bottle product shot, water droplets, dark background.
- Sneaker launch. Floating shoe with a clean shadow. Prompt: white running sneaker floating, studio product photography.
- Skincare set. Serum and cream on a pastel podium.
- Wristwatch macro. Brushed steel and a blue dial. Prompt: macro product photo of a mechanical watch, dramatic lighting.
- Headphones hero shot. Matte black over-ears on a stand.
- Coffee bag mockup. Kraft pouch with a minimal label.
- Lipstick lineup. Six shades in gold tubes. Prompt: cosmetics product shot, lipsticks arranged in a row, soft shadows.
- Smartphone render. Titanium edges and three lenses.
- Sunglasses on sand. Tortoiseshell frames, beach vibe.
- Whiskey bottle. Backlit amber with ice and a glass. Prompt: whiskey bottle advertising photo, smoky background.
- Candle packaging. Soy candle in a ceramic jar with a box.
- Gaming mouse. RGB glow on a dark desk.
- Handbag still life. Leather tote with gold hardware. Prompt: luxury handbag product photography, marble surface.
- Energy drink can. Condensation and a splash.
- Ceramic mug set. Speckled glaze, handmade feel.
- Backpack flat lay. Everything that fits inside.
- Shampoo ad. Bottle on a wave of foam. Prompt: hair care product shot with a water splash, clean white.

### landscapes

- Sea after sunset. Waves under a violet sky.
- Misty mountains. Layers of blue ridges at dawn. Prompt: mountain range in morning fog, layered silhouettes, soft light.
- Desert dunes. Wind patterns in orange sand.
- Northern lights. Green ribbons over a frozen lake. Prompt: aurora borealis over snowy mountains, starry sky.
- Autumn forest path. Golden leaves and low sun.
- Tropical beach. Turquoise water and leaning palms. Prompt: empty tropical beach, white sand, clear lagoon.
- Waterfall canyon. Long exposure through the gorge.
- Lavender fields. Purple rows to the horizon.
- Storm over the plains. Lightning under a shelf cloud. Prompt: dramatic thunderstorm over open prairie.
- Alpine lake. Mirror reflection of snowy peaks.
- Rice terraces. Green steps down the valley.
- Volcanic coast. Black sand and sea stacks. Prompt: moody Icelandic coastline, black beach, crashing waves.
- Meadow at dusk. Wildflowers and a pink horizon.
- Glacier ice cave. Blue light inside the ice.
- Savanna sunrise. Acacia trees in orange haze.
- Cliffs in mist. Sea fog rolling over the headland.
- River bend. Aerial view of a winding river in a green valley.

### logos

- Coffee shop logo. Minimal bean mark with wordmark. Prompt: flat vector logo for a coffee shop, simple, two colours.
- Fox mascot. Geometric orange fox head emblem.
- Tech startup wordmark. Lowercase sans with a custom letter a.
- Monogram set. Interlocking letters for a law firm. Prompt: elegant monogram logo, serif, gold on navy.
- Bakery badge. Vintage wheat and rolling pin crest.
- Esports team crest. Angry wolf shield. Prompt: esports logo of a wolf, bold outlines, mascot style.
- Yoga studio symbol. Lotus made of one line.
- Brand identity sheet. Logo, palette and type on one page.
- Brewery label mark. Hop cone inside a circle.
- Fitness app icon. Lightning bolt in a rounded square. Prompt: app icon design, gradient, minimal bolt symbol.
- Record label logo. Vinyl disc forming the letter O.
- Real estate emblem. Roofline and key combined.
- Podcast cover mark. Microphone with sound waves.
- Sticker pack. Die-cut brand marks in three colours.
- Pet shop logo. Paw print inside a heart. Prompt: cute logo for a pet store, rounded shapes.
- Negative space mark. Hidden arrow between two letters.
- Sports club badge. Classic football crest redesign.

### fashion

- Runway look. Oversized trench in camel. Prompt: fashion model walking a runway in a long trench coat.
- Streetwear fit. Baggy cargos and a cropped puffer.
- Evening gown. Emerald silk with a long train. Prompt: haute couture gown editorial, marble staircase.
- Denim on denim. Vintage wash jacket and jeans.
- Lookbook spring. Linen sets in sand and sage.
- Tailored suit. Double-breasted in charcoal wool. Prompt: menswear editorial, sharp tailored suit, city street.
- Avant-garde silhouette. Sculptural shoulders in black.
- Knitwear season. Chunky cable sweater and scarf.
- Bridal lace. Long sleeves and a cathedral veil.
- Y2K outfit. Low rise, butterfly top, tinted shades.
- Leather jacket editorial. Biker style under neon lights. Prompt: fashion shoot, model in a leather biker jacket at night.
- Summer dress. Floral midi blowing in the wind.
- Accessories styling. Layered gold chains and rings.
- Techwear. Waterproof shell and utility straps.
- Kimono-inspired coat. Wide sleeves and an obi belt.
- Vintage thrift haul. Seventies prints and flared trousers.
- Sneakerhead outfit. Outfit built around the shoes.

### pets

- Sleepy golden retriever. Nap on the couch after a walk. Prompt: golden retriever sleeping on a sofa, cosy blanket.
- Kitten in a box. If it fits, it sits.
- Corgi butt. Fluffy loaf from behind.
- Parrot portrait. Scarlet macaw showing off. Prompt: colourful parrot close-up, tropical leaves.
- Dog at the beach. Zoomies in the surf. Prompt: happy dog running along the shoreline, splashing water.
- Black cat stare. Yellow eyes in the dark.
- Bunny munching. Lop ears and a carrot top.
- Puppy first bath. Soapy and unimpressed.
- Cat on a windowsill. Watching birds all afternoon. Prompt: tabby cat sitting by a sunny window.
- Hamster cheeks. Stuffed with sunflower seeds.
- Husky howl. Blue eyes and a snowy nose.
- Aquarium betta. Flowing red fins.
- Old dog, grey muzzle. Fifteen years of loyalty.
- Kitten and puppy. Unlikely best friends cuddling. Prompt: a kitten sleeping on top of a puppy.
- Horse in the paddock. Mane blowing in the wind.
- Pug in a raincoat. Yellow slicker, serious face.
- Guinea pig picnic. Tiny lettuce feast.

### scifi

- Orbital station. Ring habitat above a blue planet. Prompt: giant space station orbiting Earth, cinematic.
- Cyberpunk alley. Holograms and rain soaked neon. Prompt: cyberpunk city street at night, neon signs, flying cars.
- Alien jungle. Bioluminescent plants under two moons.
- Mech hangar. Engineers dwarfed by a war machine.
- Starship bridge. Crew at their consoles before the jump. Prompt: spaceship command deck interior, holographic displays.
- Android awakening. Synthetic skin peeling to chrome. Prompt: humanoid robot face, exposed circuitry, blade runner mood.
- Mars colony. Domes and rovers in red dust.
- Wormhole transit. Light bending around the hull.
- Dystopian megacity. Towers vanishing into smog.
- Space marine. Battle-worn armour, helmet under arm.
- Time machine lab. Tesla coils and brass dials.
- Derelict freighter. Drifting wreck in an asteroid field. Prompt: abandoned spaceship floating among asteroids.
- Robot companion. Small droid following a child.
- Laser battle. Fighters streaking past a dreadnought.
- Cryo pods. Sleepers in frosted glass.
- First contact. A lone figure before a hovering craft. Prompt: ufo hovering over a field at dusk, silhouette of a person.
- Terraformed moon. Forests under an artificial sky.

### abstract

- Fluid marble. Swirls of teal and gold ink. Prompt: abstract fluid art, marbled paint, metallic veins.
- Geometric rhythm. Overlapping circles and triangles.
- Gradient mesh. Soft blobs of peach and violet. Prompt: abstract gradient background, smooth blurred shapes.
- Glitch field. Broken pixels and scan lines.
- Fractal bloom. Infinite spirals in electric blue. Prompt: mandelbrot fractal zoom, vivid colours.
- Paint strokes. Thick impasto in primary colours.
- Wireframe waves. Lines rolling like a grid ocean.
- Colour study no. 7. Squares within squares.
- Liquid chrome. Melting mirror shapes. Prompt: 3d abstract render, chrome blobs, iridescent.
- Noise texture. Grainy monochrome static.
- Kaleidoscope. Mirrored shards of stained colour.
- Brush calligraphy shapes. Black ink gestures on rice paper.
- Particle storm. Thousands of glowing dots in motion.
- Op art tunnel. Black and white stripes bending inward.
- Pastel shapes collage. Cut paper arcs and dots.
- Generative lines. Plotter drawing of flowing curves. Prompt: generative art, thin flowing lines, algorithmic pattern.
- Smoke swirls. Coloured vapour on black.

### Queries

| Query | May return |
|---|---|
| ocean at dusk | landscapes |
| scenic nature views | landscapes |
| snowy peaks reflected in water | landscapes |
| headshot photography | portraits |
| close-up of a human face | portraits |
| black and white photo of a man | portraits |
| delicious meals | food |
| japanese noodles | food |
| sweet desserts | food |
| fast sports cars | cars |
| vintage automobile | cars |
| racing on a track | cars |
| japanese animation characters | anime |
| manga style girl | anime |
| cartoon hero fighting | anime |
| modern buildings | architecture |
| house design | architecture |
| old church interior | architecture |
| advertising photo of a bottle | product |
| ecommerce product photography | product |
| cosmetics packshot | product |
| brand mark design | logos |
| company emblem | logos |
| mascot badge for a team | logos |
| clothing editorial | fashion |
| outfit ideas | fashion |
| wedding dress | fashion |
| cute puppies | pets |
| cats | pets |
| adorable animals at home | pets |
| spaceships | scifi |
| futuristic city | scifi, architecture |
| robots | scifi, anime |
| colourful shapes and patterns | abstract |
| swirling paint background | abstract |
| tax return spreadsheet | nothing |
| weather forecast for tomorrow | nothing |
| how to learn guitar chords | nothing |
| quarterly sales dashboard | nothing |
| mortgage interest rates | nothing |

One-word queries: automobile (cars), feline (pets), canine (pets), cuisine (food), attire (fashion), typography (logos), galaxy (sci-fi), selfie (portraits), mansion (architecture), advert (product), seaside (landscapes), psychedelic (abstract), otaku (anime), couture (fashion), wilderness (landscapes), pastry (food), droid (sci-fi), headshots (portraits), motorsport (cars), branding (logos); about nothing: invoice, algebra, plumbing, election, insurance.
