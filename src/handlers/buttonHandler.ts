import { ButtonInteraction, ThreadChannel, MessageFlags } from 'discord.js';
import type { QuestionRequest } from '../types/index.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';

export async function handleButton(interaction: ButtonInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qanswer:')) {
    const [, threadId, requestId, optionIndexRaw] = customId.split(':');
    await handleQuestionAnswer(interaction, threadId, requestId, optionIndexRaw);
    return;
  }

  if (customId.startsWith('qreject:')) {
    const [, threadId, requestId] = customId.split(':');
    await handleQuestionReject(interaction, threadId, requestId);
    return;
  }
  
  const [action, threadId] = customId.split('_');
  
  if (!threadId) {
    await interaction.reply({
      content: '❌ Invalid button.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  
  if (action === 'interrupt') {
    await handleInterrupt(interaction, threadId);
  } else if (action === 'delete') {
    await handleWorktreeDelete(interaction, threadId);
  } else if (action === 'pr') {
    await handleWorktreePR(interaction, threadId);
  } else {
    await interaction.reply({
      content: '❌ Unknown action.',
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleInterrupt(interaction: ButtonInteraction, threadId: string) {
  const session = sessionManager.getSessionForThread(threadId);
  
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral
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
      flags: MessageFlags.Ephemeral
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


async function handleQuestionAnswer(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  optionIndexRaw: string | undefined,
) {
  const optionIndex = Number(optionIndexRaw);

  if (!threadId || !requestId || !Number.isInteger(optionIndex)) {
    await interaction.reply({
      content: '❌ Invalid question response.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = questions.find((q) => q.id === requestId);
    const question = request?.questions?.[0];
    const option = question?.options?.[optionIndex];

    if (!option?.label) {
      await interaction.editReply({
        content: '⚠️ Pending question/option not found. It may have already been answered.',
      });
      return;
    }

    await sessionManager.replyQuestion(session.port, requestId, [[option.label]]);
    await interaction.editReply({ content: `✅ Sent response: ${option.label}` });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to answer question: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionReject(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
) {
  if (!threadId || !requestId) {
    await interaction.reply({
      content: '❌ Invalid question rejection.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await sessionManager.rejectQuestion(session.port, requestId);
    await interaction.editReply({ content: '🚫 Question rejected.' });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to reject question: ${(error as Error).message}`,
    });
  }
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
