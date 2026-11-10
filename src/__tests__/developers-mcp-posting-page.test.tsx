import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import PostingConnectorGuide from '@/app/developers/mcp/posting/PostingConnectorGuide';
import PostingConnectorPage, { metadata } from '@/app/developers/mcp/posting/page';
import { MCP_CLIENT_IDS, MCP_POSTING_ONLY_CLIENT_IDS, MCP_POSTS_SERVER_URL } from '@/lib/mcp-client-directory';
import { MCP_POSTS_TOOL_SUMMARIES } from '@/lib/mcp-posts-tool-summaries';

afterEach(cleanup);

/**
 * `/developers/mcp/posting` is the documentation the posting-only server's directory listing
 * links to, so it describes that server alone: its URL, its six tools, and no tool or flow that
 * creates media or spends credits.
 */
describe('the posting connector page', () => {
  it('names the posting server, how to connect it and its six tools', () => {
    render(<PostingConnectorGuide claudeClientId="claude-web-client-id" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Post to Magic Booklet from Claude' })).toBeTruthy();
    // The URL a person connects, in the header and in the by-URL steps.
    expect(screen.getAllByText(MCP_POSTS_SERVER_URL).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('claude-web-client-id')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'From Claude’s connectors' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'By URL' })).toBeTruthy();

    const tools = [...document.querySelectorAll<HTMLElement>('[data-tool]')].map((card) => card.dataset.tool);
    expect(tools).toEqual(MCP_POSTS_TOOL_SUMMARIES.map((tool) => tool.name));
    expect(tools).toHaveLength(6);
    // Two copy buttons for the same URL are told apart by their labels.
    const copyLabels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '');
    expect(new Set(copyLabels).size).toBe(copyLabels.length);
    // Each card says whether the tool reads or writes, as the server's annotations do.
    expect(screen.getAllByText('Reads')).toHaveLength(2);
    expect(screen.getAllByText('Writes')).toHaveLength(4);
  });

  it('describes posting only: no tool, flow or link that creates media or spends credits', () => {
    const { container } = render(<PostingConnectorGuide claudeClientId="claude-web-client-id" />);
    const words = container.textContent ?? '';
    expect(words).toContain('It creates no media and spends no credits.');
    expect(words).not.toMatch(/create_media|quote_generation|enhance_prompt|list_models|get_model|get_generation/u);
    // The full server's path is the posting server's without its last segment: it appears only inside it.
    expect(words.replaceAll('/api/mcp/posts', '')).not.toContain('/api/mcp');
    const links = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining(['/privacy', '/terms', '/contact', '/profile/edit']));
    expect(links).not.toContain('/developers/mcp');
    // What a person decides is said in words: a public post, a price, the daily limit.
    expect(words).toContain('unless you ask for a private one');
    expect(words).toContain('Claude never chooses one');
    expect(words).toContain('10 public posts a day');
    expect(words).toContain('Up to 5 files in one post.');
    // It does not send a person to search a directory it may not be in yet.
    expect(words).toContain('Once Magic Booklet is listed in Claude’s connectors directory');
    // What it can change is said beside what it can publish.
    expect(words).toContain('make one of your posts public or private, or delete it');
  });

  it('is served with the posting-only public client, never the full server\'s, and metadata of its own', () => {
    const { container } = render(<PostingConnectorPage />);
    // The full server's client would show the full access list on the consent page and reach every tool.
    expect(container.textContent).toContain(MCP_POSTING_ONLY_CLIENT_IDS.claudeByUrl);
    for (const id of Object.values(MCP_CLIENT_IDS)) expect(container.textContent, id).not.toContain(id);
    expect(metadata.title).toBe('Post to Magic Booklet from Claude');
    expect(String(metadata.description)).toContain('It creates no media and spends no credits.');
    expect(metadata.alternates?.canonical).toContain('/developers/mcp/posting');
  });
});
