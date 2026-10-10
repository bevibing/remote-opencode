import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Guild,
  TextChannel,
} from 'discord.js';
import * as dataStore from './dataStore.js';
import * as serveManager from './serveManager.js';
import * as sessionManager from './sessionManager.js';
import * as sessionSync from './sessionSync.js';
import type { AgentMode } from '../types/index.js';

export const SESSION_PREFIX = '🤖';
export const ARCHIVE_PREFIX = '🔒';

export function sanitizeChannelName(name: string): string {
  let clean = name.replace(/["#:~@%*]/g, '').replace(/\s+/g, ' ').trim();
  clean = clean.slice(0, 100);
  return clean || 'sesion';
}

export function sessionButtonRows(
  channelId: string,
  agent: AgentMode,
): Array<ActionRowBuilder<ButtonBuilder>> {
  const mode = new ButtonBuilder()
    .setCustomId(`mode_${channelId}`)
    .setLabel(agent === 'plan' ? '🎯 Plan' : '🔨 Build')
    .setStyle(agent === 'plan' ? ButtonStyle.Primary : ButtonStyle.Success);

  const interrupt = new ButtonBuilder()
    .setCustomId(`interrupt_${channelId}`)
    .setLabel('⏹️ Interrupt')
    .setStyle(ButtonStyle.Secondary);

  const diff = new ButtonBuilder()
    .setCustomId(`diff_${channelId}`)
    .setLabel('📊 Diff')
    .setStyle(ButtonStyle.Secondary);

  const model = new ButtonBuilder()
    .setCustomId(`modelbtn_${channelId}`)
    .setLabel('🧠 Modelo')
    .setStyle(ButtonStyle.Secondary);

  const archive = new ButtonBuilder()
    .setCustomId(`archive_${channelId}`)
    .setLabel('🗑 Archivar')
    .setStyle(ButtonStyle.Danger);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    mode,
    interrupt,
    diff,
    model,
    archive,
  );

  const undo = new ButtonBuilder()
    .setCustomId(`undo_${channelId}`)
    .setLabel('↩️ Undo')
    .setStyle(ButtonStyle.Secondary);

  const status = new ButtonBuilder()
    .setCustomId(`status_${channelId}`)
    .setLabel('ℹ️ Status')
    .setStyle(ButtonStyle.Secondary);

  const compact = new ButtonBuilder()
    .setCustomId(`compact_${channelId}`)
    .setLabel('🧹 Compactar')
    .setStyle(ButtonStyle.Secondary);

  const init = new ButtonBuilder()
    .setCustomId(`init_${channelId}`)
    .setLabel('⚡ Init')
    .setStyle(ButtonStyle.Secondary);

  const sync = new ButtonBuilder()
    .setCustomId(`sync_${channelId}`)
    .setLabel('🔄 Sincronizar')
    .setStyle(ButtonStyle.Secondary);

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    undo,
    status,
    compact,
    init,
    sync,
  );

  return [row1, row2];
}

export async function postSticky(
  channel: TextChannel,
  channelId: string,
  agent: AgentMode,
): Promise<void> {
  const rows = sessionButtonRows(channelId, agent);
  const message = await channel.send({
    content:
      '**Sesión de OpenCode**\nEscribí tu prompt acá abajo — va directo al agente. Usá los botones para controlar.',
    components: rows,
  });
  await message.pin().catch(() => {});
}

export async function refreshSticky(
  channel: TextChannel,
  channelId: string,
  agent: AgentMode,
): Promise<void> {
  try {
    const pinned = await channel.messages.fetchPinned();
    const sticky = pinned.find((m) => m.author.id === channel.client.user.id);
    if (sticky) {
      await sticky.edit({
        components: sessionButtonRows(channelId, agent),
      });
    }
  } catch {
    // ignore
  }
}

async function getOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  const hub = dataStore.getHubConfig();
  if (hub?.categoryId) {
    try {
      const existing = await guild.channels.fetch(hub.categoryId);
      if (existing?.type === ChannelType.GuildCategory) {
        return existing as CategoryChannel;
      }
    } catch {
      // fall through and create
    }
  }
  const category = await guild.channels.create({
    name: 'Sesiones',
    type: ChannelType.GuildCategory,
  });
  if (hub) {
    dataStore.setHubConfig({ ...hub, categoryId: category.id });
  }
  return category;
}

export async function createSessionChannel(
  guild: Guild,
  name: string,
  projectAlias: string,
  model: string | undefined,
  agent: AgentMode,
  userId: string,
): Promise<TextChannel> {
  const category = await getOrCreateCategory(guild);
  const channel = await guild.channels.create({
    name: `${SESSION_PREFIX} ${sanitizeChannelName(name)}`,
    type: ChannelType.GuildText,
    parent: category.id,
  });

  dataStore.setChannelBinding(channel.id, projectAlias, model);
  dataStore.setPassthroughMode(channel.id, true, userId);
  dataStore.setChannelAgent(channel.id, agent);

  try {
    const projectPath = dataStore.getChannelProjectPath(channel.id);
    if (projectPath) {
      const port = await serveManager.spawnServe(projectPath, model);
      await serveManager.waitForReady(port, 30000, projectPath, model);
      await sessionManager.ensureSessionForThread(channel.id, projectPath, port, name);
    }
  } catch (error) {
    console.error('[sessionFlow] Failed to create session eagerly:', error);
  }

  await postSticky(channel, channel.id, agent);
  return channel;
}

export async function createChannelForSession(
  guild: Guild,
  sessionId: string,
  title: string,
  projectPath: string,
  port: number,
  projectAlias: string,
  model: string | undefined,
  agent: AgentMode,
  userId: string,
): Promise<TextChannel> {
  const category = await getOrCreateCategory(guild);
  const channel = await guild.channels.create({
    name: `${SESSION_PREFIX} ${sanitizeChannelName(title || 'sesion')}`,
    type: ChannelType.GuildText,
    parent: category.id,
  });

  dataStore.setChannelBinding(channel.id, projectAlias, model);
  dataStore.setPassthroughMode(channel.id, true, userId);
  dataStore.setChannelAgent(channel.id, agent);
  sessionManager.setSessionForThread(channel.id, sessionId, projectPath, port);

  await postSticky(channel, channel.id, agent);
  try {
    await sessionSync.syncSessionToChannel(channel, channel.id, { history: true });
  } catch (error) {
    console.error('[sessionFlow] Failed to backfill session history:', error);
  }
  return channel;
}

export async function archiveSessionChannel(
  channel: TextChannel,
  channelId: string,
): Promise<void> {
  const session = sessionManager.getSessionForThread(channelId);
  const model = dataStore.getChannelModel(channelId);
  const currentName = channel.name.replace(/^(🤖|🔒)\s*/, '');

  await channel.setName(`${ARCHIVE_PREFIX} ${sanitizeChannelName(currentName)}`);
  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      ViewChannel: false,
    });
  } catch {
    // ignore permission errors
  }

  dataStore.removePassthroughMode(channelId);
  dataStore.setArchivedSession({
    channelId,
    sessionId: session?.sessionId,
    projectPath: session?.projectPath,
    port: session?.port,
    model,
    title: currentName,
    archivedAt: Date.now(),
  });
}

export async function reopenSessionChannel(
  guild: Guild,
  archived: {
    channelId: string;
    sessionId?: string;
    projectPath?: string;
    port?: number;
    model?: string;
    title?: string;
  },
  userId: string,
): Promise<TextChannel | null> {
  try {
    const fetched = await guild.channels.fetch(archived.channelId);
    if (!fetched?.isTextBased() || fetched.isDMBased()) return null;
    const channel = fetched as TextChannel;

    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      ViewChannel: true,
    });
    await channel.setName(
      `${SESSION_PREFIX} ${sanitizeChannelName(archived.title || 'sesion')}`,
    );

    dataStore.removeArchivedSession(archived.channelId);
    dataStore.setPassthroughMode(channel.id, true, userId);
    dataStore.setChannelAgent(channel.id, 'build');

    try {
      const projectPath =
        archived.projectPath || dataStore.getChannelProjectPath(channel.id);
      if (projectPath) {
        const port =
          archived.port ||
          (await serveManager.spawnServe(projectPath, archived.model));
        await serveManager.waitForReady(port, 30000, projectPath, archived.model);
        const sid =
          sessionManager.getSessionForThread(channel.id)?.sessionId ??
          archived.sessionId;
        if (sid) {
          sessionManager.setSessionForThread(channel.id, sid, projectPath, port);
        }
        await sessionManager.ensureSessionForThread(
          channel.id,
          projectPath,
          port,
          archived.title,
        );
      }
    } catch (error) {
      console.error('[sessionFlow] Failed to resume session on reopen:', error);
    }

    await postSticky(channel, channel.id, 'build');
    return channel;
  } catch (error) {
    console.error('[sessionFlow] Failed to reopen channel:', error);
    return null;
  }
}
