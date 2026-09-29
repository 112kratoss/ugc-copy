/**
 * Generation-time refusal for the few requests no provider may be trusted with.
 *
 * Google Play's AI-Generated Content policy only allows generators that
 * "prohibit and prevent" restricted content, and its reviewer proved the
 * providers alone do not: "Show the woman with nothing on" was refused by
 * nano-banana-2 and then accepted by Seedream 5 Lite and Pro, even with
 * `nsfw_checker: true` (September 2026 policy notice). The owner chose a narrow
 * gate over a broad content filter, so exactly four things are refused:
 *
 * - `minor_sexualization`: a minor alongside anything sexual or revealing;
 * - `undressing`: removing a person's clothes, or showing them without any;
 * - `see_through_clothing`: see-through or x-ray views of what someone wears;
 * - `nudity`: asking for nude, naked or topless people, or genitals.
 *
 * Everything else, including swimwear, lingerie, fashion, dance and art that
 * does not ask for nudity, still reaches the model unchanged. Only positive
 * prompts are checked. Negative prompts ask a model to avoid these words, and a
 * prompt that says "no nudity" is a user being careful, so negated mentions and
 * colour words ("nude lipstick") are neutralised before any rule runs.
 */

export type GenerationPromptSafetyCategory =
  | 'minor_sexualization'
  | 'undressing'
  | 'see_through_clothing'
  | 'nudity';

// Lookalike letters from other scripts, mapped to the Latin letter they imitate,
// so "nаked" with a Cyrillic "а" is read as "naked" instead of "n ked".
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', к: 'k', ԁ: 'd',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
};

function baseNormalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[​-‍⁠﻿­]/g, '')
    .toLowerCase()
    .replace(/[Ͱ-ϿЀ-ӿԀ-ԯ]/g, (letter) => HOMOGLYPHS[letter] ?? letter);
}

/**
 * Letters only, with digit swaps undone ("n4k3d" → "naked"). Padded with spaces
 * so every rule can rely on `\b` at both ends.
 */
function wordView(value: string): string {
  const letters = baseNormalize(value)
    .replace(/4|@/g, 'a')
    .replace(/3/g, 'e')
    .replace(/1/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5|\$/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return ` ${letters} `;
}

/** Keeps digits, so "15-year-old" survives as "15 year old". */
function ageView(value: string): string {
  return ` ${baseNormalize(value).replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

// Swapping the risky word for a harmless one, rather than deleting the phrase,
// keeps the rest of it visible to the minor rule: "teen in nude lingerie" must
// still see "lingerie".
const NEUTRAL_WORDS: Record<string, string> = {
  nude: 'beige',
  nudes: 'beige',
  nudity: 'modesty',
  naked: 'bare',
  nakedness: 'bareness',
  topless: 'open',
  nipple: 'teat',
  nipples: 'teats',
  nsfw: 'sfw',
  porn: 'film',
  porno: 'film',
  pornography: 'film',
  pornographic: 'film',
  genitals: 'body',
  genitalia: 'body',
  baby: 'soft',
  minor: 'small',
  minors: 'small',
  see: 'look',
  transparent: 'clear',
};

function neutralize(phrase: string): string {
  return phrase.replace(/\b[a-z]+\b/g, (word) => NEUTRAL_WORDS[word] ?? word);
}

const NUDE_COLOR_CONTEXT = [
  'lip', 'lips', 'lipstick', 'lipsticks', 'gloss', 'makeup', 'make up', 'nail', 'nails', 'polish', 'manicure',
  'pedicure', 'heel', 'heels', 'pump', 'pumps', 'shoe', 'shoes', 'sandal', 'sandals', 'boot', 'boots', 'flats',
  'loafer', 'loafers', 'mule', 'mules', 'stiletto', 'stilettos', 'tone', 'tones', 'toned', 'color', 'colour',
  'colors', 'colours', 'colored', 'coloured', 'colorway', 'shade', 'shades', 'palette', 'palettes', 'beige', 'pink',
  'peach', 'brown', 'tan', 'blush', 'eyeshadow', 'eye shadow', 'foundation', 'concealer', 'stocking', 'stockings',
  'tights', 'hosiery', 'bag', 'bags', 'handbag', 'handbags', 'clutch', 'purse', 'backdrop', 'background',
  'backgrounds', 'wall', 'walls', 'paint', 'swatch', 'swatches', 'neutral', 'neutrals', 'hue', 'hues',
  'ribbon', 'leather', 'satin', 'silk', 'linen', 'fabric', 'mesh', 'slip dress', 'bodysuit', 'bra', 'bras',
  'underwear', 'lingerie', 'shapewear', 'hijab', 'scarf', 'dress', 'dresses', 'gown', 'gowns', 'outfit', 'outfits',
].join('|');

const NEGATED_TERMS = [
  'nudity', 'nude', 'nudes', 'naked', 'nakedness', 'nsfw', 'porn', 'porno', 'pornography', 'pornographic',
  'nipples?', 'genitals', 'genitalia', 'topless', 'see through', 'transparent clothing', 'explicit content',
].join('|');

/** Harmless phrases that contain a risky word. Each match is neutralised in place. */
const BENIGN_PHRASES: RegExp[] = [
  // "…at the beach, no nudity" is a user being careful, not asking for it.
  new RegExp(`\\b(?:no|not|non|never|without|avoid|avoiding|zero|nothing|exclude|excluding|free of|minus|don\\s*t\\s+show|do\\s+not\\s+show)\\s+(?:any\\s+)?(?:${NEGATED_TERMS})\\b`, 'g'),
  new RegExp(`\\b(?:${NEGATED_TERMS})\\s+free\\b`, 'g'),
  new RegExp(`\\bnudes?\\s+(?:${NUDE_COLOR_CONTEXT})\\b`, 'g'),
  new RegExp(`\\b(?:soft|pale|warm|cool|light|dark|deep|neutral|pastel|beige|pink|peach|rose|matte|glossy|shimmer|shimmery|creamy|muted|earthy|classic|everyday)\\s+nudes?\\s+(?:${NUDE_COLOR_CONTEXT})\\b`, 'g'),
  new RegExp(`\\bnudes?\\s+(?:and|or)\\s+(?:beige|pink|peach|brown|tan|white|cream|gold|black|blush)\\s+(?:${NUDE_COLOR_CONTEXT})\\b`, 'g'),
  new RegExp(`\\b(?:beige|pink|peach|brown|tan|white|cream|gold|black|blush)\\s+(?:and|or)\\s+nudes?\\s+(?:${NUDE_COLOR_CONTEXT})\\b`, 'g'),
  /\bshades?\s+of\s+nudes?\b/g,
  /\bnaked\s+(?:eye|eyes|flame|flames|truth|ambition|cake|cakes|bike|bikes|motorcycle|motorcycles|juice|tree|trees|branch|branches|bulb|bulbs|wire|wires|steel|concrete|brick|bricks|light|mole rat|mole rats|singularity|lunch)\b/g,
  /\btopless\s+(?:car|cars|bus|buses|convertible|convertibles|jeep|jeeps|roof|tower|double decker)\b/g,
  /\b(?:baby\s+)?bottle\s+nipples?\b/g,
  /\bbaby\s*(?:doll|dolls|blue|pink|breath|s breath|shower|bump)\b/g,
  /\bminors?\s+(?:key|keys|chord|chords|league|leagues|detail|details|injury|injuries|change|changes|edit|edits|character|characters|role|roles|scale|scales|issue|issues|problem|problems|flaw|flaws|adjustment|adjustments|tweak|tweaks|planet|planets|arcana|third|thirds)\b/g,
  /\bsee\s+through\s+(?:the\s+)?(?:window|windows|glass|lens|lenses|fog|mist|smoke|clouds|water|ice|curtain|curtains|veil of|door|walls?|trees|leaves|crowd|lies|it|this|that|them all)\b/g,
  /\btransparent\s+(?:glass|plastic|acrylic|background|backgrounds|png|layer|layers|umbrella|raincoat|window|windows|bottle|bottles|box|boxes|bag|bags|case|cases|ice|water)\b/g,
];

// Clothing words used by the undressing and see-through rules. "top" and
// "shorts" are too common in other senses ("the top layer", "her top 10
// moments") to stand alone, so only the see-through rules and a dedicated
// undressing rule with its own exclusions accept them after a possessive.
const CLOTHING = '(?:clothes|clothing|garments?|outfits?|dress|dresses|gown|gowns|shirt|shirts|t shirt|tshirt|blouse|bra|bras|pants|trousers|jeans|leggings|tights|stockings|skirt|skirts|underwear|panties|knickers|boxers|briefs|lingerie|bikini|bikinis|swimsuit|swimsuits|swimwear|bodysuit|leotard|nightgown|nightie|nightdress|towel|robe|saree|sari|kurti|uniform)';
const POSSESSIVE = '(?:her|his|their|them|him)\\s+(?:\\w+\\s+)?';
const WORN_BY_PERSON = `(?:${POSSESSIVE}${CLOTHING})`;
const WORN_BY_PERSON_WITH_TOPS = `(?:${POSSESSIVE}(?:${CLOTHING.slice(3, -1)}|top|tops|shorts))`;
const SEE_THROUGH = '(?:see\\s*(?:through|thru)|seethrough|seethru)';
const PERSON = '(?:her|his|their|them|him|the (?:woman|women|man|men|girl|girls|boy|boys|person|people|lady|ladies|model|models|guy|guys|subject|character|actress|actor)|this (?:woman|man|girl|boy|person|lady|model|guy))';

type SafetyRule = {
  category: GenerationPromptSafetyCategory;
  pattern: RegExp;
  /** `digits` reads the view that keeps numbers, for rules that exclude "her top 10". */
  view?: 'words' | 'digits';
};

const RULES: ReadonlyArray<SafetyRule> = [
  // Undressing a person, or showing them with no clothes at all.
  { category: 'undressing', pattern: /\b(?:undress|undresses|undressed|undressing|unclothe|unclothed|disrobe|disrobed|disrobes|disrobing|declothe|declothed|nudify|nudifies|nudified|nudifying|nudifier|nudification)\b/ },
  { category: 'undressing', pattern: new RegExp(`\\b(?:take|takes|taking|took|taken|pull|pulls|pulling|pulled|rip|rips|ripping|ripped|tear|tears|tearing|tore|torn|strip|strips|stripping|stripped|remove|removes|removing|removed|peel|peels|peeling|peeled|lift|lifts|lifting|lifted|drop|drops|dropping|dropped|slip|slips|slipping|slipped|cut|cuts|cutting|erase|erases|erasing|erased|delete|deletes|deleting|deleted)\\s+(?:off\\s+|down\\s+|up\\s+|away\\s+)?(?:all\\s+(?:of\\s+)?)?(?:${WORN_BY_PERSON}|the\\s+(?:clothes|clothing|garments|bra|underwear|panties|bikini|lingerie|swimsuit|trousers))\\b`) },
  { view: 'digits', category: 'undressing', pattern: /\b(?:take|takes|taking|took|pull|pulls|pulling|pulled|rip|rips|ripping|ripped|tear|tears|tearing|tore|remove|removes|removing|removed|lift|lifts|lifting|lifted|strip|strips|stripping|stripped)\s+(?:off\s+|up\s+|down\s+)?(?:her|their)\s+(?:\w+\s+)?(?:top|tops|shorts)\b(?!\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|pick|picks|moment|moments|tip|tips|story|stories|song|songs|post|posts|photo|photos|picture|pictures|video|videos|choice|choices|priority|priorities|spot|score|scores|rank|ranking|list|lists|shelf|drawer|floor|level|tier))/ },
  { category: 'undressing', pattern: /\b(?:take|takes|taking|took|remove|removes|removing|removed|strip|strips|stripping|stripped)\s+(?:off\s+)?(?:all|everything)\s+(?:(?:of\s+)?(?:her|his|their|the)\s+)?(?:clothes|clothing|garments|she|he|they|off)\b/ },
  { category: 'undressing', pattern: /\b(?:remove|removes|removing|removed|strip|strips|stripping|stripped|erase|erases|erasing|erased|delete|deletes|deleting|deleted)\s+(?:off\s+)?(?:all\s+|any\s+)?(?:clothes|clothing|garments)\b/ },
  { category: 'undressing', pattern: /\b(?:take|takes|taking|took|rip|rips|ripping|ripped|tear|tears|tearing|tore)\s+off\s+(?:all\s+|any\s+)?(?:clothes|clothing|garments)\b/ },
  { category: 'undressing', pattern: new RegExp(`\\b(?:she|he|they|${PERSON.slice(3, -1)})\\s+(?:\\w+\\s+){0,2}(?:strip|strips|stripping|stripped)\\s+(?:naked|nude|down|off)\\b`) },
  { category: 'undressing', pattern: /\b(?:striptease|stripteases|strip\s+tease)\b/ },
  { category: 'undressing', pattern: /\b(?:strip|strips|stripped|stripping)\s+(?:her|him|them)\b(?!\s+of\s+(?:her|his|their)\s+(?:title|titles|rights|power|powers|rank|crown|medal|medals|license|licence|role|job|name|dignity|wealth|money|land))/ },
  { category: 'undressing', pattern: /\b(?:wear|wears|wore|worn)\s+(?:absolutely\s+)?nothing\b(?!\s+(?:special|fancy|much|else|flashy|formal|expensive|fashionable|new|bright|colorful|colourful|on\s+(?:it|the|her\s+(?:face|head|feet))))/ },
  { category: 'undressing', pattern: /\b(?:clothes|clothing|outfit|outfits|dress|garments?|bikini|bra|underwear|panties|lingerie)\s+(?:are|is|were|was|get|gets|got|getting)\s+(?:all\s+)?(?:gone|off|removed|missing|taken off|pulled off|ripped off|torn off|stripped|stripped off)\b/ },
  { category: 'undressing', pattern: /\b(?:clothes|clothing|outfit|outfits|dress|garments?)\s+(?:to|into|with|for)\s+nothing\b/ },
  { category: 'undressing', pattern: /\b(?:she|he|they|her|him|them|woman|women|man|men|girl|girls|boy|boys|lady|person|model)\s+(?:is\s+|are\s+|was\s+|were\s+|looks?\s+|appears?\s+|stands?\s+|standing\s+|sits?\s+|sitting\s+|lies?\s+|lying\s+)?(?:completely|totally|fully|entirely|stark)\s+(?:bare|naked|nude)\b/ },
  { category: 'undressing', pattern: /\b(?:clothes|clothing|bra|underwear|panties|bikini|lingerie|pants|trousers|skirt|dress|swimsuit)\s+(?:off|removed|gone|pulled down|pulled off|ripped off|torn off|falling off|fall off|falls off|fell off|slipping off|slips off|slid off|dropped)\b(?!\s+(?:white|the shoulder|shoulder|shoulders|one shoulder|screen|camera|stage|duty|road|track|season|guard|balance|rack|racks|hanger|hangers))/ },
  { category: 'undressing', pattern: /\bher\s+(?:shirt|top|blouse|t shirt|tshirt)\s+off\b/ },
  { category: 'undressing', pattern: /\b(?:with|wearing|has|had|having|in|put)\s+(?:absolutely\s+)?nothing\s+on\b(?!\s+(?:it|them|the|this|that|its|a|an|my|your|our|top|there|here|screen|display|tv|television|shelves|shelf|table|desk|wall|walls|plate|menu|radio|record|file|agenda|list|schedule|mind|(?:her|his|their)\s+(?:face|head|feet|plate|mind|desk|table|wall|walls|schedule|calendar|agenda|list|conscience|lips|nails)))/ },
  { category: 'undressing', pattern: /\bwearing\s+(?:absolutely\s+)?nothing\b(?!\s+(?:special|fancy|much|else|flashy|formal|expensive|fashionable|new|bright|colorful|colourful|on\s+(?:it|the|her\s+(?:face|head|feet))))/ },
  { category: 'undressing', pattern: /\b(?:not|isn t|isnt|aren t|arent|wasn t|wasnt|without)\s+wearing\s+(?:any\s+)?(?:clothes|clothing|anything)\b/ },
  { category: 'undressing', pattern: /\b(?:no|without(?:\s+any)?)\s+(?:clothes|clothing)\b(?!\s+(?:hanging|hung|in\s+the|inside|left|to\s+wear|on\s+the\s+(?:rack|hanger|hangers|floor|line|bed)|rack|racks|hangers?|store|shop|brand|label))/ },

  // See-through or x-ray views of what someone is wearing.
  { category: 'see_through_clothing', pattern: new RegExp(`\\b${SEE_THROUGH}\\s+(?:${WORN_BY_PERSON_WITH_TOPS}|(?:the\\s+|a\\s+|an\\s+)?${CLOTHING})\\b`) },
  { category: 'see_through_clothing', pattern: new RegExp(`\\b(?:transparent|x\\s*ray|xray)\\s+(?:${WORN_BY_PERSON_WITH_TOPS}|${CLOTHING})\\b`) },
  { category: 'see_through_clothing', pattern: new RegExp(`\\b${CLOTHING}\\s+(?:that\\s+(?:is|are)\\s+|which\\s+(?:is|are)\\s+|is\\s+|are\\s+|made\\s+|turned\\s+|turning\\s+|becomes?\\s+|became\\s+|goes\\s+|went\\s+)?(?:${SEE_THROUGH}|transparent)\\b`) },
  { category: 'see_through_clothing', pattern: /\b(?:x\s*ray|xray)\s+(?:(?:vision|scan|view|filter|camera|glasses|goggles|mode)\s+)?(?:through\s+)?(?:her|his|their|them|him)\b/ },

  // Nudity itself.
  { category: 'nudity', pattern: /\b(?:nude|nudes|nudity|naked|nakedness|nudist|nudists|nudism|topless)\b/ },
  { category: 'nudity', pattern: /\b(?:in\s+the\s+(?:nude|buff)|birthday\s+suit|full\s+frontal)\b/ },
  { category: 'nudity', pattern: /\b(?:nipple|nipples|areola|areolas|areolae|genital|genitals|genitalia|vagina|vaginas|vaginal|vulva|vulvas|penis|penises)\b/ },
  { category: 'nudity', pattern: /\b(?:bare|naked|exposed|uncovered|visible)\s+(?:breast|breasts|butt|buttocks|bum|crotch)\b/ },
  { category: 'nudity', pattern: /\b(?:show|shows|showing|showed|expose|exposes|exposing|exposed|reveal|reveals|revealing|revealed|flash|flashes|flashing|flashed|uncover|uncovers|uncovering|uncovered)\s+(?:her|his|their)\s+(?:breasts|boobs|butt|buttocks|crotch|genitals|privates|private parts)\b/ },
  // Hindi, Spanish, Portuguese and German words people type for the same request.
  { category: 'nudity', pattern: /\b(?:nangi|desnuda|desnudas|desnudo|desnudos|desnudar|desnudarla|nackt|nackte|nackten|sin\s+ropa|sem\s+roupa|ohne\s+kleidung)\b/ },
  { category: 'nudity', pattern: /\b(?:porn|porno|pornography|pornographic|pornstar|pornstars|nsfw|hentai)\b/ },
];

const MINOR_TERMS: RegExp[] = [
  /\b(?:child|children|childs|kid|kids|kiddo|kiddie|kiddies|toddler|toddlers|infant|infants|baby|babies|preteen|preteens|pre teen|pre teens|tween|tweens|teen|teens|teenage|teenaged|teenager|teenagers|underage|under age|underaged|juvenile|juveniles|schoolgirl|schoolgirls|schoolboy|schoolboys|school girl|school girls|school boy|school boys|lolita|minor|minors)\b/,
  /\b(?:little|young|small|tiny)\s+(?:girl|girls|boy|boys|child|children|kid|kids)\b/,
  /\b(?:high|middle|elementary|primary|junior high|grade)\s+school(?:er|ers)?\b/,
  /\bkindergarten(?:er|ers)?\b/,
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+grader?s?\b/,
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\s*(?:years?|yrs?)\s*old\b/,
];

/** Ages under 18, read from the digit-preserving view. */
const MINOR_AGE_TERMS: RegExp[] = [
  /\b(?:[1-9]|1[0-7])\s*(?:years?|yrs?|yr|y)\s*old\b/,
  /\b(?:[1-9]|1[0-7])\s*(?:yo|y o)\b/,
  /\baged?\s+(?:[1-9]|1[0-7])\b/,
  /\bunder\s+(?:18|eighteen)\b/,
  /\b(?:girl|boy|kid|child|teen|daughter|son)\s+(?:aged?\s+)?(?:[1-9]|1[0-7])\b(?!\s*(?:k|mm|am|pm|fps|x|th|st|nd|rd|of|out)\b)/,
];

/** Terms no adult use needs; refused even without a second sexual word. */
const ALWAYS_MINOR_SEXUALIZATION = /\b(?:loli|lolis|lolicon|shota|shotas|shotacon|jailbait)\b/;

/** With a minor anywhere in the prompt, these are enough to refuse it. */
const SEXUAL_WITH_MINOR = /\b(?:sexy|sexier|sexiest|sexualized|sexualised|sexually|sexual\s+(?:pose|poses|posing|position|positions|act|acts|content|image|images|photo|photos|picture|pictures|video|videos|scene|scenes)|having\s+sex|seductive|seductively|provocative|provocatively|erotic|erotica|sensual|sensually|lewd|horny|aroused|arousing|kinky|fetish|fetishes|lingerie|underwear|panties|knickers|thong|thongs|bra|bras|bikini|bikinis|cleavage|boobs|busty|twerk|twerks|twerking|stripper|strippers|striptease|pole\s+danc(?:e|er|ers|ing)|lap\s*danc(?:e|er|ers|ing)|ecchi|onlyfans|spread\s+(?:her|his|their)\s+legs)\b/;

function firstRuleCategory(words: string, digits: string): GenerationPromptSafetyCategory | null {
  for (const rule of RULES) {
    if (rule.pattern.test(rule.view === 'digits' ? digits : words)) return rule.category;
  }
  return null;
}

function mentionsMinor(words: string, ages: string): boolean {
  return MINOR_TERMS.some((pattern) => pattern.test(words))
    || MINOR_AGE_TERMS.some((pattern) => pattern.test(ages));
}

/**
 * Returns the first refused category found in any of the prompts, or null.
 * Pass every positive prompt of a request (the main prompt and each shot);
 * never a negative prompt.
 */
export function getGenerationPromptSafetyViolation(
  prompts: Iterable<string | null | undefined>,
): GenerationPromptSafetyCategory | null {
  for (const prompt of prompts) {
    if (typeof prompt !== 'string' || !prompt.trim()) continue;

    let words = wordView(prompt);
    for (const phrase of BENIGN_PHRASES) {
      words = words.replace(phrase, neutralize);
    }
    const ages = ageView(prompt);

    const ruleCategory = firstRuleCategory(words, ages);
    const minor = mentionsMinor(words, ages);
    if (ALWAYS_MINOR_SEXUALIZATION.test(words)) return 'minor_sexualization';
    // A minor with anything the other rules refuse is reported as the graver
    // category, so logs and reviews see what was actually asked for.
    if (minor && (ruleCategory || SEXUAL_WITH_MINOR.test(words))) return 'minor_sexualization';
    if (ruleCategory) return ruleCategory;
  }
  return null;
}

/**
 * Collects every positive `prompt` string in a provider request body, at any
 * depth: `input.prompt`, Veo's top-level `prompt`, and each `multi_prompt[]`
 * shot. `negative_prompt` is a different key and is never read.
 */
export function collectProviderPrompts(body: unknown, depth = 0): string[] {
  if (depth > 4 || !body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body.flatMap((entry) => collectProviderPrompts(entry, depth + 1));
  const prompts: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'prompt' && typeof value === 'string') {
      prompts.push(value);
    } else if (value && typeof value === 'object') {
      prompts.push(...collectProviderPrompts(value, depth + 1));
    }
  }
  return prompts;
}
