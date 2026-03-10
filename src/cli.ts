#!/usr/bin/env node
process.removeAllListeners('warning');
import { Command } from 'commander';
import pc from 'picocolors';
import { createRequire } from 'module';
import updateNotifier from 'update-notifier';
import { runSetupWizard } from './setup/wizard.js';
import { deployCommands } from './setup/deploy.js';
import { startBot } from './bot.js';
import { hasBotConfig, getConfigDir, getAllowedUserIds, addAllowedUserId, removeAllowedUserId, setAllowedUserIds, getOpenAIApiKey, setOpenAIApiKey, removeOpenAIApiKey } from './services/configStore.js';

const require = createRequire(import.meta.url);
// In dev mode (src/cli.ts), package.json is one level up
// In production (dist/src/cli.js), package.json is two levels up
const pkg = (() => {
  try {
    return require('../../package.json');
  } catch {
    return require('../package.json');
  }
})();

updateNotifier({ pkg }).notify({ isGlobal: true });

const program = new Command();

program
  .name('remote-opencode')
  .description('Discord bot for remote OpenCode CLI access')
  .version(pkg.version);

program
  .command('start')
  .description('Start the Discord bot')
  .action(async () => {
    if (!hasBotConfig()) {
      console.log(pc.yellow('No bot configuration found.'));
      console.log(`Run ${pc.cyan('remote-opencode setup')} first to configure your Discord bot.\n`);
      process.exit(1);
    }
    
    try {
      await deployCommands();
    } catch {
      console.log(pc.dim('Command deployment skipped (will retry on next start)'));
    }
    
    await startBot();
  });

program
  .command('setup')
  .description('Interactive setup wizard for Discord bot configuration')
  .action(async () => {
    await runSetupWizard();
  });

program
  .command('deploy')
  .description('Deploy slash commands to Discord')
  .action(async () => {
    if (!hasBotConfig()) {
      console.log(pc.yellow('No bot configuration found.'));
      console.log(`Run ${pc.cyan('remote-opencode setup')} first.\n`);
      process.exit(1);
    }
    
    await deployCommands();
  });

program
  .command('config')
  .description('Show configuration info')
  .action(() => {
    console.log(pc.bold('\nConfiguration:'));
    console.log(`  Config directory: ${pc.cyan(getConfigDir())}`);
    console.log(`  Bot configured: ${hasBotConfig() ? pc.green('Yes') : pc.red('No')}`);
    console.log();
  });

const allowCmd = program.command('allow').description('Manage the bot access allowlist');

allowCmd
  .command('add <userId>')
  .description('Add a user to the allowlist')
  .action((userId: string) => {
    if (!/^\d{17,20}$/.test(userId)) {
      console.log(pc.red('❌ Invalid user ID. Must be a Discord snowflake (17-20 digits).'));
      process.exit(1);
    }
    addAllowedUserId(userId);
    console.log(pc.green(`✅ User ${userId} added to allowlist.`));
  });

allowCmd
  .command('remove <userId>')
  .description('Remove a user from the allowlist')
  .action((userId: string) => {
    const result = removeAllowedUserId(userId);
    if (result) {
      console.log(pc.green(`✅ User ${userId} removed from allowlist.`));
    } else {
      const ids = getAllowedUserIds();
      if (ids.length <= 1) {
        console.log(pc.red('❌ Cannot remove the last allowed user. Use "allow reset" to disable restrictions.'));
      } else {
        console.log(pc.red(`❌ User ${userId} is not on the allowlist.`));
      }
    }
  });

allowCmd
  .command('list')
  .description('Show all allowed users')
  .action(() => {
    const ids = getAllowedUserIds();
    if (ids.length === 0) {
      console.log(pc.yellow('🔓 No restrictions — all server members can use this bot.'));
    } else {
      console.log(pc.bold(`🔒 Allowed Users (${ids.length}):`));
      ids.forEach(id => console.log(`  • ${id}`));
    }
  });

allowCmd
  .command('reset')
  .description('Clear the allowlist (unrestricted mode)')
  .action(() => {
    setAllowedUserIds([]);
    console.log(pc.green('✅ Allowlist cleared. All server members can now use the bot.'));
  });

const voiceCmd = program.command('voice').description('Manage voice transcription settings');

voiceCmd
  .command('set <apiKey>')
  .description('Set OpenAI API key for voice transcription')
  .action((apiKey: string) => {
    if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
      console.log(pc.red('❌ Invalid API key format. Must start with "sk-" and be at least 20 characters.'));
      process.exit(1);
    }
    setOpenAIApiKey(apiKey);
    console.log(pc.green('✅ OpenAI API key set. Voice transcription is now enabled.'));
  });

voiceCmd
  .command('remove')
  .description('Remove OpenAI API key')
  .action(() => {
    removeOpenAIApiKey();
    console.log(pc.green('✅ OpenAI API key removed. Voice transcription is now disabled.'));
  });

voiceCmd
  .command('status')
  .description('Show voice transcription status')
  .action(() => {
    const envKey = process.env.OPENAI_API_KEY;
    const configKey = getOpenAIApiKey();
    if (!configKey) {
      console.log(pc.yellow('🎙️ Voice Transcription: Disabled'));
      console.log('  No OpenAI API key configured.');
    } else {
      const source = envKey ? 'environment variable' : 'config file';
      const masked = configKey.slice(0, 3) + '...' + configKey.slice(-6);
      console.log(pc.green('🎙️ Voice Transcription: Enabled'));
      console.log(`  Source: ${source}`);
      console.log(`  API Key: ${masked}`);
    }
  });

program
  .action(async () => {
    if (!hasBotConfig()) {
      console.log(pc.bold('\nWelcome to remote-opencode!\n'));
      console.log('It looks like this is your first time running the bot.');
      console.log(`Run ${pc.cyan('remote-opencode setup')} to configure your Discord bot.\n`);
      console.log('Available commands:');
      console.log(`  ${pc.cyan('remote-opencode setup')}   - Interactive setup wizard`);
      console.log(`  ${pc.cyan('remote-opencode start')}   - Start the bot`);
      console.log(`  ${pc.cyan('remote-opencode deploy')}  - Deploy slash commands`);
      console.log(`  ${pc.cyan('remote-opencode config')}  - Show configuration`);
      console.log();
      process.exit(0);
    }
    
    await startBot();
  });

program.parse();
