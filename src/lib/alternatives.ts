/**
 * Comparison pages for tools people evaluate alongside this one.
 *
 * These name real competitors, so two rules govern what goes in them.
 *
 * First, no competitor pricing figures. Their plans change, a stale number on a
 * public page is worse than no number, and quoting one as fact invites a
 * correction nobody will send. Each entry links to the competitor's own pricing
 * page and compares the *shape* of the pricing instead — subscription tiers with
 * a monthly video allowance versus per-generation cost — which is a structural
 * difference that stays true when the numbers move.
 *
 * Second, `strongerAt` is not optional and is not a hedge. A comparison page
 * that finds no case for the competitor is an advertisement, and readers can
 * tell. Being accurate about where someone else wins is what makes the rest of
 * the page worth believing — and it is the only version worth being cited by an
 * AI answer, which is where a growing share of this kind of query is resolved.
 */

export type AlternativeEntry = {
    slug: string;
    /** The competitor's own name, spelled as they spell it. */
    competitor: string;
    /** Their pricing page, so the reader gets current numbers from the source. */
    pricingUrl: string;
    /** One line on what they are, written the way they would recognise. */
    positioning: string;
    /** What they are genuinely better at. Required, and written to be true. */
    strongerAt: string[];
    /** Where this product differs, phrased as a difference rather than a win. */
    differences: Array<{ heading: string; body: string }>;
    /** Who each tool actually suits, so a reader can self-select honestly. */
    chooseThem: string;
    chooseUs: string;
    faqs: Array<{ question: string; answer: string }>;
};

export const ALTERNATIVES: AlternativeEntry[] = [
    {
        slug: 'arcads-alternative',
        competitor: 'Arcads',
        pricingUrl: 'https://www.arcads.ai/pricing',
        positioning:
            'Arcads is built specifically for direct-response UGC ads, with a large library of licensed AI actors and a workflow that goes from script to finished talking-head ad in one pass.',
        strongerAt: [
            'A large roster of ready-made AI actors, so you can start without sourcing or generating a persona yourself.',
            'A workflow purpose-built for one job — script in, creator-style ad out — with fewer decisions along the way.',
            'Built-in voice and lip sync across many languages, which makes localised variants of the same ad straightforward.',
        ],
        differences: [
            {
                heading: 'You pay per generation, not per month',
                body: 'Arcads sells monthly plans with a video allowance attached. That is simple to reason about and wasteful in both directions: a slow month leaves allowance unused, and a heavy testing week runs out. Here you buy credits, each generation costs a published number of them, and credits do not expire while your account is active — so a quiet month costs nothing and a heavy one costs exactly what it used.',
            },
            {
                heading: 'More than talking heads',
                body: 'Arcads is focused on presenter-led ads. This is a general media studio: image generation, text-to-video for staged product scenes, motion transfer for presenter work, and reusable workflows that chain them. If your creative is entirely AI actors reading scripts, that breadth is not worth paying attention to. If you also need product shots, b-roll, and hook frames, it is the difference between one tool and four.',
            },
            {
                heading: 'You choose the model',
                body: 'Rather than one pipeline, generations run on a catalog of image, video, and motion models with different cost and quality profiles, and the per-generation cost of each is published before you run anything. That makes tiered testing possible — explore broadly on inexpensive models, re-run only the winner on an expensive one.',
            },
        ],
        chooseThem:
            'Choose Arcads if your creative is presenter-led ads and little else, you want a large actor library without building personas yourself, and a predictable monthly bill matters more than paying only for what you use.',
        chooseUs:
            'Choose magicbooklet if your output volume is uneven, if you need images and staged video as well as presenter work, or if you want to see and control what each generation costs.',
        faqs: [
            {
                question: 'Is magicbooklet a direct replacement for Arcads?',
                answer:
                    'Not exactly. Arcads is a focused tool for presenter-led UGC ads with a large ready-made actor library. magicbooklet is a broader studio — image, video, motion transfer, and workflows — priced per generation. If presenter ads are all you make, Arcads is the more specialised fit.',
            },
            {
                question: 'How does the pricing differ?',
                answer:
                    'Arcads sells monthly plans that include a set number of videos. magicbooklet sells credits that do not expire, and every generation has a published credit cost you see before running it. Uneven output favours credits; steady, predictable output favours a subscription.',
            },
            {
                question: 'Do I need to bring my own AI actor?',
                answer:
                    'You supply a persona image, which you can generate here in a few minutes. That is more setup than picking from a library, and it means the persona is yours and consistent across every campaign you use it in.',
            },
        ],
    },
    {
        slug: 'creatify-alternative',
        competitor: 'Creatify',
        pricingUrl: 'https://creatify.ai/pricing',
        positioning:
            'Creatify turns a product URL into ad variations quickly, with a large template library, AI avatars, and integrations that push creative straight into ad platforms.',
        strongerAt: [
            'URL-to-video: point it at a product page and get ad variations without assembling inputs yourself.',
            'A large library of ad templates and avatars, which shortens the path from nothing to a first draft.',
            'Direct ad-platform integrations, so creative can move toward launch without leaving the tool.',
        ],
        differences: [
            {
                heading: 'Credits that do not expire',
                body: 'Creatify plans include a monthly credit allowance on a rolling expiry, so unused credits lapse. Credits here do not expire while your account is active. That difference matters most for teams whose testing comes in bursts around launches rather than at a steady weekly rate.',
            },
            {
                heading: 'Published per-generation cost',
                body: 'When credit cost per video varies by length, avatar, and quality, it is hard to know what a plan actually buys until you have spent it. Every model here publishes its per-generation cost before you run it, and there is a page listing all of them, so a testing budget can be planned rather than discovered.',
            },
            {
                heading: 'Motion transfer as a first-class tool',
                body: 'Holding one persona constant across an entire campaign is a different operation from generating an avatar per ad. Motion transfer takes a persona still and a reference performance you direct yourself, which fixes identity by construction and puts the delivery under your control rather than a preset’s.',
            },
        ],
        chooseThem:
            'Choose Creatify if you want the fastest path from a product URL to a first draft, you value a large template library, and pushing creative directly into ad platforms is part of your workflow.',
        chooseUs:
            'Choose magicbooklet if your testing is bursty rather than steady, if you want per-generation costs visible before you commit, or if consistent persona identity across a campaign matters more than template variety.',
        faqs: [
            {
                question: 'Does magicbooklet generate ads from a product URL?',
                answer:
                    'No. You supply the inputs — a prompt, a reference frame, a persona, a script. That is more work up front and more control over the result. URL-to-video is genuinely faster to a first draft, and Creatify is better at it.',
            },
            {
                question: 'What happens to unused credits?',
                answer:
                    'They stay on your account while it remains active. There is no rolling expiry, so a quiet month does not cost you the balance you already bought.',
            },
            {
                question: 'Can I see what a video will cost before generating it?',
                answer:
                    'Yes. Every model publishes a per-generation credit cost, the studio shows the exact figure for your settings before you run anything, and the model pages list costs for every model side by side.',
            },
        ],
    },
    {
        slug: 'heygen-alternative',
        competitor: 'HeyGen',
        pricingUrl: 'https://www.heygen.com/pricing',
        positioning:
            'HeyGen is the established platform for AI avatar and presenter video, with a very large avatar library, strong lip sync, and translation across many languages.',
        strongerAt: [
            'Avatar quality and lip sync, which is the category it has invested in longest.',
            'Translation and re-voicing at scale, with lip movement re-synced per language — the strongest option if multilingual is a core requirement.',
            'Enterprise features: team management, brand controls, and the compliance posture larger organisations ask for.',
        ],
        differences: [
            {
                heading: 'Ad creative, not corporate video',
                body: 'HeyGen serves a broad range of business video — training, internal comms, sales outreach, localisation. This product is aimed at ad creative specifically, which shows in what it optimises for: hook testing, campaign-scale variation, and per-generation cost visibility rather than avatar breadth.',
            },
            {
                heading: 'Images and staged scenes, not only presenters',
                body: 'A UGC ad is rarely all talking head. Hook frames, product shots, and staged b-roll usually carry as much of the work, and those are image and text-to-video jobs rather than avatar jobs. Both live here alongside motion transfer, chained by workflows.',
            },
            {
                heading: 'Seat-free, usage-based pricing',
                body: 'HeyGen prices per seat and per plan tier. Credits here attach to the account and are spent per generation, which suits a small team producing a lot more than it suits a large team producing a little.',
            },
        ],
        chooseThem:
            'Choose HeyGen if avatar realism and lip sync are the deciding factor, if you need translation into many languages with re-synced lips, or if you need enterprise team and brand controls.',
        chooseUs:
            'Choose magicbooklet if you are making ad creative rather than corporate video, if you need images and staged scenes alongside presenter work, or if you would rather pay per generation than per seat.',
        faqs: [
            {
                question: 'Is magicbooklet cheaper than HeyGen?',
                answer:
                    'It depends entirely on volume and team size, and anyone claiming otherwise without knowing both is guessing. HeyGen prices per seat and plan; magicbooklet prices per generation with credits that do not expire. A small team generating heavily tends to favour the second; a large team generating occasionally tends to favour the first.',
            },
            {
                question: 'Does magicbooklet do avatar translation?',
                answer:
                    'No. Multilingual avatar video with re-synced lip movement is a HeyGen strength and not something this product targets. You can produce a separate motion-transfer clip per language from a per-language reference performance, which is more manual.',
            },
            {
                question: 'What does magicbooklet do that HeyGen does not?',
                answer:
                    'Image generation and text-to-video for staged product scenes sit alongside presenter work, with reusable workflows chaining them, and every model publishes its per-generation cost up front.',
            },
        ],
    },
];

export function findAlternative(slug: string): AlternativeEntry | null {
    return ALTERNATIVES.find((entry) => entry.slug === slug) ?? null;
}
