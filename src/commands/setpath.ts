import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import * as dataStore from '../services/dataStore.js';

// Scan ~/Projects (one level deep) for git repositories.
// Returns a list of absolute paths, or [] if the dir is missing/unreadable.
function scanGitRepos(): string[] {
  const base = join(homedir(), 'Projects');
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(base, e.name))
      .filter(p => existsSync(join(p, '.git')));
  } catch {
    return [];
  }
}

// Expand a leading ~ to the user's home directory.
// Discord passes paths as raw strings (no shell), so the bot must do this itself.
function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export const setpath = {
  data: new SlashCommandBuilder()
    .setName('setpath')
    .setDescription('Register a project path')
    .addStringOption(option =>
      option.setName('alias')
        .setDescription('Project alias')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Project path (autocomplete from ~/Projects)')
        .setRequired(true)
        .setAutocomplete(true)),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    const query = (focused.value || '').toLowerCase();
    const home = homedir();

    if (focused.name === 'path') {
      const repos = scanGitRepos();
      const matches = repos
        .filter(p => p.toLowerCase().includes(query))
        .slice(0, 25)
        .map(p => ({
          name: p.replace(home, '~').slice(0, 100),
          value: p
        }));
      await interaction.respond(matches);
      return;
    }

    if (focused.name === 'alias') {
      // Suggest existing aliases (in case the user is overwriting)
      // and aliases derived from repo dir basenames (with `client-` stripped).
      const suggestions = new Set<string>();
      dataStore.getProjects().forEach(p => suggestions.add(p.alias));
      scanGitRepos().forEach(p => {
        const a = basename(p).toLowerCase().replace(/^client-/, '');
        suggestions.add(a);
      });
      const matches = [...suggestions]
        .filter(a => a.toLowerCase().includes(query))
        .slice(0, 25)
        .map(a => ({ name: a.slice(0, 100), value: a }));
      await interaction.respond(matches);
      return;
    }

    await interaction.respond([]);
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const alias = interaction.options.getString('alias', true);
    const rawPath = interaction.options.getString('path', true);
    const path = expandTilde(rawPath);

    dataStore.addProject(alias, path);
    await interaction.reply(`✅ Project '${alias}' registered: ${path}`);
  }
};
