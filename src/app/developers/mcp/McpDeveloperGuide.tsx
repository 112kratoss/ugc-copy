import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  BookOpenText,
  CheckCircle2,
  Clock,
  Coins,
  ImageUp,
  KeyRound,
  PenLine,
  Plug,
  Send,
  ShieldCheck,
  Sparkles,
  Timer,
  Unplug,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Kicker, Pill, SectionHeader, Surface, Text } from '@/components/DesignSystem';
import { JsonLd } from '@/components/JsonLd';
import {
  CLAUDE_CODE_CALLBACK_PORT,
  MCP_DEVELOPERS_PAGE_PATH,
  MCP_PLUGIN_INSTALL_COMMAND,
  MCP_PLUGIN_MARKETPLACE_ADD_COMMAND,
  MCP_PROTECTED_RESOURCE_METADATA_URL,
  MCP_SERVER_KEY,
  MCP_SERVER_URL,
  claudeCodeAddCommand,
  codexAddCommand,
  codexConfigToml,
  codexLoginCommand,
  cursorMcpJson,
  isPendingClientId,
  type McpClientIds,
  type McpClientSurface,
} from '@/lib/mcp-client-directory';
import { buildBreadcrumbSchema, buildFaqSchema } from '@/lib/seo';

import { PROMPT_ENHANCEMENT_COST_CREDITS } from '../../../../ugc-mobile/lib/model-catalog/protocol';
import CopyableCode from './CopyableCode';
import { connectSentence } from './mcp-page-copy';

const ENHANCEMENT_COST = `${PROMPT_ENHANCEMENT_COST_CREDITS} credit${PROMPT_ENHANCEMENT_COST_CREDITS === 1 ? '' : 's'}`;

type Highlight = { icon: LucideIcon; title: string; body: ReactNode };

const CAPABILITIES: Highlight[] = [
  {
    icon: Sparkles,
    title: 'Create images and videos with your credits',
    body: 'Your agent picks from the models the site offers, prices a run and starts it. What it makes lands in your library like anything you create yourself.',
  },
  {
    icon: Timer,
    title: 'Check progress',
    body: 'It follows a run until the image or video is ready, hands you its link, and can look through what you have already made.',
  },
  {
    icon: Send,
    title: 'Publish a creation as a post',
    body: 'When you ask, it posts a finished creation to your profile and Explore, under your name and with the rules every post follows.',
  },
  {
    icon: ImageUp,
    title: 'Post media made elsewhere',
    // What every client can do comes first; a file on the computer needs an app that runs commands there.
    body: 'Give it a picture or video from another tool by its link, and it posts it under your name, saying what made it. In Claude Code, Codex and Cursor, which can run commands on your computer, it can also send a file from there.',
  },
  {
    icon: PenLine,
    title: 'Write a text post',
    body: 'A post can be words alone. Your agent gives it a title and a note, a tip or an update, and posts it under your name.',
  },
  {
    icon: BookOpenText,
    title: 'Share prompts, guides and skills',
    // One sentence, the consent screen's own terms: free, or at a price the person approves.
    body: 'It can attach a prompt, a guide or a whole skill to a text post or to media made elsewhere, free or at a price you approve, on your profile, in Explore and in the Marketplace.',
  },
];

const CONTROLS: Highlight[] = [
  {
    icon: ShieldCheck,
    title: 'You approve each app',
    body: 'An app connects only after you allow it on a Magic Booklet page that names it and lists what it may do. A guest session is asked to sign in first.',
  },
  {
    icon: Unplug,
    title: 'Disconnect any time',
    body: (
      <>
        {/* No prefetch: a public page does not fetch a signed-in route's payload on sight. */}
        <Link
          className="ui-focus-ring rounded-lg font-semibold text-[var(--ui-primary)] underline-offset-4 hover:underline"
          href="/profile/edit"
          prefetch={false}
        >
          Connected apps
        </Link>{' '}
        on your profile lists every app you allowed. Disconnect one there and its next call is refused; signing out
        everywhere ends them all.
      </>
    ),
  },
  {
    icon: KeyRound,
    title: 'A one-hour sign-in',
    body: 'An app holds a sign-in that lasts an hour and renews only while it stays connected. It never sees your password, and your account’s limits apply to it as they do to you.',
  },
];

/** The questions, as plain strings: the same array draws the cards and the FAQ structured data. */
const FAQS = [
  {
    question: 'Does connecting an agent cost anything?',
    answer: `Connecting is free, and so is pricing a run. Credits are spent only when your agent starts a run, at the price it showed you, or enhances a prompt, a fixed ${ENHANCEMENT_COST} a call.`,
  },
  {
    question: 'Can an agent spend more than it quoted?',
    answer: 'No. A run is never charged above the price your agent confirmed: if the price changes before the run starts, nothing is charged and the agent has to quote again. Agents cannot buy credits.',
  },
  {
    question: 'How do I disconnect an app?',
    answer: 'Open Connected apps on your profile and disconnect it, and its next call is refused. Signing out everywhere ends every app’s access at once.',
  },
  {
    question: 'Which accounts can connect?',
    answer: 'Any Magic Booklet account. A guest session is asked to sign in or create an account first, because the agent works with that account’s credits and posts.',
  },
];

function Code({ children }: { children: ReactNode }) {
  return <Text as="code" variant="code" className="text-[var(--ui-text-primary)]">{children}</Text>;
}

type SetupStep = { text: ReactNode; code?: { value: string; label: string } };

type ClientSetup = {
  surface: McpClientSurface;
  /** The block's anchor on the page, `/developers/mcp#<anchor>`. */
  anchor: string;
  name: string;
  steps: SetupStep[];
  /** A second way in, under the steps: the Claude Code plugin. */
  alternative?: { title: string; text: ReactNode; steps: SetupStep[] };
  note?: ReactNode;
};

function clientSetups(clientIds: McpClientIds): ClientSetup[] {
  // Each copy button names its client, so a screen reader's list of them tells them apart.
  const serverUrlStep = (text: ReactNode, client: string): SetupStep => ({
    text,
    code: { value: MCP_SERVER_URL, label: `the ${client} server URL` },
  });

  return [
    {
      surface: 'claude',
      anchor: 'claude',
      name: 'Claude.ai and Claude Desktop',
      steps: [
        { text: <>In Claude, open <strong>Customize → Connectors</strong> and choose <strong>Add custom connector</strong>.</> },
        serverUrlStep(<>Name it Magic Booklet and enter the server URL.</>, 'Claude'),
        {
          text: (
            <>
              Open <strong>Advanced settings</strong> (or, if the dialog asks how Claude identifies itself, choose{' '}
              <strong>Use your own OAuth client</strong>) and enter this client ID. Leave the secret blank.
            </>
          ),
          code: { value: clientIds.claude, label: 'the Claude client ID' },
        },
        { text: <>Choose <strong>Add</strong>, then <strong>Connect</strong>. Magic Booklet opens in your browser and asks you to allow Claude.</> },
      ],
      note: 'A connector added on claude.ai also works in Claude Desktop and the Claude mobile apps.',
    },
    {
      surface: 'claudeCode',
      anchor: 'claude-code',
      name: 'Claude Code',
      steps: [
        {
          text: 'Add the server from any terminal. It is added for your user, so every project you open in Claude Code has it.',
          code: { value: claudeCodeAddCommand(clientIds.claudeCode), label: 'the Claude Code command' },
        },
        {
          text: (
            <>
              In Claude Code, run <Code>/mcp</Code>, pick <Code>{MCP_SERVER_KEY}</Code> and choose{' '}
              <strong>Authenticate</strong>. Your browser opens on Magic Booklet; once you allow it, Claude Code shows the
              server as connected.
            </>
          ),
        },
      ],
      alternative: {
        title: 'Or install the plugin',
        text: 'The Magic Booklet plugin adds the same server and four skills: one that takes a UGC ad from brief to post, one that publishes a creation, one that posts media made elsewhere, and one that shares a skill, a prompt or a guide. Sign in with /mcp as above. Use the command or the plugin, not both: each would add its own magicbooklet server and ask you to sign in again.',
        steps: [
          { text: 'Add the marketplace:', code: { value: MCP_PLUGIN_MARKETPLACE_ADD_COMMAND, label: 'the marketplace command' } },
          { text: 'Install the plugin:', code: { value: MCP_PLUGIN_INSTALL_COMMAND, label: 'the plugin install command' } },
        ],
      },
      note: `Signing in listens on port ${CLAUDE_CODE_CALLBACK_PORT}, so keep that port free while you sign in.`,
    },
    {
      surface: 'chatgpt',
      anchor: 'chatgpt',
      name: 'ChatGPT',
      steps: [
        {
          text: (
            <>
              In ChatGPT, open <strong>Plugins</strong>, press <strong>+</strong> and choose{' '}
              <strong>Add custom MCP server</strong>. Your workspace’s settings decide whether custom servers are allowed.
            </>
          ),
        },
        serverUrlStep(<>Name it Magic Booklet and, under <strong>Connection</strong>, enter the server URL.</>, 'ChatGPT'),
        {
          text: <>For authentication choose <strong>OAuth</strong> and enter this client ID.</>,
          code: { value: clientIds.chatgpt, label: 'the ChatGPT client ID' },
        },
        { text: <>Confirm the warning and choose <strong>Create as a plugin</strong>, then sign in to Magic Booklet and allow ChatGPT.</> },
      ],
    },
    {
      surface: 'codex',
      anchor: 'codex',
      name: 'Codex',
      steps: [
        {
          text: 'Add the server with its client ID.',
          code: { value: codexAddCommand(clientIds.codex), label: 'the Codex command' },
        },
        {
          text: (
            <>
              Codex signs in on a random port unless told otherwise, so pin it: in <Code>~/.codex/config.toml</Code>{' '}
              the server’s entry should read as below, <Code>callback_port</Code> included.
            </>
          ),
          code: { value: codexConfigToml(clientIds.codex), label: 'the Codex configuration' },
        },
        {
          text: 'Sign in, and allow Codex on Magic Booklet.',
          code: { value: codexLoginCommand(), label: 'the Codex sign-in command' },
        },
      ],
    },
    {
      surface: 'cursor',
      anchor: 'cursor',
      name: 'Cursor',
      steps: [
        {
          text: (
            <>
              Add the server to <Code>~/.cursor/mcp.json</Code> for every project, or to <Code>.cursor/mcp.json</Code>{' '}
              in one project.
            </>
          ),
          code: { value: cursorMcpJson(clientIds.cursor), label: 'the Cursor configuration' },
        },
        { text: <>Cursor lists <Code>{MCP_SERVER_KEY}</Code> in its MCP settings. Sign in there when it asks, and allow Cursor on Magic Booklet.</> },
      ],
    },
  ];
}

/** Three cards sit in a row and six in two rows of three; four sit two by two, so none is left alone on a line. */
function HighlightGrid({ items }: { items: Highlight[] }) {
  return (
    <div className={items.length === 4 ? 'grid gap-4 md:grid-cols-2' : 'grid gap-4 md:grid-cols-3'}>
      {items.map(({ icon: Icon, title, body }) => (
        <Surface as="article" key={title} variant="card" padding="lg">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <Text as="h3" variant="cardTitle" className="mt-4">{title}</Text>
          <Text variant="bodySm" className="mt-2">{body}</Text>
        </Surface>
      ))}
    </div>
  );
}

function StepList({ steps }: { steps: SetupStep[] }) {
  return (
    <ol className="space-y-5">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-4">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ui-surface-3)]"
            aria-hidden
          >
            <Text as="span" variant="label" className="text-[var(--ui-text-primary)]">{index + 1}</Text>
          </span>
          <div className="min-w-0 flex-1 space-y-3 pt-1">
            <Text variant="body">{step.text}</Text>
            {step.code ? <CopyableCode code={step.code.value} label={step.code.label} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ClientSetupBlock({
  setup,
  clientId,
  othersAvailable,
}: {
  setup: ClientSetup;
  clientId: string;
  /** Whether another client can sign in already, which a waiting block then points to. */
  othersAvailable: boolean;
}) {
  const available = !isPendingClientId(clientId);

  return (
    <Surface as="article" variant="card" padding="lg">
      {/* The anchor and the test hooks sit on this wrapper: Surface passes on no id or data attribute. */}
      <div
        id={setup.anchor}
        className="scroll-mt-24 space-y-5"
        data-client={setup.surface}
        data-client-state={available ? 'available' : 'pending'}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Text as="h3" variant="cardTitle">{setup.name}</Text>
          {available ? (
            <Pill accent="workflow" icon={CheckCircle2}>Available</Pill>
          ) : (
            <Pill icon={Clock}>Coming soon</Pill>
          )}
        </div>

        {available ? (
          <>
            <StepList steps={setup.steps} />
            {setup.alternative ? (
              <div className="space-y-4 border-t border-[var(--ui-border-subtle)] pt-5">
                <h4><Text as="span" variant="label">{setup.alternative.title}</Text></h4>
                <Text variant="bodySm">{setup.alternative.text}</Text>
                <StepList steps={setup.alternative.steps} />
              </div>
            ) : null}
            {setup.note ? <Text variant="bodySm">{setup.note}</Text> : null}
          </>
        ) : (
          <Text variant="bodySm">
            Magic Booklet is being registered as an app with {setup.name}. Its setup appears here as soon as it can
            sign in{othersAvailable ? '; until then, connect from one of the clients marked available.' : '.'}
          </Text>
        )}
      </div>
    </Surface>
  );
}

/**
 * The public setup page for the MCP server (`/developers/mcp`): what a connected agent can do,
 * how charges and the account stay in the creator's hands, and one setup block per client. A
 * block whose client id is still a placeholder shows as coming soon, with no command that could
 * not sign in. The client ids come in as a prop so a test can draw both states.
 */
export default function McpDeveloperGuide({ clientIds }: { clientIds: McpClientIds }) {
  const setups = clientSetups(clientIds);
  const anyAvailable = setups.some((setup) => !isPendingClientId(clientIds[setup.surface]));

  return (
    <main className="ui-page">
      <JsonLd
        data={[
          buildBreadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'MCP server', path: MCP_DEVELOPERS_PAGE_PATH },
          ]),
          buildFaqSchema(FAQS),
        ]}
      />

      <div className="studio-shell py-12 sm:py-16">
        <div className="ui-section-gap mx-auto max-w-5xl">
          <header className="max-w-3xl space-y-6">
            <Kicker icon={Plug}>MCP server</Kicker>
            <Text as="h1" variant="pageTitle">Connect your AI agent to Magic Booklet</Text>
            <Text variant="body" className="text-lg leading-8">
              Magic Booklet runs a remote MCP server. {connectSentence(clientIds)} A connected agent can make images and
              videos with your credits, follow each run to the end, publish the ones you choose, post media you made
              elsewhere, and write text posts that share a prompt, a guide or a skill.
            </Text>
            <div className="space-y-2">
              <Text variant="label">Server URL</Text>
              <CopyableCode code={MCP_SERVER_URL} label="the server URL" />
            </div>
          </header>

          <section className="space-y-8">
            <SectionHeader eyebrow="What it can do" title="What a connected agent can do" />
            <HighlightGrid items={CAPABILITIES} />
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="Credits" title="Every charge is quoted first" />
            <Surface variant="soft" padding="lg" className="flex gap-4">
              <Coins className="mt-1 h-5 w-5 shrink-0 text-[var(--ui-accent-commerce)]" aria-hidden />
              <div className="max-w-3xl space-y-3">
                <Text>
                  Pricing a run is free, and your agent gets the price before it creates anything. It has to send that
                  price back when it starts the run, and the run is never charged more: if the price has changed,
                  nothing is charged and your agent asks you again.
                </Text>
                <Text>
                  A run that fails gives its credits back by itself. The one charge without a price step is prompt
                  enhancement, a fixed {ENHANCEMENT_COST} a call. Agents cannot buy credits; top up on the site.
                </Text>
              </div>
            </Surface>
          </section>

          <section className="space-y-8">
            <SectionHeader eyebrow="Your account" title="Your account stays in control" />
            <HighlightGrid items={CONTROLS} />
          </section>

          <section className="space-y-8">
            <div className="space-y-5">
              <SectionHeader
                eyebrow="Set up"
                title="Connect your client"
                description="Each client signs in with its own Magic Booklet client ID, and you approve it once in your browser."
              />
              <nav aria-label="Clients" className="flex flex-wrap gap-2">
                {setups.map((setup) => (
                  <a key={setup.anchor} href={`#${setup.anchor}`} className="ui-pill ui-focus-ring hover:text-[var(--ui-text-primary)]">
                    {setup.name}
                  </a>
                ))}
              </nav>
            </div>
            <div className="space-y-6">
              {setups.map((setup) => (
                <ClientSetupBlock
                  key={setup.surface}
                  setup={setup}
                  clientId={clientIds[setup.surface]}
                  othersAvailable={anyAvailable}
                />
              ))}
            </div>
          </section>

          <section className="space-y-8">
            <SectionHeader eyebrow="Questions" title="Common questions" />
            <div className="grid gap-4 md:grid-cols-2">
              {FAQS.map((faq) => (
                <Surface as="article" key={faq.question} variant="card" padding="lg">
                  <Text as="h3" variant="cardTitle">{faq.question}</Text>
                  <Text variant="bodySm" className="mt-3">{faq.answer}</Text>
                </Surface>
              ))}
            </div>
          </section>

          <section className="space-y-6">
            <SectionHeader eyebrow="For developers" title="How the server works" />
            <ul className="max-w-3xl space-y-3">
              <li><Text>Streamable HTTP at <Code>{MCP_SERVER_URL}</Code>, stateless, answering in JSON.</Text></li>
              <li>
                <Text>
                  OAuth 2.1 with PKCE through Magic Booklet’s sign-in, with one registered client per app and no
                  dynamic registration. The protected-resource metadata is at{' '}
                  <Code>{MCP_PROTECTED_RESOURCE_METADATA_URL}</Code>.
                </Text>
              </li>
              <li>
                <Text>
                  A tool answers in text and structured content; a refusal carries a code such as{' '}
                  <Code>COST_CHANGED</Code> or <Code>INSUFFICIENT_CREDITS</Code> with what to do next.
                </Text>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
