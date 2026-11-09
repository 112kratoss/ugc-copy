import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_CALLBACK_PORT,
  MCP_CLIENT_IDS,
  MCP_DEVELOPERS_PAGE_URL,
  MCP_PLUGIN_INSTALL_COMMAND,
  MCP_PLUGIN_MARKETPLACE_ADD_COMMAND,
  MCP_PLUGIN_MARKETPLACE_NAME,
  MCP_PLUGIN_NAME,
  MCP_PLUGIN_REPOSITORY,
  MCP_SERVER_KEY,
  MCP_SERVER_URL,
  claudeCodeServerEntry,
  isPendingClientId,
} from '@/lib/mcp-client-directory';
import { MCP_TOOLS } from '@/lib/mcp-server-service';

/**
 * The Claude Code plugin marketplace this repository serves: `.claude-plugin/marketplace.json`
 * and its one plugin, `plugins/magicbooklet/`. JSON and Markdown cannot import the client
 * directory, so this holds them to it; `claude plugin validate --strict` checks their shape.
 */

const ROOT = process.cwd();
const PLUGIN_ROOT = path.join(ROOT, 'plugins', MCP_PLUGIN_NAME);

type Marketplace = {
  name: string;
  description?: string;
  owner: { name: string; email?: string; url?: string };
  plugins: Array<{ name: string; source: string; description?: string; version?: string }>;
};

type PluginManifest = {
  name: string;
  version: string;
  description: string;
  author: { name: string };
  homepage: string;
  repository: string;
  mcpServers: Record<string, unknown>;
};

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(...segments), 'utf8')) as T;
}

/** The frontmatter these skills use (one-line `key: value` fields and an `allowed-tools` list), and the body. */
function readSkill(file: string): { fields: Record<string, string>; allowedTools: string[]; body: string } {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file} has no frontmatter on its first line`);
  const body = text.slice(match[0].length);
  const fields: Record<string, string> = {};
  const allowedTools: string[] = [];
  let inToolList = false;
  for (const line of match[1].split('\n')) {
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (inToolList && item) {
      allowedTools.push(item[1]);
      continue;
    }
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!field) throw new Error(`${file}: unexpected frontmatter line ${JSON.stringify(line)}`);
    inToolList = field[1] === 'allowed-tools' && field[2] === '';
    if (!inToolList) fields[field[1]] = field[2];
  }
  return { fields, allowedTools, body };
}

/**
 * Tools that spend credits, act in public, or send a file of the person's off their machine: a
 * skill never runs one without the permission prompt.
 */
const NEVER_PRE_APPROVED = ['create_media', 'enhance_prompt', 'publish_post', 'delete_post', 'upload_input', 'request_upload'];
const PLUGIN_TOOL_PREFIX = `mcp__plugin_${MCP_PLUGIN_NAME}_${MCP_SERVER_KEY}__`;

/**
 * Tools a skill may name before the server offers them, while the release that adds them is on its
 * way. Empty since phase 2 (#749) shipped `publish_post`, `get_post`, `delete_post` and
 * `upload_input`, so every name a skill uses is held to `MCP_TOOLS`. A name goes in only for the
 * time between a skill and its tool landing, and the test asks for it to leave once it is offered.
 */
const COMING_TOOLS: readonly string[] = [];

/**
 * A backticked name in a skill's body that reads as a tool: a verb, then what it acts on
 * (`create_media`, `get_generation`). Parameter and field names (`wait_seconds`, `cost_credits`)
 * start with no such verb and are left alone.
 */
const TOOL_LIKE_NAME = /^(?:list|get|quote|create|enhance|publish|delete|upload|request|update|run|search|remove|set)_[a-z]+(?:_[a-z]+)*$/;

describe('the Claude Code plugin marketplace', () => {
  const marketplace = readJson<Marketplace>(ROOT, '.claude-plugin', 'marketplace.json');
  const plugin = readJson<PluginManifest>(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');

  it('lists the one plugin under the marketplace name the install command uses', () => {
    expect(marketplace.name).toBe(MCP_PLUGIN_MARKETPLACE_NAME);
    expect(marketplace.owner.name).toBe('Magic Booklet');
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(MCP_PLUGIN_NAME);
    // The install id is the entry's name; the skills' prefix is the manifest's. They must agree.
    expect(plugin.name).toBe(entry.name);
    expect(path.resolve(ROOT, entry.source)).toBe(PLUGIN_ROOT);
    // The version lives in plugin.json alone (validate warns when both set one).
    expect(entry.version).toBeUndefined();
    expect(MCP_PLUGIN_INSTALL_COMMAND).toBe(`claude plugin install ${entry.name}@${marketplace.name}`);
    expect(MCP_PLUGIN_MARKETPLACE_ADD_COMMAND).toBe(`claude plugin marketplace add ${MCP_PLUGIN_REPOSITORY}`);
  });

  it('declares the production server with the Claude Code client and its fixed callback port', () => {
    expect(plugin.mcpServers).toEqual({ [MCP_SERVER_KEY]: claudeCodeServerEntry(MCP_CLIENT_IDS.claudeCode) });
    expect(plugin.mcpServers[MCP_SERVER_KEY]).toMatchObject({
      url: MCP_SERVER_URL,
      oauth: { callbackPort: CLAUDE_CODE_CALLBACK_PORT },
    });
    expect(plugin.homepage).toBe(MCP_DEVELOPERS_PAGE_URL);
    expect(plugin.repository).toBe(`https://github.com/${MCP_PLUGIN_REPOSITORY}`);
    // One place for the server: a .mcp.json beside it would load as well, and this repository's
    // agent guard refuses every .mcp.json to the agents that review it.
    expect(existsSync(path.join(PLUGIN_ROOT, '.mcp.json'))).toBe(false);
  });

  it('ships a new version when the real Claude Code client id replaces the placeholder', () => {
    // Installed copies update only when the version changes. A copy installed while the id was the
    // placeholder cannot sign in, so the release that brings the id must be a new major.
    const major = Number(plugin.version.split('.')[0]);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (isPendingClientId(MCP_CLIENT_IDS.claudeCode)) {
      expect(major, 'a plugin whose client id is a placeholder stays 0.x').toBe(0);
    } else {
      expect(major, 'the plugin with the real client id is 1.0.0 or later').toBeGreaterThanOrEqual(1);
    }
  });

  it('carries the three skills, each pre-approving only the server’s free reads', () => {
    const skillsDir = path.join(PLUGIN_ROOT, 'skills');
    const skills = readdirSync(skillsDir).sort();
    expect(skills).toEqual(['create-ugc-ad', 'post-outside-media', 'publish-creation']);
    // Each is offered by its command in the README, and counted in the marketplace's line.
    const readme = readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
    for (const skill of skills) {
      expect(readme, skill).toContain(`/${MCP_PLUGIN_NAME}:${skill}`);
    }
    expect(marketplace.plugins[0].description).toContain('three skills');

    const readOnlyTools = new Set<string>(MCP_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name));
    const offeredTools = new Set<string>(MCP_TOOLS.map((tool) => tool.name));
    for (const skill of skills) {
      const { fields, allowedTools } = readSkill(path.join(skillsDir, skill, 'SKILL.md'));
      expect(fields.name, skill).toBe(skill);
      expect(fields.description?.length, `${skill} needs a description`).toBeGreaterThan(40);
      // The Agent Skills fields alone, so the skill uploads to claude.ai as it is.
      expect(Object.keys(fields).every((key) => ['name', 'description', 'license', 'compatibility'].includes(key)), skill)
        .toBe(true);
      expect(allowedTools.length, skill).toBeGreaterThan(0);
      for (const tool of allowedTools) {
        expect(tool.startsWith(PLUGIN_TOOL_PREFIX), `${skill}: ${tool}`).toBe(true);
        const name = tool.slice(PLUGIN_TOOL_PREFIX.length);
        expect(NEVER_PRE_APPROVED, `${skill} must not pre-approve ${name}`).not.toContain(name);
        // A name the server does not offer is checked against the coming list, never skipped.
        expect(offeredTools.has(name) || COMING_TOOLS.includes(name), `${skill} pre-approves ${name}, which no tool is called`)
          .toBe(true);
        if (offeredTools.has(name)) expect(readOnlyTools.has(name), `${skill}: ${name} is not read-only`).toBe(true);
      }
    }
    // The registry's charging tools exist under the names the list keeps out.
    expect(offeredTools.has('create_media')).toBe(true);
    expect(offeredTools.has('enhance_prompt')).toBe(true);
    // Every tool the list keeps out is one the server offers: a name that left the registry leaves here too.
    for (const name of NEVER_PRE_APPROVED) {
      expect(offeredTools.has(name), `${name} is kept from pre-approval but is no tool`).toBe(true);
    }
  });

  it('posts outside media in the order the server needs: stage, send a local file with the printed command, then publish with what made it', () => {
    const { body } = readSkill(path.join(PLUGIN_ROOT, 'skills', 'post-outside-media', 'SKILL.md'));
    const order = ['`request_upload`', 'curl command', '`publish_post`', '`made_with`'].map((words) => body.indexOf(words));
    expect(order.every((index) => index >= 0), 'the skill names each step').toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // A link is staged with upload_input alone; a local file goes through request_upload first.
    expect(body).toMatch(/call `upload_input` with `url`/);
    expect(body).toMatch(/then call `upload_input` with the upload id that answer gave/);
    // A post goes out under the person's name: the skill asks, and never names Magic Booklet as the maker.
    expect(body).toMatch(/Ask; do not assume public/);
    expect(body).toMatch(/never name Magic Booklet/);
    expect(body).toMatch(/Keep the post id/);
  });

  it('names only tools the server offers, or phase 2’s coming ones, which leave the list once live', () => {
    const offeredTools = new Set<string>(MCP_TOOLS.map((tool) => tool.name));
    for (const coming of COMING_TOOLS) {
      expect(offeredTools.has(coming), `${coming} is offered now: remove it from COMING_TOOLS`).toBe(false);
    }
    const knownTools = new Set<string>([...offeredTools, ...COMING_TOOLS]);
    const skillsDir = path.join(PLUGIN_ROOT, 'skills');
    for (const skill of readdirSync(skillsDir)) {
      const { body } = readSkill(path.join(skillsDir, skill, 'SKILL.md'));
      const toolNames = [...body.matchAll(/`([a-z][a-z_]*)`/g)]
        .map((match) => match[1])
        .filter((name) => knownTools.has(name) || TOOL_LIKE_NAME.test(name));
      // Each skill drives the server by name, so a body that names no tool is a broken reader.
      expect(toolNames.length, `${skill} names no tool`).toBeGreaterThan(0);
      for (const name of toolNames) {
        expect(knownTools.has(name), `${skill} names ${name}, which the server does not offer and is not coming`).toBe(true);
      }
    }
  });

  it('gives the README the setup page’s install commands', () => {
    const readme = readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(MCP_PLUGIN_MARKETPLACE_ADD_COMMAND);
    expect(readme).toContain(MCP_PLUGIN_INSTALL_COMMAND);
    expect(readme).toContain(MCP_SERVER_URL);
    expect(readme).toContain(`port ${CLAUDE_CODE_CALLBACK_PORT}`);
    expect(readme).toContain(MCP_DEVELOPERS_PAGE_URL.replace('https://', ''));
  });
});
