import { 
  Message, 
  MessageFlags,
  ThreadChannel
} from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import { runPrompt } from '../services/executionService.js';
import { isBusy } from '../services/queueManager.js';
import { isAuthorized } from '../services/configStore.js';
import { transcribe, isVoiceEnabled } from '../services/voiceService.js';

async function safeReact(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch (error) {
    console.error(`[Voice STT] Failed to react with ${emoji}:`, error instanceof Error ? error.message : error);
  }
}

async function safeRemoveReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.reactions.cache.get(emoji)?.users.remove(message.client.user!.id);
  } catch (error) {
    console.error(`[Voice STT] Failed to remove reaction ${emoji}:`, error instanceof Error ? error.message : error);
  }
}

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (message.system) return;
  
  const channel = message.channel;
  if (!channel.isThread()) return;
  
  const threadId = channel.id;
  
  if (!dataStore.isPassthroughEnabled(threadId)) return;
  
  if (!isAuthorized(message.author.id)) return;
  
  const parentChannelId = (channel as ThreadChannel).parentId;
  if (!parentChannelId) return;
  
  let prompt = message.content.trim();

  // Detect voice message before busy check so we can queue attachment metadata
  const isVoiceMessage = !prompt && isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage);
  const voiceAttachment = isVoiceMessage ? message.attachments.first() : undefined;

  if (!prompt && !voiceAttachment) return;

  // Check busy BEFORE STT — queue voice attachment metadata if busy
  if (isBusy(threadId)) {
    if (voiceAttachment) {
      dataStore.addToQueue(threadId, {
        prompt: '',
        userId: message.author.id,
        timestamp: Date.now(),
        voiceAttachmentUrl: voiceAttachment.url,
        voiceAttachmentSize: voiceAttachment.size,
      });
    } else {
      dataStore.addToQueue(threadId, {
        prompt,
        userId: message.author.id,
        timestamp: Date.now()
      });
    }
    await safeReact(message, '📥');
    return;
  }

  // Perform STT only when not busy (our turn to execute)
  if (voiceAttachment) {
    await safeReact(message, '🎙️');
    try {
      prompt = await transcribe(voiceAttachment.url, voiceAttachment.size);
      await safeRemoveReaction(message, '🎙️');
    } catch (error) {
      console.error('[Voice STT] Transcription failed:', error instanceof Error ? error.message : error);
      await safeReact(message, '❌');
      if (error instanceof Error && error.message === 'AUTH_FAILURE') {
        await message.reply({ content: '❌ Transcription failed. Please check your API key with `/voice status`.' }).catch(() => {});
      } else {
        await message.reply({ content: '❌ Voice transcription failed. Check server logs for details.' }).catch(() => {});
      }
      return;
    }
    if (!prompt.trim()) {
      await safeReact(message, '❌');
      return;
    }
  }

  await runPrompt(channel, threadId, prompt, parentChannelId);
}
