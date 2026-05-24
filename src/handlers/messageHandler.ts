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

function isImageAttachment(attachment: any): boolean {
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  return imageTypes.includes(attachment.contentType) || 
         attachment.name?.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i);
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
  
  // Detect image attachments
  const imageAttachments = message.attachments?.values 
    ? Array.from(message.attachments.values()).filter(isImageAttachment)
    : [];

  if (!prompt && !voiceAttachment && imageAttachments.length === 0) return;

  // Check busy BEFORE STT — queue attachment metadata if busy
  if (isBusy(threadId)) {
    if (voiceAttachment) {
      dataStore.addToQueue(threadId, {
        prompt: '',
        userId: message.author.id,
        timestamp: Date.now(),
        voiceAttachmentUrl: voiceAttachment.url,
        voiceAttachmentSize: voiceAttachment.size,
      });
    } else if (imageAttachments.length > 0) {
      dataStore.addToQueue(threadId, {
        prompt,
        userId: message.author.id,
        timestamp: Date.now(),
        imageAttachments: imageAttachments.map(img => ({
          url: img.url,
          name: img.name,
          size: img.size,
          contentType: img.contentType
        }))
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

  // Process image attachments
  if (imageAttachments.length > 0) {
    await safeReact(message, '🖼️');
    try {
      // Add image context to the prompt
      const imageInfo = imageAttachments.map(img => 
        `[Image: ${img.name} (${img.contentType}, ${(img.size / 1024).toFixed(1)}KB)]`
      ).join('\n');
      
      if (prompt) {
        prompt = `${prompt}\n\n${imageInfo}`;
      } else {
        prompt = imageInfo;
      }
      
      await safeRemoveReaction(message, '🖼️');
    } catch (error) {
      console.error('[Image Handler] Failed to process images:', error instanceof Error ? error.message : error);
      await safeReact(message, '❌');
      await message.reply({ content: '❌ Failed to process image attachments.' }).catch(() => {});
      return;
    }
  }

  await runPrompt(channel, threadId, prompt, parentChannelId);
}
