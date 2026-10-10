import {
  ActionRowBuilder,
  ButtonInteraction,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel,
} from 'discord.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';
import * as sessionFlow from '../services/sessionFlow.js';
import * as qaPrompts from '../services/qaPrompts.js';
import * as pendingRequests from '../services/pendingRequests.js';
import { computeDiff } from '../commands/diff.js';
import { getCachedModels } from '../commands/model.js';
import * as sessionSync from '../services/sessionSync.js';

export async function handleButton(interaction: ButtonInteraction) {
  const customId = interaction.customId;

  if (customId === 'new-session') {
    await handleNewSession(interaction);
    return;
  }
  if (customId === 'sessions-list') {
    await handleSessionsList(interaction);
    return;
  }
  if (customId === 'model-hub') {
    await handleModelSelect(interaction, getHubChannelId(interaction));
    return;
  }
  if (customId === 'project-hub') {
    await handleProjectSelect(interaction);
    return;
  }
  if (customId.startsWith('qreject_')) {
    await handleQuestionReject(interaction, customId.slice('qreject_'.length));
    return;
  }
  if (customId.startsWith('preply_')) {
    const { requestID, suffix } = pendingRequests.splitCustomId(customId, 'preply_');
    await handlePermissionReply(interaction, requestID, suffix as 'once' | 'always' | 'reject');
    return;
  }
  if (customId.startsWith('qother_')) {
    const { requestID, suffix } = pendingRequests.splitCustomId(customId, 'qother_');
    await handleQuestionOther(interaction, requestID, Number(suffix));
    return;
  }

  const [action, channelId] = customId.split('_');

  if (!channelId) {
    await interaction.reply({
      content: '❌ Invalid button.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (action) {
    case 'interrupt':
      await handleInterrupt(interaction, channelId);
      break;
    case 'mode':
      await handleModeToggle(interaction, channelId);
      break;
    case 'diff':
      await handleDiff(interaction, channelId);
      break;
    case 'undo':
      await handleUndo(interaction, channelId);
      break;
    case 'archive':
      await handleArchive(interaction, channelId);
      break;
    case 'status':
      await handleStatus(interaction, channelId);
      break;
    case 'compact':
      await handleCompact(interaction, channelId);
      break;
    case 'init':
      await handleInit(interaction, channelId);
      break;
    case 'modelbtn':
      await handleModelSelect(interaction, channelId);
      break;
    case 'sync':
      await handleSync(interaction, channelId);
      break;
    case 'delete':
      await handleWorktreeDelete(interaction, channelId);
      break;
    case 'pr':
      await handleWorktreePR(interaction, channelId);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown action.',
        flags: MessageFlags.Ephemeral,
      });
  }
}

function getHubChannelId(interaction: ButtonInteraction): string {
  const hub = dataStore.getHubConfig();
  return hub?.hubChannelId ?? interaction.channelId;
}

async function handleNewSession(interaction: ButtonInteraction) {
  await interaction.showModal({
    customId: 'new-session-modal',
    title: 'Nueva sesión',
    components: [
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('session-name')
          .setLabel('Nombre de la sesión')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('ej: 24 agosto')
          .setRequired(true)
          .setMaxLength(90),
      ),
    ],
  });
}

async function handleSessionsList(interaction: ButtonInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const hub = dataStore.getHubConfig();
  const threadSessions = dataStore.getAllThreadSessions();
  const mappedBySession = new Map(threadSessions.map((s) => [s.sessionId, s]));
  const archived = dataStore.getArchivedSessions();
  const archivedByChannel = new Map(archived.map((a) => [a.channelId, a]));

  let projectPath: string | undefined;
  if (hub) {
    projectPath = dataStore.getChannelProjectPath(hub.hubChannelId);
  }

  let storedSessions: { id: string; title: string; port: number; time?: string; timeUpdated?: string }[] = [];
  if (projectPath) {
    try {
      const port = await serveManager.spawnServe(projectPath, hub?.model);
      await serveManager.waitForReady(port, 30000, projectPath, hub?.model);
      const list = await sessionManager.listSessions(port);
      storedSessions = list.map((s) => ({ ...s, port }));
    } catch (error) {
      console.error('[sessions] Failed to list opencode sessions:', error);
    }
  }

  const mappedLines: string[] = [];
  const unmapped: { id: string; title: string }[] = [];

  const sortedSessions = [...storedSessions].sort((a, b) => {
    const ta = a.timeUpdated || a.time || '';
    const tb = b.timeUpdated || b.time || '';
    if (ta && tb && ta !== tb) return tb.localeCompare(ta);
    return a.id.localeCompare(b.id);
  });

  for (const s of sortedSessions) {
    const mapping = mappedBySession.get(s.id);
    if (mapping) {
      const archivedFlag = archivedByChannel.has(mapping.threadId) ? '🔒 ' : '';
      const busy = sessionManager.getSseClient(mapping.threadId)?.isConnected()
        ? '🟢'
        : '⚪';
      mappedLines.push(`${busy} ${archivedFlag}<#${mapping.threadId}> · ${s.title || s.id.slice(0, 8)}`);
    } else {
      unmapped.push({ id: s.id, title: s.title || s.id.slice(0, 8) });
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 Sesiones')
    .setColor(0x3498db);

  if (mappedLines.length > 0) {
    embed.addFields({
      name: 'En Discord',
      value: mappedLines.slice(0, 15).join('\n'),
    });
  }

  const unmappedToShow = unmapped.slice(0, 15);
  if (unmappedToShow.length > 0) {
    embed.addFields({
      name: 'Otras sesiones (de opencode)',
      value: unmappedToShow.map((s) => `• ${s.title} (\`${s.id.slice(0, 8)}\`)`).join('\n'),
    });
  }

  if (!mappedLines.length && !unmappedToShow.length && archived.length === 0) {
    embed.setDescription('No hay sesiones. Tocá **🆕 Nueva sesión** para crear una.');
  }

  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder>> = [];

  if (unmappedToShow.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('attach-session-select')
      .setPlaceholder('Resumir sesión en Discord')
      .setMaxValues(Math.min(unmappedToShow.length, 5))
      .addOptions(
        unmappedToShow.slice(0, 25).map((s) => ({
          label: s.title.slice(0, 25),
          description: s.id.slice(0, 8),
          value: s.id,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  if (archived.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('reopen-select')
      .setPlaceholder('Reabrir sesión archivada')
      .setMaxValues(Math.min(archived.length, 5))
      .addOptions(
        archived
          .slice(-25)
          .reverse()
          .map((a) => ({
            label: (a.title || a.channelId.slice(0, 8)).slice(0, 25),
            description: a.sessionId ? a.sessionId.slice(0, 8) : 'sin sesión',
            value: a.channelId,
          })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  await interaction.editReply({
    embeds: [embed],
    components: rows,
  });
}

async function handleSync(
  interaction: ButtonInteraction,
  channelId: string,
) {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || channel.isDMBased()) {
    await interaction.reply({
      content: '❌ Canal no soportado para sincronizar.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await sessionSync.syncSessionToChannel(channel, channelId);
    await interaction.editReply(
      result.posted > 0
        ? `🔄 Sincronizados ${result.posted} mensajes nuevos.`
        : '🔄 Sin mensajes nuevos para sincronizar.',
    );
  } catch (error) {
    console.error('[sync] failed:', error);
    await interaction.editReply('❌ No se pudo sincronizar la sesión.');
  }
}

async function handleModelSelect(
  interaction: ButtonInteraction,
  channelId: string,
) {
  const models = getCachedModels();
  if (models.length === 0) {
    await interaction.reply({
      content: '❌ No se pudieron cargar los modelos.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const options = models.slice(0, 25).map((m) => ({
    label: m,
    value: m,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`model-select_${channelId}`)
    .setPlaceholder('Elegí un modelo')
    .addOptions(options);

  await interaction.reply({
    content: `🧠 **Modelo** para <#${channelId}>:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleProjectSelect(interaction: ButtonInteraction) {
  const projects = dataStore.getProjects();
  if (projects.length === 0) {
    await interaction.reply({
      content: '❌ No hay proyectos registrados. Usá `/setpath`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('project-select')
    .setPlaceholder('Elegí un proyecto')
    .addOptions(
      projects.slice(0, 25).map((p) => ({
        label: p.alias.slice(0, 25),
        description: p.path.slice(0, 80),
        value: p.alias,
      })),
    );

  await interaction.reply({
    content: '📂 **Proyecto** por defecto:',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleInterrupt(interaction: ButtonInteraction, threadId: string) {
  const session = sessionManager.getSessionForThread(threadId);

  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;
  const parentChannelId = channel?.isThread() ? (channel as ThreadChannel).parentId! : channel?.id;
  const preferredModel = parentChannelId ? dataStore.getChannelModel(parentChannelId) : undefined;

  const port = serveManager.getPort(session.projectPath, preferredModel);

  if (!port) {
    await interaction.reply({
      content: '⚠️ Server is not running.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const success = await sessionManager.abortSession(port, session.sessionId);

  if (success) {
    await interaction.editReply({ content: '⏸️ Interrupt request sent.' });
  } else {
    await interaction.editReply({ content: '⚠️ Failed to interrupt. Server may not be running or no active task.' });
  }
}

async function handleModeToggle(interaction: ButtonInteraction, channelId: string) {
  const current = dataStore.getChannelAgent(channelId);
  const next = current === 'plan' ? 'build' : 'plan';
  dataStore.setChannelAgent(channelId, next);

  const channel = interaction.channel;
  if (channel?.isTextBased() && !channel.isDMBased()) {
    await sessionFlow.refreshSticky(channel as TextChannel, channelId, next);
  }

  await interaction.reply({
    content: next === 'plan' ? '🎯 Modo **Plan** activado (no toca archivos).' : '🔨 Modo **Build** activado.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDiff(interaction: ButtonInteraction, channelId: string) {
  const projectPath = dataStore.getChannelProjectPath(channelId);
  if (!projectPath) {
    await interaction.reply({
      content: '❌ No project bound to this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await computeDiff(projectPath, 'unstaged', false, 'main');
  if (result.ok) {
    await interaction.editReply(result.content as string);
  } else {
    await interaction.editReply(`❌ Failed to get diff: ${result.error}`);
  }
}

async function handleUndo(interaction: ButtonInteraction, channelId: string) {
  const session = sessionManager.getSessionForThread(channelId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ No hay sesión en este canal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await sessionManager.revertLastMessage(session.port, session.sessionId);
  if (result.ok) {
    await interaction.editReply({ content: '↩️ Último mensaje revertido.' });
  } else {
    await interaction.editReply({
      content: `⚠️ No se pudo revertir: ${result.message || 'error desconocido'}`,
    });
  }
}

async function handleArchive(interaction: ButtonInteraction, channelId: string) {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || channel.isDMBased()) {
    await interaction.reply({
      content: '❌ Este botón solo funciona en un canal de sesión.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await sessionFlow.archiveSessionChannel(channel as TextChannel, channelId);

  await interaction.editReply({
    content: '🗑 Sesión archivada y canal oculto. Para reabrirla: **📋 Sesiones** en el hub.',
  });
}

async function handleStatus(interaction: ButtonInteraction, channelId: string) {
  const projectPath = dataStore.getChannelProjectPath(channelId);
  const session = sessionManager.getSessionForThread(channelId);
  const model = dataStore.getChannelModel(channelId) || 'default';
  const agent = dataStore.getChannelAgent(channelId);
  const busy = sessionManager.getSseClient(channelId)?.isConnected();

  let branch = 'n/a';
  if (projectPath) {
    try {
      branch = (await worktreeManager.getCurrentBranch(projectPath)) || 'n/a';
    } catch {
      branch = 'n/a';
    }
  }

  let sessionTitle = session?.sessionId ?? 'sin sesión';
  if (session) {
    try {
      const info = await sessionManager.getSessionInfo(session.port, session.sessionId);
      if (info?.title) sessionTitle = info.title;
    } catch {
      // ignore
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('ℹ️ Estado de la sesión')
    .addFields(
      { name: 'Proyecto', value: projectPath ? `\`${projectPath}\`` : 'n/a' },
      { name: 'Rama', value: `\`${branch}\``, inline: true },
      { name: 'Modelo', value: `\`${model}\``, inline: true },
      { name: 'Modo', value: agent === 'plan' ? '🎯 Plan' : '🔨 Build', inline: true },
      { name: 'Sesión', value: `\`${sessionTitle}\`` },
      { name: 'Estado', value: busy ? '🟢 trabajando' : '⚪ inactivo', inline: true },
    )
    .setColor(busy ? 0x2ecc71 : 0x95a5a6);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCompact(interaction: ButtonInteraction, channelId: string) {
  const session = sessionManager.getSessionForThread(channelId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ No hay sesión en este canal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const model = dataStore.getChannelModel(channelId);
  const ok = await sessionManager.summarizeSession(session.port, session.sessionId, model);
  await interaction.editReply({
    content: ok ? '🧹 Resumen del contexto generado.' : '⚠️ No se pudo compactar el contexto.',
  });
}

async function handleInit(interaction: ButtonInteraction, channelId: string) {
  const session = sessionManager.getSessionForThread(channelId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ No hay sesión en este canal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const model = dataStore.getChannelModel(channelId);
  const ok = await sessionManager.initSession(session.port, session.sessionId, model);
  await interaction.editReply({
    content: ok ? '⚡ AGENTS.md generado/actualizado.' : '⚠️ No se pudo inicializar el proyecto.',
  });
}

async function handleQuestionReject(interaction: ButtonInteraction, requestID: string) {
  const entry = pendingRequests.getPending(requestID);
  if (!entry || entry.kind !== 'question') {
    await interaction.reply({
      content: '⚠️ Pregunta no encontrada o ya respondida.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ok = await sessionManager.rejectQuestion(entry.port, entry.sessionID, requestID);
  pendingRequests.deletePending(requestID);
  if (interaction.channel) {
    await qaPrompts.disableMessage(interaction.channel, entry.messageId, '❌ Pregunta cancelada.');
  }
  await interaction.editReply({
    content: ok ? '❌ Pregunta cancelada.' : '⚠️ No se pudo cancelar la pregunta.',
  });
}

async function handlePermissionReply(
  interaction: ButtonInteraction,
  requestID: string,
  reply: 'once' | 'always' | 'reject',
) {
  const entry = pendingRequests.getPending(requestID);
  if (!entry || entry.kind !== 'permission') {
    await interaction.reply({
      content: '⚠️ Permiso no encontrado o ya respondido.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ok = await sessionManager.replyToPermission(entry.port, entry.sessionID, requestID, reply);
  pendingRequests.deletePending(requestID);
  if (interaction.channel) {
    const note =
      reply === 'reject'
        ? '❌ Permiso rechazado.'
        : `✅ Permiso permitido${reply === 'always' ? ' (siempre)' : ''}.`;
    await qaPrompts.disableMessage(interaction.channel, entry.messageId, note);
  }
  await interaction.editReply({
    content: ok
      ? reply === 'reject'
        ? '❌ Permiso rechazado.'
        : `✅ Permiso permitido${reply === 'always' ? ' (siempre)' : ''}.`
      : '⚠️ No se pudo responder el permiso.',
  });
}

async function handleQuestionOther(interaction: ButtonInteraction, requestID: string, qIndex: number) {
  const entry = pendingRequests.getPending(requestID);
  if (!entry || entry.kind !== 'question') {
    await interaction.reply({
      content: '⚠️ Pregunta no encontrada o ya respondida.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const question = entry.questions[qIndex];
  if (!question?.custom) {
    await interaction.reply({
      content: '⚠️ Esta pregunta no admite respuesta libre.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal({
    customId: `qother-modal_${requestID}_${qIndex}`,
    title: question.header || 'Respondé',
    components: [
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('answer')
          .setLabel(question.question.slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Escribí tu respuesta...')
          .setRequired(true)
          .setMaxLength(1900),
      ),
    ],
  });
}

async function handleWorktreeDelete(interaction: ButtonInteraction, threadId: string) {
  const mapping = dataStore.getWorktreeMapping(threadId);
  if (!mapping) {
    await interaction.reply({ content: '⚠️ Worktree mapping not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (worktreeManager.worktreeExists(mapping.worktreePath)) {
      await worktreeManager.removeWorktree(mapping.worktreePath, false);
    }

    dataStore.removeWorktreeMapping(threadId);

    const channel = interaction.channel;
    if (channel?.isThread()) {
      await (channel as ThreadChannel).setArchived(true);
    }

    await interaction.editReply({ content: '✅ Worktree deleted and thread archived.' });
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed to delete worktree: ${(error as Error).message}` });
  }
}

async function handleWorktreePR(interaction: ButtonInteraction, threadId: string) {
  const mapping = dataStore.getWorktreeMapping(threadId);
  if (!mapping) {
    await interaction.reply({ content: '⚠️ Worktree mapping not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = interaction.channel;
  const parentChannelId = channel?.isThread() ? (channel as ThreadChannel).parentId! : channel?.id;
  const preferredModel = parentChannelId ? dataStore.getChannelModel(parentChannelId) : undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const port = await serveManager.spawnServe(mapping.worktreePath, preferredModel);
    await serveManager.waitForReady(port, 30000, mapping.worktreePath, preferredModel);

    const sessionId = await sessionManager.ensureSessionForThread(threadId, mapping.worktreePath, port);

    const prPrompt = `Create a pull request for the current branch. Include a clear title and description summarizing all changes.`;
    await sessionManager.sendPrompt(port, sessionId, prPrompt, preferredModel);

    await interaction.editReply({ content: '🚀 PR creation started! Check the thread for progress.' });
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed to start PR creation: ${(error as Error).message}` });
  }
}
