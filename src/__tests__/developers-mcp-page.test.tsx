import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import McpDeveloperGuide from '@/app/developers/mcp/McpDeveloperGuide';
import { connectSentence, mcpPageMetadata } from '@/app/developers/mcp/mcp-page-copy';
import McpDevelopersPage, { metadata } from '@/app/developers/mcp/page';
import {
  MCP_CLIENT_IDS,
  MCP_PLUGIN_INSTALL_COMMAND,
  MCP_PLUGIN_MARKETPLACE_ADD_COMMAND,
  MCP_SERVER_URL,
  PENDING_CLIENT_ID_PREFIX,
  type McpClientIds,
  type McpClientSurface,
} from '@/lib/mcp-client-directory';

const SURFACES: Array<{ surface: McpClientSurface; name: string }> = [
  { surface: 'claude', name: 'Claude.ai and Claude Desktop' },
  { surface: 'claudeCode', name: 'Claude Code' },
  { surface: 'chatgpt', name: 'ChatGPT' },
  { surface: 'codex', name: 'Codex' },
  { surface: 'cursor', name: 'Cursor' },
];

/** Two clients registered, three still waiting: the page draws both states at once. */
const MIXED_IDS: McpClientIds = {
  claude: 'claude-web-client-id',
  claudeCode: 'claude-code-client-id',
  chatgpt: `${PENDING_CLIENT_ID_PREFIX}CHATGPT`,
  codex: `${PENDING_CLIENT_ID_PREFIX}CODEX`,
  cursor: `${PENDING_CLIENT_ID_PREFIX}CURSOR`,
};

const ALL_REGISTERED: McpClientIds = {
  claude: 'claude-web-client-id',
  claudeCode: 'claude-code-client-id',
  chatgpt: 'chatgpt-client-id',
  codex: 'codex-client-id',
  cursor: 'cursor-client-id',
};

const ALL_PENDING = Object.fromEntries(
  SURFACES.map(({ surface }) => [surface, `${PENDING_CLIENT_ID_PREFIX}${surface.toUpperCase()}`]),
) as unknown as McpClientIds;

const CLAUDE_CODE_COMMAND =
  `claude mcp add --transport http --scope user --client-id claude-code-client-id --callback-port 8976 magicbooklet ${MCP_SERVER_URL}`;
const COPY_BLOCKED = 'Copying is blocked here. Select the text and copy it yourself.';

function block(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name });
  const wrapper = heading.closest<HTMLElement>('[data-client]');
  if (!wrapper) throw new Error(`no client block around ${name}`);
  return wrapper;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('/developers/mcp', () => {
  it('is indexable at its own canonical path', () => {
    expect(metadata.alternates?.canonical).toBe('/developers/mcp');
    expect(metadata.robots).toBeUndefined();
  });

  it('draws one block per client, each available exactly when its client id is registered', () => {
    render(<McpDevelopersPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Connect your AI agent to Magic Booklet' })).toBeInTheDocument();
    for (const { surface, name } of SURFACES) {
      const pending = MCP_CLIENT_IDS[surface].startsWith(PENDING_CLIENT_ID_PREFIX);
      expect(block(name), name).toHaveAttribute('data-client-state', pending ? 'pending' : 'available');
    }
    // A placeholder is never printed, in a command or anywhere else.
    expect(document.body.textContent).not.toContain(PENDING_CLIENT_ID_PREFIX);
  });

  it('says an agent can post media made elsewhere, by link from any client and from a file only where the client runs commands', () => {
    render(<McpDeveloperGuide clientIds={ALL_REGISTERED} />);

    const heading = screen.getByRole('heading', { level: 3, name: 'Post media made elsewhere' });
    const card = heading.closest('article');
    expect(card).not.toBeNull();
    const words = card?.textContent ?? '';
    // What every client can do comes first: a link.
    expect(words).toContain('a picture or video from another tool by its link');
    expect(words).toContain('saying what made it');
    // A file on the computer is claimed only for the clients that have a shell there.
    expect(words).toMatch(/In Claude Code, Codex and Cursor, which can run commands on your computer, it can also send a file from there\./);
    expect(words).not.toMatch(/ChatGPT|Claude\.ai|Claude Desktop/);
    expect(screen.getByText(/publish the ones you choose and post media you made\s+elsewhere\./)).toBeInTheDocument();

    // Four capability cards sit two by two; the three account cards keep their row.
    const capabilities = heading.closest('article')?.parentElement;
    expect(capabilities?.querySelectorAll('article')).toHaveLength(4);
    expect(capabilities).toHaveClass('md:grid-cols-2');
    const controls = screen.getByRole('heading', { level: 3, name: 'You approve each app' }).closest('article')?.parentElement;
    expect(controls?.querySelectorAll('article')).toHaveLength(3);
    expect(controls).toHaveClass('md:grid-cols-3');

    // The plugin carries a skill for it.
    expect(within(block('Claude Code')).getByText(/adds the same server and three skills: .* and one that posts media made elsewhere\./)).toBeInTheDocument();
  });

  it('names a waiting app as coming in the header and the search snippet, never as connectable', () => {
    expect(connectSentence(MIXED_IDS)).toBe('Connect Claude today, and ChatGPT, Codex and Cursor soon.');
    expect(connectSentence(ALL_REGISTERED)).toBe('Connect Claude, ChatGPT, Codex or Cursor.');
    expect(connectSentence(ALL_PENDING)).toBe('Claude, ChatGPT, Codex and Cursor can connect soon.');

    const mixed = mcpPageMetadata({ ...ALL_REGISTERED, chatgpt: `${PENDING_CLIENT_ID_PREFIX}CHATGPT` });
    expect(mixed.description).toMatch(/^Connect Claude, Codex or Cursor \(ChatGPT soon\) to Magic Booklet’s MCP server: /);
    expect(mixed.keywords).not.toContain('ChatGPT MCP connector');
    expect(mixed.keywords).toEqual(expect.arrayContaining(['Claude custom connector', 'Claude Code MCP', 'Codex MCP', 'Cursor MCP']));

    // The live page says what the directory says.
    render(<McpDevelopersPage />);
    expect(screen.getByText(new RegExp(connectSentence(MCP_CLIENT_IDS).replace(/[.()]/g, '\\$&')))).toBeInTheDocument();
    expect(metadata.description).toBe(mcpPageMetadata(MCP_CLIENT_IDS).description);
  });

  it('gives a registered client its commands with its own id, and a waiting one no command at all', () => {
    render(<McpDeveloperGuide clientIds={MIXED_IDS} />);

    const claude = block('Claude.ai and Claude Desktop');
    expect(claude).toHaveAttribute('data-client-state', 'available');
    expect(within(claude).getByText('Available')).toBeInTheDocument();
    expect(within(claude).getByText(MCP_SERVER_URL)).toBeInTheDocument();
    expect(within(claude).getByText('claude-web-client-id')).toBeInTheDocument();
    expect(within(claude).getByRole('button', { name: 'Copy the Claude client ID' })).toBeInTheDocument();

    const claudeCode = block('Claude Code');
    expect(claudeCode).toHaveAttribute('data-client-state', 'available');
    // User scope: the server is there in every project, not only the folder the command ran in.
    expect(within(claudeCode).getByText(CLAUDE_CODE_COMMAND)).toBeInTheDocument();
    // The plugin carries the same client, so it is offered with it, as the other way in.
    expect(within(claudeCode).getByText(MCP_PLUGIN_MARKETPLACE_ADD_COMMAND)).toBeInTheDocument();
    expect(within(claudeCode).getByText(MCP_PLUGIN_INSTALL_COMMAND)).toBeInTheDocument();
    expect(within(claudeCode).getByText(/Use the command or the plugin, not both/)).toBeInTheDocument();

    for (const name of ['ChatGPT', 'Codex', 'Cursor']) {
      const waiting = block(name);
      expect(waiting, name).toHaveAttribute('data-client-state', 'pending');
      expect(within(waiting).getByText('Coming soon')).toBeInTheDocument();
      expect(within(waiting).queryAllByRole('button'), name).toEqual([]);
      expect(within(waiting).queryByText(/codex mcp|mcpServers|OAuth/)).toBeNull();
      // Another client can sign in already, so the waiting one points there.
      expect(within(waiting).getByText(/connect from one of the clients marked available/)).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toContain(PENDING_CLIENT_ID_PREFIX);
  });

  it('points a waiting client at no other while none can sign in', () => {
    render(<McpDeveloperGuide clientIds={ALL_PENDING} />);

    for (const { name } of SURFACES) {
      expect(block(name), name).toHaveAttribute('data-client-state', 'pending');
      expect(within(block(name)).getByText(/Its setup appears here as soon as it can sign in\.$/)).toBeInTheDocument();
    }
    expect(screen.queryByText(/marked available/)).toBeNull();
  });

  it('pins the Codex callback port and gives Cursor a static client id once those clients are registered', () => {
    render(<McpDeveloperGuide clientIds={ALL_REGISTERED} />);

    const codex = block('Codex');
    expect(within(codex).getByText(`codex mcp add magicbooklet --url ${MCP_SERVER_URL} --oauth-client-id codex-client-id`))
      .toBeInTheDocument();
    expect(within(codex).getByText(/callback_port = 8977/)).toBeInTheDocument();
    expect(within(codex).getByText('codex mcp login magicbooklet')).toBeInTheDocument();

    const cursor = block('Cursor');
    expect(within(cursor).getByText(/"CLIENT_ID": "cursor-client-id"/)).toBeInTheDocument();
  });

  it('names every copy button and code scroller apart, and lets the keyboard reach each scroller', () => {
    render(<McpDeveloperGuide clientIds={ALL_REGISTERED} />);

    const buttons = screen.getAllByRole('button', { name: /^Copy / }).map((button) => button.getAttribute('aria-label'));
    expect(buttons.length).toBeGreaterThan(8);
    expect(new Set(buttons).size, 'two copy buttons read the same').toBe(buttons.length);
    expect(buttons).toEqual(expect.arrayContaining(['Copy the server URL', 'Copy the Claude server URL', 'Copy the ChatGPT server URL']));

    const scrollers = screen.getAllByRole('region');
    expect(scrollers).toHaveLength(buttons.length);
    for (const scroller of scrollers) {
      expect(scroller.tagName).toBe('PRE');
      expect(scroller).toHaveAttribute('tabindex', '0');
      expect(scroller.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('copies a command, says so, and returns to Copy after two seconds', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<McpDeveloperGuide clientIds={MIXED_IDS} />);

    await act(async () => {
      fireEvent.click(within(block('Claude Code')).getByRole('button', { name: 'Copy the Claude Code command' }));
    });

    expect(writeText).toHaveBeenCalledWith(CLAUDE_CODE_COMMAND);
    expect(screen.getByRole('button', { name: 'Copied the Claude Code command' })).toBeInTheDocument();
    expect(screen.getByText('Copied the Claude Code command to your clipboard.')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: 'Copy the Claude Code command' })).toBeInTheDocument();
  });

  it('keeps the copy-by-hand message until the focus leaves the block or the next press', async () => {
    vi.useFakeTimers();
    stubClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    render(<McpDeveloperGuide clientIds={MIXED_IDS} />);
    const button = screen.getByRole('button', { name: 'Copy the server URL' });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByText(COPY_BLOCKED)).toBeInTheDocument();

    // It does not time out, and selecting the text in the scroller keeps it.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    fireEvent.blur(button, { relatedTarget: screen.getByRole('region', { name: 'the server URL' }) });
    expect(screen.getByText(COPY_BLOCKED)).toBeInTheDocument();

    // Moving on to anything outside the block clears it.
    fireEvent.blur(button, { relatedTarget: document.body });
    expect(screen.queryByText(COPY_BLOCKED)).toBeNull();
  });

  it('describes the FAQ it shows in its structured data', () => {
    const { container } = render(<McpDeveloperGuide clientIds={MIXED_IDS} />);

    const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent ?? 'null') as unknown);
    const faq = scripts.flat().find((entry) => (entry as { '@type'?: string })['@type'] === 'FAQPage') as
      | { mainEntity: Array<{ name: string }> }
      | undefined;
    expect(faq?.mainEntity.map((question) => question.name)).toEqual(
      screen.getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent)
        .filter((text) => text?.endsWith('?')),
    );
  });
});
