import * as p from '@clack/prompts';
import pc from 'picocolors';
import open from 'open';
import { setBotConfig, getBotConfig, hasBotConfig, addAllowedUserId, setOpenAIApiKey } from '../services/configStore.js';
import { deployCommands } from './deploy.js';

const DISCORD_DEV_URL = 'https://discord.com/developers/applications';
const BOT_PERMISSIONS = '2147534848';
const BOT_SCOPES = 'bot applications.commands';

function validateApplicationId(value: string): string | undefined {
  if (!value) return 'Application ID is required';
  if (!/^\d{17,20}$/.test(value)) return 'Invalid format (should be 17-20 digits)';
  return undefined;
}

function validateToken(value: string): string | undefined {
  if (!value) return 'Bot token is required';
  if (value.length < 50) return 'Invalid token format (too short)';
  return undefined;
}

function validateGuildId(value: string): string | undefined {
  if (!value) return 'Guild ID is required';
  if (!/^\d{17,20}$/.test(value)) return 'Invalid format (should be 17-20 digits)';
  return undefined;
}

function validateUserId(value: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{17,20}$/.test(value)) return 'Invalid format (should be 17-20 digits)';
  return undefined;
}

function generateInviteUrl(clientId: string): string {
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('permissions', BOT_PERMISSIONS);
  url.searchParams.set('scope', BOT_SCOPES);
  return url.toString();
}

async function openUrl(url: string): Promise<void> {
  try {
    await open(url);
  } catch {
    // Silently fail - URL is displayed to user anyway
  }
}

export async function runSetupWizard(): Promise<void> {
  console.clear();
  
  p.intro(pc.bgCyan(pc.black(' remote-opencode setup ')));
  
  if (hasBotConfig()) {
    const existing = getBotConfig()!;
    const overwrite = await p.confirm({
      message: `Bot already configured (Client ID: ${existing.clientId}). Reconfigure?`,
      initialValue: false,
    });
    
    if (p.isCancel(overwrite) || !overwrite) {
      p.outro('Setup cancelled.');
      return;
    }
  }
  
  // Step 1: Open Discord Developer Portal
  p.note(
    `We'll open the Discord Developer Portal in your browser.\n\n` +
    `1. Click ${pc.bold('"New Application"')}\n` +
    `2. Give your application a name (e.g., "Remote OpenCode")\n` +
    `3. Copy the ${pc.bold('Application ID')} from "General Information"`,
    'Step 1: Create Discord Application'
  );
  
  const openPortal = await p.text({
    message: `Press ${pc.cyan('Enter')} to open Discord Developer Portal...`,
    placeholder: 'Press Enter',
    defaultValue: '',
  });
  
  if (p.isCancel(openPortal)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  await openUrl(DISCORD_DEV_URL);
  
  const clientId = await p.text({
    message: 'Enter your Discord Application ID:',
    placeholder: 'e.g., 1234567890123456789',
    validate: validateApplicationId,
  });
  
  if (p.isCancel(clientId)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  // Step 2: Enable Intents (guidance only)
  p.note(
    `In the Discord Developer Portal:\n\n` +
    `1. Go to the ${pc.bold('"Bot"')} section in the left sidebar\n` +
    `2. Scroll down to ${pc.bold('"Privileged Gateway Intents"')}\n` +
    `3. Enable these intents:\n` +
    `   ${pc.green('*')} SERVER MEMBERS INTENT\n` +
    `   ${pc.green('*')} MESSAGE CONTENT INTENT\n` +
    `4. Click ${pc.bold('"Save Changes"')}`,
    'Step 2: Enable Required Intents'
  );
  
  const intentsConfirm = await p.confirm({
    message: 'Have you enabled the required intents?',
    initialValue: true,
  });
  
  if (p.isCancel(intentsConfirm)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  // Step 3: Get Bot Token (guidance only)
  p.note(
    `Still in the Discord Developer Portal:\n\n` +
    `1. In the ${pc.bold('"Bot"')} section\n` +
    `2. Click ${pc.bold('"Reset Token"')} (or "View Token" if available)\n` +
    `3. Copy the token ${pc.dim('(it\'s only shown once!)')}`,
    'Step 3: Get Bot Token'
  );
  
  const discordToken = await p.password({
    message: 'Enter your Discord Bot Token:',
    validate: validateToken,
  });
  
  if (p.isCancel(discordToken)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  // Step 4: Get Guild ID (guidance only)
  p.note(
    `1. Open Discord and go to ${pc.bold('User Settings > Advanced')}\n` +
    `2. Enable ${pc.bold('"Developer Mode"')}\n` +
    `3. Right-click on your server name\n` +
    `4. Click ${pc.bold('"Copy Server ID"')}`,
    'Step 4: Get Guild (Server) ID'
  );
  
  const guildId = await p.text({
    message: 'Enter your Discord Guild (Server) ID:',
    placeholder: 'e.g., 1234567890123456789',
    validate: validateGuildId,
  });
  
  if (p.isCancel(guildId)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  // Step 5: Set Bot Owner
  p.note(
    `Restrict who can use this bot by setting an owner.\n\n` +
    `1. In Discord, right-click ${pc.bold('YOUR profile')}\n` +
    `2. Click ${pc.bold('"Copy User ID"')}\n\n` +
    `${pc.dim('(Requires Developer Mode — same setting as Step 4)')}\n` +
    `${pc.dim('Leave blank to allow everyone)')}`,
    'Step 5: Set Bot Owner (Optional)'
  );
  
  const ownerId = await p.text({
    message: 'Enter your Discord User ID (leave blank to allow everyone):',
    placeholder: 'e.g., 1234567890123456789',
    defaultValue: '',
    validate: validateUserId,
  });
  
  if (p.isCancel(ownerId)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  // Save configuration
  const s = p.spinner();
  s.start('Saving configuration...');
  
  setBotConfig({
    discordToken: discordToken as string,
    clientId: clientId as string,
    guildId: guildId as string,
  });
  
  s.stop('Configuration saved!');
  
  if (ownerId && (ownerId as string).length > 0) {
    addAllowedUserId(ownerId as string);
  }

  // Step 6 (optional): Voice Message Transcription
  const enableVoice = await p.confirm({
    message: 'Would you like to enable Voice Message transcription? (requires OpenAI API key)',
    initialValue: false,
  });

  if (p.isCancel(enableVoice)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  if (enableVoice) {
    const openaiKey = await p.password({
      message: 'Enter your OpenAI API key:',
      validate: (value) => {
        if (!value) return 'API key is required';
        if (!value.startsWith('sk-') || value.length < 20) return 'Invalid API key format (must start with sk- and be at least 20 characters)';
        return undefined;
      },
    });

    if (p.isCancel(openaiKey)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    setOpenAIApiKey(openaiKey as string);
    p.log.success('OpenAI API key saved. Voice transcription enabled!');
  }
  
  // Step 6: Invite Bot to Server
  const inviteUrl = generateInviteUrl(clientId as string);
  
  p.note(
    `We'll open the bot invite page in your browser.\n\n` +
    `1. Select your server\n` +
    `2. Click ${pc.bold('"Authorize"')}\n\n` +
    `${pc.dim('URL: ' + inviteUrl)}`,
    'Step 6: Invite Bot to Server'
  );
  
  const openInvite = await p.text({
    message: `Press ${pc.cyan('Enter')} to open the invite page...`,
    placeholder: 'Press Enter',
    defaultValue: '',
  });
  
  if (p.isCancel(openInvite)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  await openUrl(inviteUrl);
  
  const invited = await p.confirm({
    message: 'Have you invited the bot to your server?',
    initialValue: true,
  });
  
  if (p.isCancel(invited)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  
  // Step 7: Deploy Commands
  const shouldDeploy = await p.confirm({
    message: 'Deploy slash commands now?',
    initialValue: true,
  });
  
  if (!p.isCancel(shouldDeploy) && shouldDeploy) {
    s.start('Deploying slash commands...');
    try {
      await deployCommands();
      s.stop('Slash commands deployed!');
    } catch (error) {
      s.stop('Failed to deploy commands');
      console.error(pc.red(`Error: ${error instanceof Error ? error.message : error}`));
    }
  }
  
  p.outro(pc.green('Setup complete! Run "remote-opencode start" to start the bot.'));
}
