import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import McpDeveloperGuide from '@/app/developers/mcp/McpDeveloperGuide';
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
    expect(within(claudeCode).getByText(
      `claude mcp add --transport http --client-id claude-code-client-id --callback-port 8976 magicbooklet ${MCP_SERVER_URL}`,
    )).toBeInTheDocument();
    // The plugin carries the same client, so it is offered with it.
    expect(within(claudeCode).getByText(MCP_PLUGIN_MARKETPLACE_ADD_COMMAND)).toBeInTheDocument();
    expect(within(claudeCode).getByText(MCP_PLUGIN_INSTALL_COMMAND)).toBeInTheDocument();

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
    const allPending = Object.fromEntries(
      SURFACES.map(({ surface }) => [surface, `${PENDING_CLIENT_ID_PREFIX}${surface.toUpperCase()}`]),
    ) as unknown as McpClientIds;
    render(<McpDeveloperGuide clientIds={allPending} />);

    for (const { name } of SURFACES) {
      expect(block(name), name).toHaveAttribute('data-client-state', 'pending');
      expect(within(block(name)).getByText(/Its setup appears here as soon as it can sign in\.$/)).toBeInTheDocument();
    }
    expect(screen.queryByText(/marked available/)).toBeNull();
  });

  it('pins the Codex callback port and gives Cursor a static client id once those clients are registered', () => {
    render(<McpDeveloperGuide clientIds={{ ...MIXED_IDS, codex: 'codex-client-id', cursor: 'cursor-client-id' }} />);

    const codex = block('Codex');
    expect(within(codex).getByText(`codex mcp add magicbooklet --url ${MCP_SERVER_URL} --oauth-client-id codex-client-id`))
      .toBeInTheDocument();
    expect(within(codex).getByText(/callback_port = 8977/)).toBeInTheDocument();
    expect(within(codex).getByText('codex mcp login magicbooklet')).toBeInTheDocument();

    const cursor = block('Cursor');
    expect(within(cursor).getByText(/"CLIENT_ID": "cursor-client-id"/)).toBeInTheDocument();
  });

  it('copies a command and says so', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<McpDeveloperGuide clientIds={MIXED_IDS} />);

    fireEvent.click(within(block('Claude Code')).getByRole('button', { name: 'Copy the Claude Code command' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `claude mcp add --transport http --client-id claude-code-client-id --callback-port 8976 magicbooklet ${MCP_SERVER_URL}`,
    ));
    expect(await screen.findByRole('button', { name: 'Copied the Claude Code command' })).toBeInTheDocument();
    expect(screen.getByText('Copied the Claude Code command to your clipboard.')).toBeInTheDocument();
  });

  it('tells the person to copy by hand when the clipboard refuses', async () => {
    stubClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    render(<McpDeveloperGuide clientIds={MIXED_IDS} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy the server URL' })[0]);

    expect(await screen.findByText('Copying is blocked here. Select the text and copy it yourself.')).toBeInTheDocument();
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
