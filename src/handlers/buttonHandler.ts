import { ButtonInteraction, ThreadChannel, MessageFlags } from 'discord.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';
import { SSEClient } from '../services/sseClient.js';

export async function handleButton(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  
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

  let port: number | undefined;
  let sseClient: SSEClient | undefined;

  try {
    port = await serveManager.spawnServe(mapping.worktreePath, preferredModel);
    await serveManager.waitForReady(port, 30000, mapping.worktreePath, preferredModel);

    const sessionId = await sessionManager.ensureSessionForThread(threadId, mapping.worktreePath, port);

    sseClient = new SSEClient();
    let accumulatedText = '';
    let promptSent = false;

    sseClient.connect(`http://127.0.0.1:${port}`);
    sessionManager.setSseClient(threadId, sseClient);

    sseClient.onPartUpdated((part) => {
      if (part.sessionID !== sessionId) return;
      accumulatedText = part.text;
    });

    sseClient.onSessionIdle((idleSessionId) => {
      if (idleSessionId !== sessionId) return;
      if (!promptSent) return;

      sseClient!.disconnect();
      sessionManager.clearSseClient(threadId);

      if (accumulatedText.trim()) {
        (channel as any).send({ content: `✅ **PR Creation Complete**\n${accumulatedText.slice(0, 1990)}` }).catch(() => {});
      } else {
        (channel as any).send({ content: '⚠️ PR creation completed but no output was received.' }).catch(() => {});
      }
    });

    sseClient.onSessionError((errorSessionId, errorInfo) => {
      if (errorSessionId !== sessionId) return;

      sseClient!.disconnect();
      sessionManager.clearSseClient(threadId);

      const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
      (channel as any).send({ content: `❌ **PR creation failed**: ${errorMsg}` }).catch(() => {});
    });

    sseClient.onError((error) => {
      sseClient!.disconnect();
      sessionManager.clearSseClient(threadId);
      (channel as any).send({ content: `❌ **Connection error**: ${error.message}` }).catch(() => {});
    });

    const prPrompt = `Create a pull request for the current branch. Include a clear title and description summarizing all changes.`;
    await sessionManager.sendPrompt(port, sessionId, prPrompt, preferredModel);
    promptSent = true;

    await interaction.editReply({ content: '✅ PR creation started — the result will be posted in this thread.' });
  } catch (error) {
    if (sseClient) {
      sseClient.disconnect();
      sessionManager.clearSseClient(threadId);
    }
    await interaction.editReply({ content: `❌ Failed to start PR creation: ${(error as Error).message}` });
  }
}
