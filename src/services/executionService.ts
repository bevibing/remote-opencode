import { 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  Message,
  TextBasedChannel,
  EmbedBuilder
} from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import { SSEClient } from './sseClient.js';
import { formatOutput, formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';

export async function runPrompt(
  channel: TextBasedChannel, 
  threadId: string, 
  prompt: string, 
  parentChannelId: string
): Promise<void> {
  const projectPath = dataStore.getChannelProjectPath(parentChannelId);
  if (!projectPath) {
    await (channel as any).send('❌ No project bound to parent channel.');
    return;
  }
  
  let worktreeMapping = dataStore.getWorktreeMapping(threadId);
  
  // Auto-create worktree if enabled and no mapping exists for this thread
  if (!worktreeMapping) {
    const projectAlias = dataStore.getChannelBinding(parentChannelId);
    if (projectAlias && dataStore.getProjectAutoWorktree(projectAlias)) {
      try {
        const branchName = worktreeManager.sanitizeBranchName(
          `auto/${threadId.slice(0, 8)}-${Date.now()}`
        );
        const worktreePath = await worktreeManager.createWorktree(projectPath, branchName);
        
        const newMapping = {
          threadId,
          branchName,
          worktreePath,
          projectPath,
          description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
          createdAt: Date.now()
        };
        dataStore.setWorktreeMapping(newMapping);
        worktreeMapping = newMapping;
        
        const embed = new EmbedBuilder()
          .setTitle(`🌳 Auto-Worktree: ${branchName}`)
          .setDescription('Automatically created for this session')
          .addFields(
            { name: 'Branch', value: branchName, inline: true },
            { name: 'Path', value: worktreePath, inline: true }
          )
          .setColor(0x2ecc71);
        
        const worktreeButtons = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`delete_${threadId}`)
              .setLabel('Delete')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`pr_${threadId}`)
              .setLabel('Create PR')
              .setStyle(ButtonStyle.Primary)
          );
        
        await (channel as any).send({ embeds: [embed], components: [worktreeButtons] });
      } catch (error) {
        console.error('Auto-worktree creation failed:', error);
      }
    }
  }
  
  const effectivePath = worktreeMapping?.worktreePath ?? projectPath;
  const preferredModel = dataStore.getChannelModel(parentChannelId);
  const modelDisplay = preferredModel ? `${preferredModel}` : 'default';
  
  const branchName = worktreeMapping?.branchName ?? await worktreeManager.getCurrentBranch(effectivePath) ?? 'main';
  const contextHeader = buildContextHeader(branchName, modelDisplay);
  
  const buttons = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`interrupt_${threadId}`)
        .setLabel('⏸️ Interrupt')
        .setStyle(ButtonStyle.Secondary)
    );
  
  let streamMessage: Message;
  try {
    streamMessage = await (channel as any).send({
      content: `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n🚀 Starting OpenCode server...`,
      components: [buttons]
    });
  } catch {
    return;
  }
  
  let port: number;
  let sessionId: string;
  let updateInterval: NodeJS.Timeout | null = null;
  let accumulatedText = '';
  let lastContent = '';
  let tick = 0;
  let promptSent = false;
  let hasSessionError = false;
  let lastSseEventAt = Date.now();
  const stallTimeoutMs = Number(process.env.OPENCODE_STALL_TIMEOUT_MS) || 90_000;
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  const buttonsWithForceKill = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`interrupt_${threadId}`)
        .setLabel('⏸️ Interrupt')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`forcekill_${threadId}`)
        .setLabel('🔪 Force Kill')
        .setStyle(ButtonStyle.Danger)
    );
  
  const updateStreamMessage = async (content: string, components: ActionRowBuilder<ButtonBuilder>[]): Promise<boolean> => {
    try {
      await streamMessage.edit({ content, components });
      return true;
    } catch (error) {
      console.error('Failed to edit stream message:', error instanceof Error ? error.message : error);
      return false;
    }
  };

  const safeSend = async (content: string): Promise<boolean> => {
    try {
      await (channel as any).send({ content });
      return true;
    } catch (error) {
      console.error('Failed to send message:', error instanceof Error ? error.message : error);
      return false;
    }
  };
  
  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel);
    
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⏳ Waiting for OpenCode server...`, [buttons]);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel);
    
    const settings = dataStore.getQueueSettings(threadId);
    
    // If fresh context is enabled, we always clear the session before starting
    if (settings.freshContext) {
      sessionManager.clearSessionForThread(threadId);
    }

    sessionId = await sessionManager.ensureSessionForThread(threadId, effectivePath, port);
    
    const sseClient = new SSEClient();
    lastSseEventAt = Date.now();
    sseClient.connect(`http://127.0.0.1:${port}`);
    sessionManager.setSseClient(threadId, sseClient);

    sseClient.onPartUpdated((part) => {
      if (part.sessionID !== sessionId) return;
      lastSseEventAt = Date.now();
      accumulatedText = part.text;
    });

    sseClient.onSessionIdle((idleSessionId) => {
      lastSseEventAt = Date.now();
      if (idleSessionId !== sessionId) return;
      if (!promptSent) return;
      
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          if (hasSessionError) {
            sseClient.disconnect();
            sessionManager.clearSseClient(threadId);
            return;
          }

          const disabledButtons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`interrupt_${threadId}`)
                .setLabel('⏸️ Interrupt')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            );

          if (!accumulatedText.trim()) {
            const edited = await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⚠️ No output received — the model may have encountered an issue.`,
              [disabledButtons]
            );
            if (!edited) {
              await safeSend('⚠️ No output received — the model may have encountered an issue.');
            }
            await safeSend('⚠️ Done (no output received)');
          } else {
            const result = formatOutputForMobile(accumulatedText);
            
            const editSuccess = await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${result.chunks[0]}`,
              [disabledButtons]
            );
            
            // If edit failed (e.g., content exceeds Discord's 2000-char limit), send all chunks as new messages
            const startIndex = editSuccess ? 1 : 0;
            for (let i = startIndex; i < result.chunks.length; i++) {
              await safeSend(result.chunks[i]);
            }
            
            await safeSend('✅ Done');
          }
          
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          
          await processNextInQueue(channel, threadId, parentChannelId);
        } catch (error) {
          console.error('Error in onSessionIdle:', error);
          await safeSend('❌ An unexpected error occurred while processing the response.');
        }
      })();
    });
    
    sseClient.onSessionError((errorSessionId, errorInfo) => {
      lastSseEventAt = Date.now();
      if (errorSessionId !== sessionId) return;
      if (!promptSent) return;
      
      hasSessionError = true;
      
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
          const disabledButtons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`interrupt_${threadId}`)
                .setLabel('⏸️ Interrupt')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            );
          
          const edited = await updateStreamMessage(
            `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ **Error**: ${errorMsg}`,
            [disabledButtons]
          );
          if (!edited) {
            await safeSend(`❌ **Error**: ${errorMsg}`);
          }
          
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          
          const settings = dataStore.getQueueSettings(threadId);
          if (settings.continueOnFailure) {
            await processNextInQueue(channel, threadId, parentChannelId);
          } else {
            dataStore.clearQueue(threadId);
            await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
          }
        } catch (error) {
          console.error('Error in onSessionError:', error);
          await safeSend('❌ An unexpected error occurred while handling a session error.');
        }
      })();
    });
    
    sseClient.onError((error) => {
      lastSseEventAt = Date.now();
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ Connection error: ${error.message}`, []);
          if (!edited) {
            await safeSend(`❌ Connection error: ${error.message}`);
          }
          
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          
          const settings = dataStore.getQueueSettings(threadId);
          if (settings.continueOnFailure) {
            await processNextInQueue(channel, threadId, parentChannelId);
          } else {
            dataStore.clearQueue(threadId);
            await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
          }
        } catch (handlerError) {
          console.error('Error in SSE onError handler:', handlerError);
          await safeSend('❌ An unexpected connection error occurred.');
        }
      })();
    });
    
    updateInterval = setInterval(async () => {
      tick++;
      try {
        const formatted = formatOutput(accumulatedText);
        const spinnerChar = spinner[tick % spinner.length];
        const stalledMs = Date.now() - lastSseEventAt;
        const isStalled = promptSent && stalledMs > stallTimeoutMs;
        const stalledSeconds = Math.round(stalledMs / 1000);

        const baseContent = formatted || 'Processing...';
        const header = isStalled
          ? `⚠️ **Stalled — no events for ${stalledSeconds}s**`
          : `${spinnerChar} **Running...**`;
        const activeButtons = isStalled ? buttonsWithForceKill : buttons;
        const newContent = `${header}\n${baseContent}`;

        if (newContent !== lastContent || tick % 2 === 0) {
          lastContent = newContent;
          await updateStreamMessage(
            `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${newContent}`,
            [activeButtons]
          );
        }
      } catch (error) {
        console.error('Error in stream update interval:', error instanceof Error ? error.message : error);
      }
    }, 1000);
    
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n📝 Sending prompt...`, [buttons]);
    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    promptSent = true;
    
  } catch (error) {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ OpenCode execution failed: ${errorMessage}`, []);
    if (!edited) {
      await safeSend(`❌ OpenCode execution failed: ${errorMessage}`);
    }
    
    const client = sessionManager.getSseClient(threadId);
    if (client) {
      client.disconnect();
      sessionManager.clearSseClient(threadId);
    }
    
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.continueOnFailure) {
      await processNextInQueue(channel, threadId, parentChannelId);
    } else {
      dataStore.clearQueue(threadId);
      await safeSend('❌ Execution failed. Queue cleared.');
    }
  }
}
