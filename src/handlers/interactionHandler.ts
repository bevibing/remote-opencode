import { Interaction, MessageFlags, StringSelectMenuInteraction, TextChannel } from 'discord.js';
import { commands } from '../commands/index.js';
import { handleButton } from './buttonHandler.js';
import { isAuthorized } from '../services/configStore.js';
import * as dataStore from '../services/dataStore.js';
import * as sessionFlow from '../services/sessionFlow.js';
import * as serveManager from '../services/serveManager.js';
import * as sessionManager from '../services/sessionManager.js';
import * as qaPrompts from '../services/qaPrompts.js';
import * as pendingRequests from '../services/pendingRequests.js';

export async function handleInteraction(interaction: Interaction) {
  if (interaction.isButton()) {
    if (!isAuthorized(interaction.user.id)) {
      await interaction.reply({
        content: '🚫 You are not authorized to use this bot.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    try {
      await handleButton(interaction);
    } catch (error) {
      console.error('Error handling button:', error);
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (!isAuthorized(interaction.user.id)) {
      await interaction.reply({
        content: '🚫 You are not authorized to use this bot.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (interaction.customId === 'new-session-modal') {
      await handleNewSessionModal(interaction);
    } else if (interaction.customId.startsWith('qother-modal_')) {
      await handleQuestionModal(interaction);
    }
    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (!isAuthorized(interaction.user.id)) {
      await interaction.reply({
        content: '🚫 You are not authorized to use this bot.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    try {
      await handleSelectMenu(interaction);
    } catch (error) {
      console.error('Error handling select menu:', error);
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(`Error handling autocomplete for ${interaction.commandName}:`, error);
        try {
          if (!interaction.responded) {
            await interaction.respond([]);
          }
        } catch {
          // Interaction already expired — nothing to do
        }
      }
    }
    return;
  }
  
  if (!interaction.isChatInputCommand()) return;
  
  if (!isAuthorized(interaction.user.id)) {
    await interaction.reply({
      content: '🚫 You are not authorized to use this bot.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  
  const command = commands.get(interaction.commandName);
  
  if (!command) {
    return;
  }
  
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing command ${interaction.commandName}:`, error);
    const content = '❌ An error occurred while executing the command.';
    
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error('Failed to send error response to user:', replyError);
    }
  }
}

async function handleNewSessionModal(interaction: Interaction) {
  if (!interaction.isModalSubmit()) return;
  const name = interaction.fields.getTextInputValue('session-name').trim();
  if (!name) {
    await interaction.reply({
      content: '❌ El nombre no puede estar vacío.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const hub = dataStore.getHubConfig();
  if (!hub) {
    await interaction.reply({
      content: '❌ No hay hub configurado. Usá `/hub` primero.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: '❌ No se pudo determinar el servidor.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const channel = await sessionFlow.createSessionChannel(
      interaction.guild,
      name,
      hub.projectAlias,
      hub.model,
      hub.agent,
      interaction.user.id,
    );
    await interaction.editReply({
      content: `✅ Sesión **${name}** creada: <#${channel.id}>\nEscribí tu prompt en ese canal.`,
    });
  } catch (error) {
    console.error('Failed to create session channel:', error);
    await interaction.editReply({
      content: `❌ No se pudo crear la sesión: ${(error as Error).message}`,
    });
  }
}

async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qsel_')) {
    const { requestID, suffix } = pendingRequests.splitCustomId(customId, 'qsel_');
    const qIndex = Number(suffix);
    const entry = pendingRequests.getPending(requestID);
    if (!entry || entry.kind !== 'question') {
      await interaction.reply({
        content: '⚠️ Pregunta no encontrada o ya respondida.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    entry.answers[qIndex] = [...interaction.values];

    if (!pendingRequests.isQuestionComplete(entry)) {
      const answered = Object.keys(entry.answers).length;
      await interaction.reply({
        content: `✅ Pregunta ${answered}/${entry.questions.length} respondida.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();
    const ok = await sessionManager.replyToQuestion(
      entry.port,
      entry.sessionID,
      requestID,
      pendingRequests.buildQuestionAnswers(entry),
    );
    pendingRequests.deletePending(requestID);
    const note = ok ? '✅ Pregunta respondida.' : '⚠️ No se pudo enviar la respuesta.';
    await interaction.editReply({
      content: note,
      embeds: [],
      components: [],
    });
    return;
  }

  if (customId.startsWith('model-select_')) {
    const channelId = customId.replace('model-select_', '');
    const model = interaction.values[0];
    dataStore.setChannelModel(channelId, model);

    const hub = dataStore.getHubConfig();
    if (hub?.hubChannelId === channelId) {
      dataStore.setHubConfig({ ...hub, model });
    }

    await interaction.update({
      content: `✅ Modelo para <#${channelId}> → \`${model}\``,
      components: [],
    });
    return;
  }

  if (customId === 'project-select') {
    const alias = interaction.values[0];
    const hub = dataStore.getHubConfig();
    if (hub) {
      dataStore.setHubConfig({ ...hub, projectAlias: alias });
      dataStore.setChannelBinding(hub.hubChannelId, alias, hub.model);
    }
    await interaction.update({
      content: `✅ Proyecto por defecto → \`${alias}\``,
      components: [],
    });
    return;
  }

  if (customId === 'reopen-select') {
    const hub = dataStore.getHubConfig();
    const reabiertas: string[] = [];
    for (const channelId of interaction.values) {
      const archived = dataStore.getArchivedSession(channelId);
      if (archived && interaction.guild) {
        const channel = await sessionFlow.reopenSessionChannel(
          interaction.guild,
          archived,
          interaction.user.id,
        );
        if (channel) reabiertas.push(`<#${channel.id}>`);
      }
    }

    const hubNote = hub ? ` Hub: <#${hub.hubChannelId}>` : '';
    await interaction.update({
      content:
        reabiertas.length > 0
          ? `✅ Sesiones reabiertas: ${reabiertas.join(', ')}`
          : '⚠️ No se pudo reabrir ninguna sesión.',
      components: [],
    });
    return;
  }

  if (customId === 'attach-session-select') {
    await interaction.update({
      content: '🔄 Creando canales de sesión...',
      components: [],
    });

    const hub = dataStore.getHubConfig();
    if (!hub) {
      await interaction.editReply({
        content: '❌ No hay hub configurado. Usá `/hub` primero.',
      });
      return;
    }
    if (!interaction.guild) {
      await interaction.editReply({
        content: '❌ No se pudo determinar el servidor.',
      });
      return;
    }

    const projectPath = dataStore.getChannelProjectPath(hub.hubChannelId);
    if (!projectPath) {
      await interaction.editReply({
        content: '❌ No hay proyecto asignado al hub.',
      });
      return;
    }

    try {
      const port = serveManager.getPort(projectPath, hub.model);
      if (!port) {
        await interaction.editReply({
          content: '❌ No hay servidor opencode activo para el proyecto. Probá de nuevo en un momento.',
        });
        return;
      }

      const creados: string[] = [];
      for (const sessionId of interaction.values) {
        const info = await sessionManager.getSessionInfo(port, sessionId);
        const title = info?.title || 'sesion';
        const channel = await sessionFlow.createChannelForSession(
          interaction.guild,
          sessionId,
          title,
          projectPath,
          port,
          hub.projectAlias,
          hub.model,
          hub.agent,
          interaction.user.id,
        );
        creados.push(`<#${channel.id}>`);
      }

      await interaction.editReply({
        content:
          creados.length > 0
            ? `✅ Sesiones resumidas en Discord: ${creados.join(', ')}`
            : '⚠️ No se pudo resumir ninguna sesión.',
      });
    } catch (error) {
      console.error('Failed to attach sessions:', error);
      await interaction.editReply({
        content: `❌ Error al resumir sesiones: ${(error as Error).message}`,
      });
    }
    return;
  }
}

async function handleQuestionModal(interaction: Interaction) {
  if (!interaction.isModalSubmit()) return;
  const { requestID, suffix } = pendingRequests.splitCustomId(interaction.customId, 'qother-modal_');
  const qIndex = Number(suffix);
  const answer = interaction.fields.getTextInputValue('answer').trim();

  const entry = pendingRequests.getPending(requestID);
  if (!entry || entry.kind !== 'question') {
    await interaction.reply({
      content: '⚠️ Pregunta no encontrada o ya respondida.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  entry.answers[qIndex] = [answer];

  if (!pendingRequests.isQuestionComplete(entry)) {
    await interaction.reply({
      content: `✅ Pregunta ${Object.keys(entry.answers).length}/${entry.questions.length} respondida.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ok = await sessionManager.replyToQuestion(
    entry.port,
    entry.sessionID,
    requestID,
    pendingRequests.buildQuestionAnswers(entry),
  );
  pendingRequests.deletePending(requestID);
  if (interaction.channel) {
    await qaPrompts.disableMessage(
      interaction.channel,
      entry.messageId,
      ok ? '✅ Pregunta respondida.' : '⚠️ No se pudo enviar la respuesta.',
    );
  }
  await interaction.editReply({
    content: ok ? '✅ Pregunta respondida.' : '⚠️ No se pudo enviar la respuesta.',
  });
}
