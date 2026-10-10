import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import type { Command } from './index.js';

const DEFAULT_MODEL = 'deepseek/deepseek-flash';

export function hubButtonRows(
  projectAlias: string,
  model: string,
): Array<ActionRowBuilder<ButtonBuilder>> {
  const newsession = new ButtonBuilder()
    .setCustomId('new-session')
    .setLabel('🆕 Nueva sesión')
    .setStyle(ButtonStyle.Primary);

  const sessions = new ButtonBuilder()
    .setCustomId('sessions-list')
    .setLabel('📋 Sesiones')
    .setStyle(ButtonStyle.Secondary);

  const modelbtn = new ButtonBuilder()
    .setCustomId('model-hub')
    .setLabel('🧠 Modelo')
    .setStyle(ButtonStyle.Secondary);

  const projectbtn = new ButtonBuilder()
    .setCustomId('project-hub')
    .setLabel('📂 Proyecto')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    newsession,
    sessions,
    modelbtn,
    projectbtn,
  );

  return [row];
}

export async function postHubMessage(
  channel: TextChannel,
  projectAlias: string,
  model: string,
): Promise<void> {
  try {
    const pinned = await channel.messages.fetchPinned();
    for (const msg of pinned.values()) {
      if (msg.author.id === channel.client.user.id) {
        await msg.unpin().catch(() => {});
      }
    }
  } catch {
    // ignore
  }

  const message = await channel.send({
    content:
      `**Hub de OpenCode**\n` +
      `📂 Proyecto: \`${projectAlias}\`\n` +
      `🧠 Modelo: \`${model}\`\n\n` +
      `🆕 **Nueva sesión** — crea un canal de sesión (nombre, passthrough activo).\n` +
      `📋 **Sesiones** — lista activas y archivadas, reabrir sesión.\n` +
      `🧠 **Modelo** — cambia el modelo por defecto.\n` +
      `📂 **Proyecto** — cambia el proyecto por defecto.`,
    components: hubButtonRows(projectAlias, model),
  });
  await message.pin().catch(() => {});
}

export const hub: Command = {
  data: new SlashCommandBuilder()
    .setName('hub')
    .setDescription('Configurar el hub: botones para lanzar y gestionar sesiones'),

  async execute(interaction: ChatInputCommandInteraction) {
    const current = dataStore.getHubConfig();
    let projectAlias = current?.projectAlias;
    if (!projectAlias) {
      const projects = dataStore.getProjects();
      if (projects.length === 0) {
        await interaction.reply({
          content:
            '❌ No hay proyectos registrados. Usá `/setpath alias:<nombre> path:<ruta>` primero.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      projectAlias = projects[0].alias;
    }

    const model = current?.model ?? DEFAULT_MODEL;
    const agent = current?.agent ?? 'build';

    dataStore.setHubConfig({
      hubChannelId: interaction.channelId,
      categoryId: current?.categoryId ?? '',
      projectAlias,
      model,
      agent,
    });
    dataStore.setChannelBinding(interaction.channelId, projectAlias, model);

    const channel = interaction.channel;
    if (!channel?.isTextBased() || channel.isDMBased()) {
      await interaction.reply({
        content: '❌ Este comando solo funciona en canales de texto del servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: '✅ Hub configurado en este canal.',
      flags: MessageFlags.Ephemeral,
    });

    await postHubMessage(channel as TextChannel, projectAlias, model);
  },
};
