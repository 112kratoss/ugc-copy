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

/** The frontmatter these skills use: one-line `key: value` fields and an `allowed-tools` list. */
function readSkillFrontmatter(file: string): { fields: Record<string, string>; allowedTools: string[] } {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file} has no frontmatter on its first line`);
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
  return { fields, allowedTools };
}

/** Tools that spend credits or act in public: a skill never runs one without the permission prompt. */
const NEVER_PRE_APPROVED = ['create_media', 'enhance_prompt', 'publish_post', 'delete_post', 'upload_input'];
const PLUGIN_TOOL_PREFIX = `mcp__plugin_${MCP_PLUGIN_NAME}_${MCP_SERVER_KEY}__`;

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

  it('carries the two skills, each pre-approving only the server’s free reads', () => {
    const skillsDir = path.join(PLUGIN_ROOT, 'skills');
    const skills = readdirSync(skillsDir).sort();
    expect(skills).toEqual(['create-ugc-ad', 'publish-creation']);

    const readOnlyTools = new Set<string>(MCP_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name));
    const knownTools = new Set<string>(MCP_TOOLS.map((tool) => tool.name));
    for (const skill of skills) {
      const { fields, allowedTools } = readSkillFrontmatter(path.join(skillsDir, skill, 'SKILL.md'));
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
        if (knownTools.has(name)) expect(readOnlyTools.has(name), `${skill}: ${name} is not read-only`).toBe(true);
      }
    }
    // The registry's charging tools exist under the names the list keeps out.
    expect(knownTools.has('create_media')).toBe(true);
    expect(knownTools.has('enhance_prompt')).toBe(true);
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
