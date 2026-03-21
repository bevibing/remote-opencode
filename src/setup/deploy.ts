import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../services/configStore.js';
import { commands } from '../commands/index.js';
import { initializeProxySupport } from '../services/proxySupport.js';
import pc from 'picocolors';

export async function deployCommands(): Promise<void> {
  const config = getBotConfig();
  
  if (!config) {
    throw new Error('Bot configuration not found. Run setup first.');
  }
  
  const commandsData = Array.from(commands.values()).map(c => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  
  initializeProxySupport();
  console.log(pc.dim(`Deploying ${commandsData.length} commands...`));
  
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commandsData }
  );
  
  console.log(pc.green(`Successfully deployed ${commandsData.length} slash commands.`));
}
