import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ThreadChannel,
} from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import * as serveManager from '../services/serveManager.js';
import * as sessionManager from '../services/sessionManager.js';
import * as sessionSync from '../services/sessionSync.js';
import type { Command } from './index.js';

function getParentChannelId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  if (channel?.isThread()) {
    return (channel as ThreadChannel).parentId ?? interaction.channelId;
  }
  return interaction.channelId;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const session: Command = {
  data: new SlashCommandBuilder()
    .setName('session')
    .setDescription('Browse and manage OpenCode sessions')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('List available sessions for the bound project')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('attach')
        .setDescription('Attach this thread to an existing session')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('detach')
        .setDescription('Detach the current session from this thread')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('info')
        .setDescription('Show info for the session attached to this thread')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('sync')
        .setDescription('Traer los mensajes nuevos de la sesión a este canal')
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const parentChannelId = getParentChannelId(interaction);
      const projectPath = dataStore.getChannelProjectPath(parentChannelId);
      if (!projectPath) {
        await interaction.reply({
          content: '❌ No project set for this channel. Use `/use <alias>` to set a project.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const port = await serveManager.spawnServe(projectPath);
        await serveManager.waitForReady(port, 30000, projectPath);

        const activeSessions = await sessionManager.listSessions(port);
        const persistedSessions = dataStore
          .getAllThreadSessions()
          .filter((s) => s.projectPath === projectPath || s.projectPath.startsWith(projectPath));

        const persistedById = new Map(persistedSessions.map((s) => [s.sessionId, s]));
        const activeById = new Map(activeSessions.map((s) => [s.id, s]));
        const allSessionIds = Array.from(
          new Set([...activeSessions.map((s) => s.id), ...persistedSessions.map((s) => s.sessionId)])
        );

        if (allSessionIds.length === 0) {
          await interaction.editReply({
            content: 'No sessions found for this project.',
          });
          return;
        }

        const lines = allSessionIds.slice(0, 20).map((sessionId, index) => {
          const mapped = persistedById.get(sessionId);
          const active = activeById.get(sessionId);
          const title = active?.title || 'untitled';
          const mappedState = mapped ? `mapped to <#${mapped.threadId}>` : 'not mapped';
          const lastUsed = mapped ? formatRelativeTime(mapped.lastUsedAt) : 'unknown';
          return `${index + 1}. **${title}** (\`${sessionId.slice(0, 8)}\`) - ${mappedState} - ${lastUsed}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('OpenCode Sessions')
          .setDescription(lines.join('\n'))
          .addFields({ name: 'Total', value: `${allSessionIds.length}`, inline: true })
          .setColor(0x3498db);

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await interaction.editReply({
          content: `❌ Failed to list sessions: ${(error as Error).message}`,
        });
      }
      return;
    }

    if (subcommand === 'attach') {
      const thread = interaction.channel;
      if (!thread?.isThread()) {
        await interaction.reply({
          content: '❌ This command can only be used in a thread.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const threadId = thread.id;
      const parentChannelId = getParentChannelId(interaction);
      const projectPath = dataStore.getChannelProjectPath(parentChannelId);
      if (!projectPath) {
        await interaction.editReply({
          content: '❌ No project set for this channel. Use `/use <alias>` to set a project.',
        });
        return;
      }

      try {
        const port = await serveManager.spawnServe(projectPath);
        await serveManager.waitForReady(port, 30000, projectPath);

        const activeSessions = await sessionManager.listSessions(port);
        if (activeSessions.length === 0) {
          await interaction.editReply({
            content: '❌ No sessions available to attach.',
          });
          return;
        }

        const persistedSessions = dataStore.getAllThreadSessions();
        const persistedById = new Map(persistedSessions.map((s) => [s.sessionId, s]));

        const options = activeSessions.slice(0, 25).map((session) => {
          const persisted = persistedById.get(session.id);
          const title = session.title || 'untitled';
          const mappingInfo = persisted ? `mapped:<#${persisted.threadId}>` : 'not mapped';
          const timeInfo = persisted ? formatRelativeTime(persisted.lastUsedAt) : 'unknown';
          return {
            label: title.slice(0, 25),
            description: `${session.id.slice(0, 8)} | ${mappingInfo} | ${timeInfo}`.slice(0, 100),
            value: session.id,
          };
        });

        const select = new StringSelectMenuBuilder()
          .setCustomId('session-attach-select')
          .setPlaceholder('Select a session to attach')
          .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

        await interaction.editReply({
          content: 'Select a session to attach to this thread:',
          components: [row],
        });
        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({
          componentType: ComponentType.StringSelect,
          filter: (i) => i.user.id === interaction.user.id,
          time: 120_000,
          max: 1,
        });

        collector.on('collect', async (i) => {
          await i.deferUpdate();

          const sessionId = i.values[0];
          const sessionInfo = await sessionManager.getSessionInfo(port, sessionId);
          if (!sessionInfo) {
            await i.editReply({
              content: '❌ Selected session is no longer available.',
              components: [],
            });
            return;
          }

          const title = sessionInfo.title || 'untitled';
          const allSessions = dataStore.getAllThreadSessions();
          const existingMapping = allSessions.find(
            (s) => s.sessionId === sessionId && s.threadId !== threadId
          );

          sessionManager.setSessionForThread(threadId, sessionId, projectPath, port);
          dataStore.updateQueueSettings(threadId, { freshContext: false });

          const note = existingMapping
            ? '\n⚠️ Note: This session was previously used in another thread.'
            : '';

          await i.editReply({
            content: `✅ **${title}** (\`${sessionId.slice(0, 8)}\`) attached to this thread.${note}`,
            components: [],
          });
        });

        collector.on('end', async (_, reason) => {
          if (reason === 'time') {
            await interaction
              .editReply({
                content: '⏱️ Selection timed out.',
                components: [],
              })
              .catch(() => {});
          }
        });
      } catch (error) {
        await interaction.editReply({
          content: `❌ Failed to attach session: ${(error as Error).message}`,
        });
      }
      return;
    }

    if (subcommand === 'detach') {
      const thread = interaction.channel;
      if (!thread?.isThread()) {
        await interaction.reply({
          content: '❌ This command can only be used in a thread.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const threadId = thread.id;
      const currentSession = sessionManager.getSessionForThread(threadId);
      if (!currentSession) {
        await interaction.reply({
          content: '❌ No session attached to this thread.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sseClient = sessionManager.getSseClient(threadId);
      if (sseClient) {
        sseClient.disconnect();
        sessionManager.clearSseClient(threadId);
      }

      sessionManager.clearSessionForThread(threadId);

      await interaction.reply({
        content: '✅ Session detached from this thread.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'sync') {
      const thread = interaction.channel;
      if (!thread?.isTextBased() || thread.isDMBased()) {
        await interaction.reply({
          content: '❌ Este comando solo funciona en un canal de sesión.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const currentSession = sessionManager.getSessionForThread(interaction.channelId);
      if (!currentSession) {
        await interaction.reply({
          content: '❌ No hay sesión adjunta a este canal.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await sessionSync.syncSessionToChannel(thread, interaction.channelId);
        await interaction.editReply(
          result.posted > 0
            ? `🔄 Sincronizados ${result.posted} mensajes nuevos.`
            : '🔄 Sin mensajes nuevos para sincronizar.',
        );
      } catch (error) {
        await interaction.editReply(
          `❌ No se pudo sincronizar: ${(error as Error).message}`,
        );
      }
      return;
    }

    if (subcommand === 'info') {
      const thread = interaction.channel;
      if (!thread?.isThread()) {
        await interaction.reply({
          content: '❌ This command can only be used in a thread.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const threadId = thread.id;
      const currentSession = sessionManager.getSessionForThread(threadId);
      if (!currentSession) {
        await interaction.reply({
          content: '❌ No session attached to this thread.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const parentChannelId = getParentChannelId(interaction);
        const projectPath = dataStore.getChannelProjectPath(parentChannelId) ?? currentSession.projectPath;
        const port = currentSession.port;
        const sessionInfo = await sessionManager.getSessionInfo(port, currentSession.sessionId);
        const isAlive = sessionInfo !== null;
        const title = sessionInfo?.title || 'untitled';
        const threadSession = dataStore.getThreadSession(threadId);
        const isBusy = sessionManager.getSseClient(threadId)?.isConnected() ?? false;

        const embed = new EmbedBuilder()
          .setTitle(`Session: ${title}`)
          .addFields(
            { name: 'Session ID', value: `\`${currentSession.sessionId}\`` },
            { name: 'Project Path', value: `\`${projectPath}\`` },
            { name: 'Directory', value: `\`${sessionInfo?.directory ?? projectPath}\`` },
            { name: 'Port', value: `\`${port}\``, inline: true },
            { name: 'Status', value: isAlive ? 'alive' : 'dead', inline: true },
            {
              name: 'Created At',
              value: threadSession ? formatRelativeTime(threadSession.createdAt) : 'unknown',
              inline: true,
            },
            {
              name: 'Last Used At',
              value: threadSession ? formatRelativeTime(threadSession.lastUsedAt) : 'unknown',
              inline: true,
            },
            { name: 'SSE Active', value: isBusy ? 'true' : 'false', inline: true },
            {
              name: 'Continuar en local',
              value: `\`\`\`\ncd ${projectPath} && opencode --session ${currentSession.sessionId}\n\`\`\``,
            },
          )
          .setColor(isAlive ? 0x2ecc71 : 0xe74c3c);

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await interaction.editReply({
          content: `❌ Failed to read session info: ${(error as Error).message}`,
        });
      }
    }
  },
};
