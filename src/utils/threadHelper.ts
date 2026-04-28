import { ChatInputCommandInteraction, ThreadAutoArchiveDuration, TextChannel, ThreadChannel } from 'discord.js';
import * as dataStore from '../services/dataStore.js';

export async function getOrCreateThread(
  interaction: ChatInputCommandInteraction,
  prompt: string
): Promise<ThreadChannel> {
  const channel = interaction.channel;

  if (channel?.isThread()) {
    return channel;
  }

  if (channel && 'threads' in channel) {
    const threadName = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');
    const thread = await (channel as TextChannel).threads.create({
      name: `🤖 ${threadName}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'OpenCode session'
    });

    const alias = dataStore.getChannelBinding(interaction.channelId);
    if (alias && dataStore.getProjectAutoPassthrough(alias)) {
      dataStore.setPassthroughMode(thread.id, true, interaction.user.id);
    }

    return thread;
  }

  throw new Error('Cannot create thread in this channel.');
}
