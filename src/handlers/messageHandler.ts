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

  if (!prompt) {
    if (isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage)) {
      const attachment = message.attachments.first();
      if (!attachment) return;
      await message.react('🎙️');
      try {
        prompt = await transcribe(attachment.url, attachment.size);
        await message.reactions.cache.get('🎙️')?.users.remove(message.client.user!.id);
      } catch (error) {
        console.error('[Voice STT] Transcription failed:', error instanceof Error ? error.message : error);
        await message.react('❌');
        if (error instanceof Error && error.message === 'AUTH_FAILURE') {
          await message.reply({ content: '❌ Transcription failed. Please check your API key with `/voice status`.' });
        } else {
          const detail = error instanceof Error ? error.message : 'Unknown error';
          await message.reply({ content: `❌ Voice transcription failed: ${detail}` });
        }
        return;
      }
      if (!prompt.trim()) {
        await message.react('❌');
        return;
      }
    }
    if (!prompt) return;
  }

  if (isBusy(threadId)) {
    dataStore.addToQueue(threadId, {
      prompt,
      userId: message.author.id,
      timestamp: Date.now()
    });
    await message.react('📥');
    return;
  }

  await runPrompt(channel, threadId, prompt, parentChannelId);
}
