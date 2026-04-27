import { Collection, SlashCommandBuilder, AutocompleteInteraction } from 'discord.js';
import { setpath } from './setpath.js';
import { projects } from './projects.js';
import { use } from './use.js';
import { opencode } from './opencode.js';
import { work } from './work.js';
import { code } from './code.js';
import { autowork } from './autowork.js';
import { autocode } from './autocode.js';
import { model } from './model.js';
import { setports } from './setports.js';
import { queue } from './queue.js';
import { allow } from './allow.js';
import { diff } from './diff.js';
import { voice } from './voice.js';
import { session } from './session.js';

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: any) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export const commands = new Collection<string, Command>();
commands.set(setpath.data.name, setpath as Command);
commands.set(projects.data.name, projects as Command);
commands.set(use.data.name, use as Command);
commands.set(opencode.data.name, opencode);
commands.set(work.data.name, work);
commands.set(code.data.name, code);
commands.set(autowork.data.name, autowork);
commands.set(autocode.data.name, autocode);
commands.set(model.data.name, model);
commands.set(setports.data.name, setports as Command);
commands.set(queue.data.name, queue);
commands.set(allow.data.name, allow);
commands.set(diff.data.name, diff);
commands.set(voice.data.name, voice);
commands.set(session.data.name, session);
