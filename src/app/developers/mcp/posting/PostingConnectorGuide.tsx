import Link from 'next/link';
import { BookOpenText, ImageUp, PenLine, Plug, Send, ShieldCheck } from 'lucide-react';

import { Kicker, SectionHeader, Surface, Text } from '@/components/DesignSystem';
import { JsonLd } from '@/components/JsonLd';
import {
  MCP_POSTS_PAGE_PATH,
  MCP_POSTS_PROTECTED_RESOURCE_METADATA_URL,
  MCP_POSTS_SERVER_URL,
} from '@/lib/mcp-client-directory';
import { MCP_POSTS_TOOL_SUMMARIES } from '@/lib/mcp-posts-tool-summaries';
import { buildBreadcrumbSchema } from '@/lib/seo';

import CopyableCode from '../CopyableCode';
import { CONTROLS, Code, HighlightGrid, StepList, type Highlight, type SetupStep } from '../McpDeveloperGuide';

const CAPABILITIES: Highlight[] = [
  {
    icon: ImageUp,
    title: 'Post media you made elsewhere',
    body: 'Give Claude a picture or a video from another tool by its link, and it posts it under your name, saying what made it. Up to five files in one post.',
  },
  {
    icon: PenLine,
    title: 'Write a text post',
    body: 'A post can be words alone: a title and a note, a tip or an update, posted under your name.',
  },
  {
    icon: BookOpenText,
    title: 'Share prompts, guides and skills',
    body: 'Claude can attach a prompt, a guide or a whole skill to a post, free or at a price you approve, on your profile, in Explore and in the Marketplace.',
  },
  {
    icon: Send,
    title: 'Publish a finished creation',
    body: 'Something you already made on Magic Booklet can go from your library to your profile when you ask.',
  },
];

const EXAMPLES = [
  'Post this image to my Magic Booklet profile as a private post, titled “Studio lighting test”. It was made with Midjourney.',
  'Write a text post on Magic Booklet sharing the prompt we just wrote, as a free prompt card.',
  'List my Magic Booklet creations and publish the newest finished one with the title “Morning ad, take two”.',
];

function connectSteps(claudeClientId: string): { directory: SetupStep[]; byUrl: SetupStep[] } {
  return {
    directory: [
      { text: <>In Claude, open <strong>Customize → Connectors</strong> and search for <strong>Magic Booklet</strong>.</> },
      { text: <>Choose <strong>Connect</strong>. Magic Booklet opens in your browser, names the app and lists what it may do.</> },
      { text: <>Choose <strong>Allow</strong>. Claude can now post for you; ask it in your own words.</> },
    ],
    byUrl: [
      { text: <>In Claude, open <strong>Customize → Connectors</strong> and choose <strong>Add custom connector</strong>.</> },
      {
        text: <>Name it Magic Booklet and enter the server URL.</>,
        code: { value: MCP_POSTS_SERVER_URL, label: 'the posting server URL' },
      },
      {
        text: <>Open <strong>Advanced settings</strong> and enter this client ID. Leave the secret blank.</>,
        code: { value: claudeClientId, label: 'the Claude client ID' },
      },
      { text: <>Choose <strong>Add</strong>, then <strong>Connect</strong>, and allow it on Magic Booklet.</> },
    ],
  };
}

/**
 * The public page of the posting-only MCP server (`/developers/mcp/posting`): what the connector
 * does and does not do, how to connect it, its tools, and what it reads and writes. It is the
 * documentation the directory listing links to, so it describes that server alone.
 */
export default function PostingConnectorGuide({ claudeClientId }: { claudeClientId: string }) {
  const steps = connectSteps(claudeClientId);

  return (
    <main className="ui-page">
      <JsonLd
        data={[
          buildBreadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Posting connector', path: MCP_POSTS_PAGE_PATH },
          ]),
        ]}
      />

      <div className="studio-shell py-12 sm:py-16">
        <div className="ui-section-gap mx-auto max-w-5xl">
          <header className="max-w-3xl space-y-6">
            <Kicker icon={Plug}>Connector</Kicker>
            <Text as="h1" variant="pageTitle">Post to Magic Booklet from Claude</Text>
            <Text variant="body" className="text-lg leading-8">
              Magic Booklet is a community for AI media. This connector lets Claude publish to your profile: pictures
              and videos you made elsewhere, text posts, and the prompts, guides or skills you want to share. It
              creates no media and spends no credits.
            </Text>
            <div className="space-y-2">
              <Text variant="label">Server URL</Text>
              <CopyableCode code={MCP_POSTS_SERVER_URL} label="the posting server URL" />
            </div>
          </header>

          <section className="space-y-8">
            <SectionHeader eyebrow="What it can do" title="What Claude can do once connected" />
            <HighlightGrid items={CAPABILITIES} />
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="Before it posts" title="You decide what goes public" />
            <Surface variant="soft" padding="lg" className="flex gap-4">
              <ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-[var(--ui-primary)]" aria-hidden />
              <div className="max-w-3xl space-y-3">
                <Text>
                  A post is public as soon as it is published, unless you ask for a private one, which only you see
                  until you make it public. Claude is told to check with you before it publishes and to give you the
                  post’s link after. A post Claude publishes follows the same rules and moderation as one you publish
                  yourself, and you can delete it from Claude or on the site.
                </Text>
                <Text>
                  A prompt, a guide or a skill you share is free unless you name a price. Claude never chooses one:
                  it states the price you gave and waits for your yes. An account can publish ten public posts a day
                  through an agent.
                </Text>
              </div>
            </Surface>
          </section>

          <section className="space-y-8">
            <SectionHeader eyebrow="Your account" title="Your account stays in control" />
            <HighlightGrid items={CONTROLS} />
          </section>

          <section className="space-y-8">
            <SectionHeader
              eyebrow="Set up"
              title="Connect it"
              description="You need a Magic Booklet account. A guest session is asked to sign in or create one first."
            />
            <div className="grid gap-6 md:grid-cols-2">
              <Surface as="article" variant="card" padding="lg" className="space-y-5">
                <Text as="h3" variant="cardTitle">From Claude’s connectors</Text>
                <StepList steps={steps.directory} />
              </Surface>
              <Surface as="article" variant="card" padding="lg" className="space-y-5">
                <Text as="h3" variant="cardTitle">By URL</Text>
                <StepList steps={steps.byUrl} />
              </Surface>
            </div>
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="Try it" title="Things to ask" />
            <ul className="max-w-3xl space-y-3">
              {EXAMPLES.map((example) => (
                <li key={example}><Text>{example}</Text></li>
              ))}
            </ul>
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="Tools" title="The six tools" />
            <div className="grid gap-4 md:grid-cols-2">
              {MCP_POSTS_TOOL_SUMMARIES.map((tool) => (
                <Surface as="article" key={tool.name} variant="card" padding="lg">
                  {/* The test hook sits on this wrapper: Surface passes on no data attribute. */}
                  <div data-tool={tool.name}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Code>{tool.name}</Code>
                      <Text as="span" variant="label">{tool.readOnly ? 'Reads' : 'Writes'}</Text>
                    </div>
                    <Text variant="bodySm" className="mt-3">{tool.summary}</Text>
                  </div>
                </Surface>
              ))}
            </div>
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="Your data" title="What it reads and writes" />
            <ul className="max-w-3xl space-y-3">
              <li>
                <Text>
                  It reads the list of your own creations and the posts you ask about. It never reads what a paid
                  resource holds, or anything of another account’s that is not public.
                </Text>
              </li>
              <li>
                <Text>
                  It writes the posts you ask for and the files you give it to post. Each call is recorded with the
                  tool’s name and its outcome, never with your words or files.
                </Text>
              </li>
              <li>
                <Text>
                  More in the{' '}
                  <Link className="ui-focus-ring rounded-lg font-semibold text-[var(--ui-primary)] underline-offset-4 hover:underline" href="/privacy">
                    privacy policy
                  </Link>{' '}
                  and the{' '}
                  <Link className="ui-focus-ring rounded-lg font-semibold text-[var(--ui-primary)] underline-offset-4 hover:underline" href="/terms">
                    terms
                  </Link>
                  . Questions go to{' '}
                  <Link className="ui-focus-ring rounded-lg font-semibold text-[var(--ui-primary)] underline-offset-4 hover:underline" href="/contact">
                    our contact page
                  </Link>
                  .
                </Text>
              </li>
            </ul>
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="For developers" title="How the server works" />
            <ul className="max-w-3xl space-y-3">
              <li><Text>Streamable HTTP at <Code>{MCP_POSTS_SERVER_URL}</Code>, stateless, answering in JSON.</Text></li>
              <li>
                <Text>
                  OAuth 2.1 with PKCE through Magic Booklet’s sign-in. The protected-resource metadata is at{' '}
                  <Code>{MCP_POSTS_PROTECTED_RESOURCE_METADATA_URL}</Code>.
                </Text>
              </li>
              <li>
                <Text>
                  A tool answers in text and structured content; a refusal carries a code such as{' '}
                  <Code>NOT_FOUND</Code> or <Code>RATE_LIMITED</Code> with what to do next.
                </Text>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
