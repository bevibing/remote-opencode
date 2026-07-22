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
import {
  formatOutput,
  formatOutputForMobile,
  buildContextHeader,
  splitForDiscordTemplate,
  DISCORD_MAX_LENGTH,
} from '../utils/messageFormatter.js';
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
  // Defensively truncate the prompt in the initial message so very long
  // user prompts don't push the starting message past Discord's 2000-char
  // limit and cause `channel.send` to throw before we get anywhere.
  const safePrompt = prompt.length > 1500
    ? `${prompt.slice(0, 1500)}… (truncated)`
    : prompt;
  const initialContent = `${contextHeader}\n📌 **Prompt**: ${safePrompt}\n\n🚀 Starting OpenCode server...`;
  try {
    streamMessage = await (channel as any).send({
      content: initialContent.length <= DISCORD_MAX_LENGTH
        ? initialContent
        : `${contextHeader}\n📌 **Prompt**: ${safePrompt}\n\n🚀 Starting OpenCode server...`,
      components: [buttons]
    });
  } catch (error) {
    console.error('Failed to send initial stream message:', error instanceof Error ? error.message : error);
    try {
      await (channel as any).send(
        `❌ Could not start: prompt is too long for Discord (max ~${DISCORD_MAX_LENGTH} chars).`,
      );
    } catch {
      // Nothing more we can do; the channel is unreachable.
    }
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
  // Mitigation for Discord REST timeouts under sustained streaming:
  // discord.js's SequentialHandler queues edits on the same bucket, and
  // undici's default connectTimeout is 10s. If a single edit stalls
  // (Cloudflare keep-alive drop, transient network blip, etc.) every
  // subsequent 1Hz tick piles another request into the queue and they all
  // timeout in cascade, leaving the stream message frozen.
  //   1. We skip interval ticks while an edit is still in flight, so the
  //      SequentialHandler queue cannot grow unbounded.
  //   2. We race each edit against an explicit 8s timeout so a stuck edit
  //      fails fast and the next tick can try again with a fresh connection
  //      instead of waiting for undici's 10s default.
  const STREAM_EDIT_TIMEOUT_MS = 8000;
  let streamEditInFlight = false;
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  const updateStreamMessage = async (body: string, components: ActionRowBuilder<ButtonBuilder>[]): Promise<boolean> => {
    if (streamEditInFlight) {
      // Another edit is still pending in discord.js's queue — drop this tick.
      // The in-flight edit will complete (or fail fast via the timeout) and
      // the next tick will retry with fresh content.
      return false;
    }
    streamEditInFlight = true;
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const { prefixBody, overflowChunks } = splitForDiscordTemplate({
        header: contextHeader,
        prompt,
        body,
      });
      // Race the edit against a hard timeout so a stuck REST request can't
      // hold streamEditInFlight forever. discord.js's edit() does not
      // natively accept AbortSignal, so we race against a timeout that
      // rejects if the edit hangs longer than STREAM_EDIT_TIMEOUT_MS.
      let timedOut = false;
      const editPromise = streamMessage.edit({ content: prefixBody, components });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error(`stream edit timed out after ${STREAM_EDIT_TIMEOUT_MS}ms`));
        }, STREAM_EDIT_TIMEOUT_MS);
      });
      try {
        await Promise.race([editPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      if (timedOut) {
        // The underlying REST request is still pending in discord.js's queue
        // and will eventually resolve/reject on its own; we just stop waiting
        // so the next interval tick can proceed.
        console.error(`stream edit exceeded ${STREAM_EDIT_TIMEOUT_MS}ms; abandoning wait and continuing`);
        return false;
      }
      for (const chunk of overflowChunks) {
        try {
          await (channel as any).send({ content: chunk });
        } catch (sendErr) {
          console.error('Failed to send overflow chunk:', sendErr instanceof Error ? sendErr.message : sendErr);
        }
      }
      return true;
    } catch (error) {
      console.error('Failed to edit stream message:', error instanceof Error ? error.message : error);
      return false;
    } finally {
      streamEditInFlight = false;
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
    
    await updateStreamMessage('⏳ Waiting for OpenCode server...', [buttons]);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel);
    
    const settings = dataStore.getQueueSettings(threadId);
    
    // If fresh context is enabled, we always clear the session before starting
    if (settings.freshContext) {
      sessionManager.clearSessionForThread(threadId);
    }

    sessionId = await sessionManager.ensureSessionForThread(threadId, effectivePath, port);
    
    const sseClient = new SSEClient();
    sseClient.connect(`http://127.0.0.1:${port}`);
    sessionManager.setSseClient(threadId, sseClient);
    
    sseClient.onPartUpdated((part) => {
      if (part.sessionID !== sessionId) return;
      accumulatedText = part.text;
    });
    
    sseClient.onSessionIdle((idleSessionId) => {
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
              '⚠️ No output received — the model may have encountered an issue.',
              [disabledButtons],
            );
            if (!edited) {
              await safeSend('⚠️ No output received — the model may have encountered an issue.');
            }
            await safeSend('⚠️ Done (no output received)');
          } else {
            const result = formatOutputForMobile(accumulatedText);
            const fullBody = result.chunks.join('\n\n');
            const { prefixBody, overflowChunks } = splitForDiscordTemplate({
              header: contextHeader,
              prompt,
              body: fullBody,
            });

            const editSuccess = await streamMessage
              .edit({ content: prefixBody, components: [disabledButtons] })
              .then(() => true)
              .catch((err) => {
                console.error(
                  'Failed to edit stream message:',
                  err instanceof Error ? err.message : err,
                );
                return false;
              });

            const remaining = overflowChunks.length > 0
              ? overflowChunks
              : (editSuccess ? result.chunks.slice(1) : result.chunks);
            for (const chunk of remaining) {
              await safeSend(chunk);
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
            `❌ **Error**: ${errorMsg}`,
            [disabledButtons],
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
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          const edited = await updateStreamMessage(`❌ Connection error: ${error.message}`, []);
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
        const newContent = formatted || 'Processing...';

        if (newContent !== lastContent || tick % 2 === 0) {
          lastContent = newContent;
          await updateStreamMessage(
            `${spinnerChar} **Running...**\n${newContent}`,
            [buttons],
          );
        }
      } catch (error) {
        console.error('Error in stream update interval:', error instanceof Error ? error.message : error);
      }
    }, 1000);

    await updateStreamMessage('📝 Sending prompt...', [buttons]);
    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    promptSent = true;
    
  } catch (error) {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const edited = await updateStreamMessage(`❌ OpenCode execution failed: ${errorMessage}`, []);
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
