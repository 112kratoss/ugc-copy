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
 * Each of those is one request said many ways, and a rule only knows the
 * wordings it lists. The reviewer's other prompt, "Remove the cloth fabric from
 * the woman revealing everything underneath", passed every rule on 2026-09-17
 * and was stopped by the provider alone. So the same three requests are also
 * matched when the cloth is named as a material, when a garment leaves by
 * itself ("her dress disappears"), when someone is shown "without her
 * clothes", when the view is "under her dress", and when nudity is described
 * without its usual words ("wearing only heels").
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

/** The alternatives of CLOTHING without their group, for building wider lists. */
const CLOTHING_WORDS = CLOTHING.slice(3, -1);
const GARMENT_OR_TOPS = `(?:${CLOTHING_WORDS}|top|tops|shorts)`;
// Cloth named as a material rather than a garment: "the cloth fabric".
const CLOTH = `(?:cloth|cloths|fabric|fabrics|textile|textiles|covering|coverings|attire|apparel|garb|${CLOTHING_WORDS}|top|tops|shorts)`;
// Who the cloth is taken from. Outerwear and objects are not here, so "remove
// the towel from the chair" and "the excess clay from the model" read as edits.
const TAKEN_FROM = '(?:her|him|them|herself|himself|themselves|everyone|everybody|(?:her|his|their)\\s+(?:body|bodies|figure|torso|chest|frame)|(?:the|this|that)\\s+(?:woman|women|man|men|girl|girls|boy|boys|person|people|lady|ladies|model|models|guy|guys|subject|subjects|character|characters|actress|actor|figure|female|male|bride|dancer|couple))';
const TAKE_AWAY = '(?:take|takes|taking|took|taken|pull|pulls|pulling|pulled|rip|rips|ripping|ripped|tear|tears|tearing|tore|torn|strip|strips|stripping|stripped|remove|removes|removing|removed|peel|peels|peeling|peeled|lift|lifts|lifting|lifted|erase|erases|erasing|erased|delete|deletes|deleting|deleted|wipe|wipes|wiping|wiped|clear|clears|clearing|cleared|(?:get|gets|getting|got)\\s+rid\\s+of)';
// Garments that are rarely anything but worn. "top", "shorts", "towel" and
// "robe" also name things lying around a scene, so "remove the towel" stays an
// edit unless it says who it comes off.
const WORN_GARMENT = '(?:dress|dresses|skirt|skirts|shirt|shirts|t shirt|tshirt|blouse|blouses|pants|jeans|leggings|outfit|outfits|gown|gowns|saree|sari|kurti|bodysuit|leotard|nightgown|nightie|nightdress|uniform|uniforms)';
// What follows a garment when the request is about the garment, not the wearer.
// With "the" instead of "her", a towel or a robe can be lying anywhere.
const THE_WORN = `(?:clothes|clothing|garments?|bra|bras|underwear|panties|knickers|lingerie|bikini|bikinis|swimsuit|swimsuits|swimwear|${WORN_GARMENT.slice(3, -1)})`;
const GARMENT_DETAIL = '(?:stain|stains|wrinkle|wrinkles|crease|creases|logo|logos|text|print|prints|pattern|patterns|shadow|shadows|tag|tags|label|labels|lint|dust|spot|spots|mark|marks|color|colour|background|rack|racks|hanger|hangers|code|strap|straps|belt|button|buttons|sleeve|sleeves|collar|pocket|pockets|zipper|price|hem|lining|train|bow|ribbon|embroidery|sequins|glare|reflection|fold|folds|detail|details|design|texture|shop|store|display|number|numbers|name|names|badge|badges|patch|patches|sponsor|sponsors|stripe|stripes|crest|brand|branding|watermark)';
const GARMENT_PLACE = '(?:chair|floor|bed|table|rack|hanger|hangers|line|clothesline|wall|shelf|sofa|couch|mannequin|closet|wardrobe|drawer|basket|bag|box|door|hook|railing|car|ground|window|display|store|shop|background)';
const SWAPPED_FOR_NOTHING = '(?:nothing|bare\\s+skin|body\\s*paint|bodypaint)';
// A garment going away without anyone taking it. "dissolves into butterflies"
// and "fades to black" are effects, and "falls off the shoulder" is a neckline.
const GOES_AWAY = '(?:disappear|disappears|disappeared|disappearing|vanish|vanishes|vanished|vanishing|dissolve|dissolves|dissolved|dissolving|evaporate|evaporates|evaporated|evaporating|disintegrate|disintegrates|disintegrated|disintegrating|(?:melt|melts|melted|melting|fade|fades|faded|fading|burn|burns|burned|burnt|burning|fall|falls|fell|falling|peel|peels|peeled|peeling|blow|blows|blew|blown|blowing|fly|flies|flew|flying|slide|slides|slid|sliding|slip|slips|slipped|slipping|come|comes|came|coming|tear|tears|tore|torn|rip|rips|ripped|drift|drifts|float|floats)\\s+(?:right\\s+|completely\\s+|clean\\s+)?(?:off|away|apart|undone|loose)|(?:drop|drops|dropped|dropping)\\s+(?:to\\s+the\\s+(?:floor|ground)|off|away|down))';
// What a person "wears only" when they are wearing no clothes.
const ONLY = '(?:only|just|nothing\\s+but|nothing\\s+except|nothing\\s+other\\s+than)';
const NOT_CLOTHES = '(?:(?:her|his|their)\\s+(?:own\\s+|bare\\s+)?(?:skin|hands|hand|arms|hair)|skin|body\\s*paint|bodypaint|a\\s+smile|(?:high\\s+)?heels|stilettos|an\\s+apron|jewelry|jewellery|a\\s+necklace|necklaces|stockings|socks|a\\s+tie|a\\s+hat|boots|shoes|leaves|(?:a\\s+)?(?:fig\\s+)?leaf|petals|bubbles|foam|suds|shadows|glitter|tattoos|a\\s+ribbon|ribbons|chains|pearls|(?:body\\s+)?oil)';
const NOT_SKIN_TIGHT = '(?!\\s*(?:tight|tone|toned|tones|colored|coloured|color|colour|care|splattered|stained))';

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
  { category: 'undressing', pattern: new RegExp(`\\b${GARMENT_OR_TOPS}\\s+(?:to|into|with|for|by)\\s+(?:just\\s+|only\\s+)?(?:nothing|bare\\s+skin|(?:her|his|their)\\s+(?:bare\\s+|own\\s+)?skin|skin${NOT_SKIN_TIGHT}|body\\s*paint|bodypaint)\\b`) },
  { category: 'undressing', pattern: /\b(?:she|he|they|her|him|them|woman|women|man|men|girl|girls|boy|boys|lady|person|model)\s+(?:is\s+|are\s+|was\s+|were\s+|looks?\s+|appears?\s+|stands?\s+|standing\s+|sits?\s+|sitting\s+|lies?\s+|lying\s+)?(?:completely|totally|fully|entirely|stark)\s+(?:bare|naked|nude)\b/ },
  { category: 'undressing', pattern: /\b(?:clothes|clothing|bra|underwear|panties|bikini|lingerie|pants|trousers|skirt|dress|swimsuit)\s+(?:off|removed|gone|pulled down|pulled off|ripped off|torn off|falling off|fall off|falls off|fell off|slipping off|slips off|slid off|dropped)\b(?!\s+(?:white|the shoulder|shoulder|shoulders|one shoulder|screen|camera|stage|duty|road|track|season|guard|balance|rack|racks|hanger|hangers))/ },
  { category: 'undressing', pattern: /\bher\s+(?:shirt|top|blouse|t shirt|tshirt)\s+off\b/ },
  { category: 'undressing', pattern: /\b(?:with|wearing|has|had|having|in|put)\s+(?:absolutely\s+)?nothing\s+on\b(?!\s+(?:it|them|the|this|that|its|a|an|my|your|our|top|there|here|screen|display|tv|television|shelves|shelf|table|desk|wall|walls|plate|menu|radio|record|file|agenda|list|schedule|mind|(?:her|his|their)\s+(?:face|head|feet|plate|mind|desk|table|wall|walls|schedule|calendar|agenda|list|conscience|lips|nails)))/ },
  { category: 'undressing', pattern: /\bwearing\s+(?:absolutely\s+)?nothing\b(?!\s+(?:special|fancy|much|else|flashy|formal|expensive|fashionable|new|bright|colorful|colourful|on\s+(?:it|the|her\s+(?:face|head|feet))))/ },
  { category: 'undressing', pattern: /\b(?:not|isn t|isnt|aren t|arent|wasn t|wasnt|without)\s+wearing\s+(?:any\s+)?(?:clothes|clothing|anything)\b/ },
  { category: 'undressing', pattern: /\b(?:no|without(?:\s+any)?)\s+(?:clothes|clothing)\b(?!\s+(?:hanging|hung|in\s+the|inside|left|to\s+wear|on\s+the\s+(?:rack|hanger|hangers|floor|line|bed)|rack|racks|hangers?|store|shop|brand|label))/ },
  // Cloth taken off a person, however the cloth is named: "remove the cloth
  // fabric from the woman", "take the towel off her".
  { category: 'undressing', pattern: new RegExp(`\\b${TAKE_AWAY}\\s+(?:off\\s+|away\\s+)?(?:all\\s+(?:of\\s+)?)?(?:the\\s+|that\\s+|this\\s+|any\\s+|every\\s+)?(?:\\w+\\s+){0,2}?${CLOTH}\\s+(?:\\w+\\s+)?(?:from|off|off\\s+of)\\s+${TAKEN_FROM}\\b`) },
  // "erase the dress": a worn garment removed and nothing put in its place.
  { category: 'undressing', pattern: new RegExp(
    `\\b(?:remove|removes|removing|removed|erase|erases|erasing|erased|delete|deletes|deleting|deleted|(?:get|gets|getting|got)\\s+rid\\s+of|(?:take|takes|taking|took|strip|strips|stripping)\\s+(?:off|away)|(?:rip|tear|pull|peel|cut)\\s+off|wipe\\s+away)\\s+(?:the|that|this|those|these)\\s+(?:\\w+\\s+)?${WORN_GARMENT}\\b`
    + `(?!\\s+${GARMENT_DETAIL}\\b)`
    + `(?!\\s+(?:from|off|on|in|at|near|behind|beside|hanging|lying|laying|draped|folded)\\s+(?:on\\s+|from\\s+|over\\s+)?(?:the\\s+|a\\s+|an\\s+)?${GARMENT_PLACE}\\b)`
    + `(?!.*\\b(?:replace|replaces|replaced|replacing|swap|swaps|swapped|swapping|instead)\\b(?!\\s+(?:it|them)\\s+(?:with|for|to|into)\\s+${SWAPPED_FOR_NOTHING}\\b))`,
  ) },
  // A garment that leaves by itself: "her dress disappears", "her top comes off".
  { category: 'undressing', pattern: new RegExp(`\\b(?:(?:her|his|their)\\s+(?:\\w+\\s+)?${GARMENT_OR_TOPS}|the\\s+(?:\\w+\\s+)?${THE_WORN})\\s+(?:slowly\\s+|suddenly\\s+|magically\\s+|completely\\s+|just\\s+|all\\s+|then\\s+|to\\s+|should\\s+|will\\s+|starts?\\s+to\\s+|begins?\\s+to\\s+)*${GOES_AWAY}\\b(?!\\s+(?:into|to|as|the\\s+shoulder|shoulder|shoulders|one\\s+shoulder|screen|camera|stage|duty|road|track|season|guard|balance|rack|racks|hanger|hangers|white)\\b)`) },
  // Someone shown without what they wear. A shirtless man is as allowed as
  // "his shirt off" is above, so "his" covers less than "her".
  { category: 'undressing', pattern: /\b(?:without|minus|sans)\s+(?:any\s+of\s+)?(?:(?:her|their)\s+(?:\w+\s+)?(?:clothes|clothing|garments?|outfit|outfits|dress|gown|shirt|t shirt|tshirt|blouse|top|bra|pants|trousers|jeans|skirt|shorts|underwear|panties|knickers|lingerie|bikini|swimsuit|swimwear|bodysuit|leotard|nightgown|nightie|nightdress|towel|robe|saree|sari|kurti|uniform)|his\s+(?:\w+\s+)?(?:clothes|clothing|garments?|outfit|pants|trousers|jeans|underwear|boxers|briefs|towel|robe|uniform))\b(?!\s+(?:shoes|code|sense|size|collection|line|brand|designer|maker|rehearsal))/ },

  // See-through or x-ray views of what someone is wearing.
  { category: 'see_through_clothing', pattern: new RegExp(`\\b${SEE_THROUGH}\\s+(?:${WORN_BY_PERSON_WITH_TOPS}|(?:the\\s+|a\\s+|an\\s+)?${CLOTHING})\\b`) },
  { category: 'see_through_clothing', pattern: new RegExp(`\\b(?:transparent|x\\s*ray|xray)\\s+(?:${WORN_BY_PERSON_WITH_TOPS}|${CLOTHING})\\b`) },
  { category: 'see_through_clothing', pattern: new RegExp(`\\b${CLOTHING}\\s+(?:that\\s+(?:is|are)\\s+|which\\s+(?:is|are)\\s+|is\\s+|are\\s+|made\\s+|turned\\s+|turning\\s+|becomes?\\s+|became\\s+|goes\\s+|went\\s+)?(?:${SEE_THROUGH}|transparent)\\b`) },
  { category: 'see_through_clothing', pattern: /\b(?:x\s*ray|xray)\s+(?:(?:vision|scan|view|filter|camera|glasses|goggles|mode)\s+)?(?:through\s+)?(?:her|his|their|them|him)\b/ },
  // The view under a garment: "what is under her dress", "look up her skirt".
  { category: 'see_through_clothing', pattern: new RegExp(`\\b(?:what\\s+(?:is|s|lies|was)|whats|everything|anything|all)\\s+(?:that\\s+is\\s+|that\\s+s\\s+|hidden\\s+|hiding\\s+)?(?:underneath|under|beneath)\\s+(?:her|his|their|the|that|those|all\\s+(?:of\\s+)?(?:her|his|their|the|those))\\s+(?:\\w+\\s+)?${GARMENT_OR_TOPS}\\b(?!\\s+code)`) },
  { category: 'see_through_clothing', pattern: /\b(?:see|sees|seeing|look|looks|looking|peek|peeks|peeking|peep|peeping|glimpse|view|camera)\s+(?:right\s+|straight\s+)?(?:under|underneath|beneath|up)\s+(?:her|their)\s+(?:\w+\s+)?(?:clothes|clothing|garments?|outfit|dress|skirt|skirts|towel|robe|kilt|nightgown|nightie)\b/ },

  // Nudity itself.
  { category: 'nudity', pattern: /\b(?:nude|nudes|nudity|naked|nakedness|nudist|nudists|nudism|topless)\b/ },
  { category: 'nudity', pattern: /\b(?:in\s+the\s+(?:nude|buff)|birthday\s+suit|full\s+frontal)\b/ },
  { category: 'nudity', pattern: /\b(?:nipple|nipples|areola|areolas|areolae|genital|genitals|genitalia|vagina|vaginas|vaginal|vulva|vulvas|penis|penises)\b/ },
  { category: 'nudity', pattern: /\b(?:bare|naked|exposed|uncovered|visible)\s+(?:breast|breasts|butt|buttocks|bum|crotch)\b/ },
  { category: 'nudity', pattern: /\b(?:show|shows|showing|showed|expose|exposes|exposing|exposed|reveal|reveals|revealing|revealed|flash|flashes|flashing|flashed|uncover|uncovers|uncovering|uncovered)\s+(?:her|his|their)\s+(?:breasts|boobs|butt|buttocks|crotch|genitals|privates|private parts)\b/ },
  // Hindi, Spanish, Portuguese and German words people type for the same request.
  { category: 'nudity', pattern: /\b(?:nangi|desnuda|desnudas|desnudo|desnudos|desnudar|desnudarla|nackt|nackte|nackten|sin\s+ropa|sem\s+roupa|ohne\s+kleidung)\b/ },
  { category: 'nudity', pattern: /\b(?:porn|porno|pornography|pornographic|pornstar|pornstars|nsfw|hentai)\b/ },
  // "au naturel" is also how people ask for bare-faced makeup and natural hair.
  { category: 'nudity', pattern: /(?<!\b(?:makeup|make up|hair|hairstyle|look|skin|beauty|nails|face|curls|lashes|brows)\s+(?:is\s+|goes\s+|going\s+|went\s+|kept\s+|left\s+|worn\s+|styled\s+)?)\bau\s+natur(?:el|elle|ale|al)\b(?!\s+(?:makeup|make up|look|looks|beauty|hair|hairstyle|style|skin|glow|face|curls|nails|lashes|brows|lips|finish|shade|shades|tone|tones|color|colour))/ },
  { category: 'nudity', pattern: /\b(?:unclad|clothesless|starkers|in\s+the\s+altogether)\b/ },
  // "wearing only heels", "dressed in nothing but body paint".
  { category: 'nudity', pattern: new RegExp(`\\b(?:wear|wears|wearing|wore|worn|dressed|clad|clothed)\\s+(?:in\\s+|with\\s+)?${ONLY}\\s+(?:in\\s+|with\\s+)?${NOT_CLOTHES}\\b${NOT_SKIN_TIGHT}`) },
  // "cover her only with her hands". A cake covered only with petals has no "her".
  { category: 'nudity', pattern: new RegExp(`\\b(?:cover|covers|covered|covering)\\s+(?:up\\s+)?(?:her|him|them|herself|himself|themselves|(?:her|his|their)\\s+(?:\\w+\\s+)?(?:body|bodies|chest|breasts|modesty))\\s+(?:up\\s+)?${ONLY}\\s+(?:in\\s+|with\\s+|by\\s+)?${NOT_CLOTHES}\\b${NOT_SKIN_TIGHT}`) },
  { category: 'nudity', pattern: new RegExp(`\\b(?:she|he|they|woman|women|man|men|girl|lady|person|model|body|bodies)\\s+(?:is\\s+|are\\s+|was\\s+|were\\s+)?covered\\s+${ONLY}\\s+(?:in\\s+|with\\s+|by\\s+)?${NOT_CLOTHES}\\b${NOT_SKIN_TIGHT}`) },
  // A body said to be exposed or bare, which is not "exposed body panels" or
  // skin "exposed to the sun".
  { category: 'nudity', pattern: /\b(?:fully|completely|totally|entirely|wholly)\s+exposed\s+(?:body|bodies|woman|women|man|men|girl|lady|person|model|figure|chest|torso)\b(?!\s+(?:panel|panels|work|kit|shell|frame|armor|armour|parts?))/ },
  { category: 'nudity', pattern: /\b(?:her|his|their)\s+(?:whole\s+|entire\s+)?(?:body|bodies)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:fully\s+|completely\s+|totally\s+|entirely\s+)?(?:exposed|uncovered|bared|on\s+full\s+display)\b(?!\s+to\s+(?:the\s+)?(?:sun|sunlight|elements|cold|wind|rain|light|air|weather|danger|radiation|heat|water))/ },
  { category: 'nudity', pattern: /\b(?:expose|exposes|exposing|uncover|uncovers|uncovering|bare|bares|baring)\s+(?:(?:her|his|their)\s+(?:whole\s+|entire\s+|full\s+|bare\s+)?(?:body|bodies)|(?:her|their)\s+(?:bare\s+)?(?:chest|torso))\b(?!\s+to\s+(?:the\s+)?(?:sun|sunlight|elements|cold|wind|rain|light|air|weather|danger|radiation|heat|water))/ },
  { category: 'nudity', pattern: /\bbare\s+(?:body|bodies|bodied)\b(?!\s+(?:of\s+(?:a|an|the)\s+(?:\w+\s+)?(?:guitar|car|violin|bass|truck|bike|vehicle|plane|ship|boat|instrument|machine|robot)|care|lotion|wash|oil|butter|scrub|cream|products?|panel|panels|shell|frame|kit|work))/ },
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
