# Voice Message STT — Feature Specification

## 1. Overview

Automatically transcribe Discord Voice Messages (speech-to-text) and forward them to OpenCode as text prompts.
When a user sends a voice message via the 🎤 button in a thread with `/code` passthrough mode enabled,
it is transcribed and processed identically to a typed text message.

## 2. User Scenario

```
1. User enters a thread with /code passthrough mode enabled
2. Presses and holds the 🎤 button on Discord mobile/desktop to record a voice message
3. Recording completes → voice message is sent to the thread
4. Bot adds 🎙️ reaction to indicate transcription in progress
5. OpenAI Whisper API converts speech → text
6. Transcribed text is displayed as "📌 Prompt: {text}"
7. Forwarded to OpenCode via runPrompt() — same as typed messages
8. 🎙️ reaction is removed after transcription completes
```

## 3. Tech Stack

| Component | Choice | Rationale |
|---|---|---|
| **STT Service** | OpenAI Whisper API (`whisper-1`) | Best accuracy, native .ogg support, simple integration |
| **HTTP Client** | Node.js built-in `fetch` | Zero new dependencies |
| **Audio Format** | `audio/ogg; codecs=opus` | Discord Voice Message default format, directly supported by Whisper |

## 4. Architecture

### 4.1 Message Flow

```
Discord Voice Message (audio/ogg)
  ↓
messageHandler.ts — handleMessageCreate()
  ├── message.content exists? → existing text flow (unchanged)
  └── message.content empty + voice message detected?
        ↓
      Add 🎙️ reaction
        ↓
      voiceService.ts — transcribe(attachmentUrl)
        ├── fetch() to download .ogg from Discord CDN
        ├── Build FormData (file + model)
        └── POST https://api.openai.com/v1/audio/transcriptions
        ↓
      Return transcribed text
        ↓
      Remove 🎙️ reaction
        ↓
      runPrompt(channel, threadId, transcribedText, parentChannelId)
        ↓
      [existing flow unchanged]
```

### 4.2 Voice Message Detection

Discord.js v14 identifies voice messages via message flags:

```typescript
// Voice Messages have the IsVoiceMessage flag (1 << 13)
const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);
```

Voice Message characteristics:
- `message.content` is an empty string
- `message.attachments` contains one `audio/ogg; codecs=opus` file
- `message.flags` includes `IsVoiceMessage` (8192)
- File extension: `.ogg`
- Max size: Discord limit (~25MB), Whisper API limit is also 25MB

## 5. API Key Management

### 5.1 Resolution Order

1. Environment variable `OPENAI_API_KEY` (takes priority if set)
2. `~/.remote-opencode/config.json` field `openaiApiKey`

### 5.2 config.json Change

```json
{
  "discordToken": "...",
  "clientId": "...",
  "guildId": "...",
  "allowedUserIds": ["..."],
  "openaiApiKey": "sk-..."       // ← new optional field
}
```

### 5.3 Behavior When API Key Is Not Set

- Voice messages are silently ignored (same as current behavior — empty content returns early)
- No errors or warnings. The feature is gracefully disabled.

### 5.4 CLI Command: `remote-opencode voice`

Follows the existing `allow` subcommand pattern in `cli.ts` (using `commander`).

```
remote-opencode voice set <apiKey>    Set OpenAI API key for voice transcription
remote-opencode voice remove          Remove the stored OpenAI API key
remote-opencode voice status          Show current voice transcription configuration
```

#### `voice set <apiKey>`
- Validates key format (must start with `sk-` and be ≥ 20 chars)
- Stores in `config.json` via `configStore.setOpenAIApiKey()`
- Config file permissions remain `0o600`
- Output: `✅ OpenAI API key set. Voice transcription is now enabled.`

#### `voice remove`
- Removes `openaiApiKey` from `config.json`
- Output: `✅ OpenAI API key removed. Voice transcription is now disabled.`

#### `voice status`
- Shows whether voice transcription is enabled
- Masks the API key (e.g., `sk-...abc123`)
- Indicates source if enabled (config file vs environment variable)
- Output example:
  ```
  🎙️ Voice Transcription: Enabled
    Source: config file
    API Key: sk-...abc123
  ```

### 5.5 Discord Slash Command: `/voice`

Follows the existing `/model` command pattern (subcommands via `SlashCommandBuilder`).

```
/voice set key:<apiKey>     Set OpenAI API key for voice transcription
/voice remove               Remove the stored OpenAI API key
/voice status               Show current voice transcription status
```

#### `/voice set key:<apiKey>`
- Validates key format
- Stores via `configStore.setOpenAIApiKey()`
- Ephemeral reply (only visible to the user, since it contains a secret)
- Output: `✅ OpenAI API key set. Voice messages in /code threads will now be transcribed.`

#### `/voice remove`
- Removes API key from config
- Ephemeral reply
- Output: `✅ OpenAI API key removed. Voice transcription disabled.`

#### `/voice status`
- Shows whether voice transcription is active
- Masks the API key
- Ephemeral reply
- Output example:
  ```
  🎙️ Voice Transcription: Enabled
    Source: environment variable
  ```

### 5.6 Setup Wizard Integration

Add an optional step at the end of `setup/wizard.ts`:

```
Step 6 (optional):
  "Would you like to enable Voice Message transcription? (requires OpenAI API key)"
  → Yes → Prompt for OpenAI API Key → store via configStore.setOpenAIApiKey()
  → No  → Skip
```

## 6. File Changes

### 6.1 New Files

#### `src/services/voiceService.ts` (~50 lines)

```typescript
// Responsibility: Discord voice message attachment → text transcription

export async function transcribe(attachmentUrl: string): Promise<string>
// 1. fetch() to download audio binary from attachmentUrl
// 2. Build FormData:
//    - file: Blob (downloaded binary, type: 'audio/ogg')
//    - model: 'whisper-1'
//    - response_format: 'text'
// 3. POST https://api.openai.com/v1/audio/transcriptions
//    - Authorization: Bearer {apiKey}
// 4. Return response text

export function isVoiceEnabled(): boolean
// Check if OpenAI API key is configured (env var or config file)
```

#### `src/commands/voice.ts` (~70 lines)

```typescript
// Responsibility: /voice slash command (set, remove, status subcommands)
// Pattern: follows src/commands/model.ts structure

export const voice: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage voice message transcription settings')
    .addSubcommand(sub => sub.setName('set').setDescription('Set OpenAI API key')
      .addStringOption(opt => opt.setName('key').setDescription('OpenAI API key').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove OpenAI API key'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show voice transcription status')),

  async execute(interaction) { ... }
}
```

### 6.2 Modified Files

#### `src/handlers/messageHandler.ts` (+20 lines)

```diff
+ import { MessageFlags } from 'discord.js';
+ import { transcribe, isVoiceEnabled } from '../services/voiceService.js';

  export async function handleMessageCreate(message: Message): Promise<void> {
    // ... existing checks ...

-   const prompt = message.content.trim();
-   if (!prompt) return;
+   let prompt = message.content.trim();
+
+   if (!prompt) {
+     if (isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage)) {
+       const attachment = message.attachments.first();
+       if (!attachment) return;
+       await message.react('🎙️');
+       try {
+         prompt = await transcribe(attachment.url);
+         await message.reactions.cache.get('🎙️')?.users.remove(message.client.user!.id);
+       } catch {
+         await message.react('❌');
+         return;
+       }
+       if (!prompt.trim()) {
+         await message.react('❌');
+         return;
+       }
+     }
+     if (!prompt) return;
+   }

    // ... rest of existing flow (isBusy check, runPrompt) ...
  }
```

#### `src/services/configStore.ts` (+15 lines)

```diff
  export interface AppConfig {
    bot?: BotConfig;
    ports?: PortConfig;
    allowedUserIds?: string[];
+   openaiApiKey?: string;
  }

+ export function getOpenAIApiKey(): string | undefined {
+   return process.env.OPENAI_API_KEY || loadConfig().openaiApiKey;
+ }
+
+ export function setOpenAIApiKey(key: string): void {
+   const config = loadConfig();
+   config.openaiApiKey = key;
+   saveConfig(config);
+ }
+
+ export function removeOpenAIApiKey(): void {
+   const config = loadConfig();
+   delete config.openaiApiKey;
+   saveConfig(config);
+ }
```

#### `src/commands/index.ts` (+3 lines)

```diff
+ import { voice } from './voice.js';
  // ...
+ commands.set(voice.data.name, voice);
```

#### `src/cli.ts` (+25 lines)

```diff
+ const voiceCmd = program.command('voice').description('Manage voice transcription settings');
+
+ voiceCmd
+   .command('set <apiKey>')
+   .description('Set OpenAI API key for voice transcription')
+   .action((apiKey: string) => { ... });
+
+ voiceCmd
+   .command('remove')
+   .description('Remove OpenAI API key')
+   .action(() => { ... });
+
+ voiceCmd
+   .command('status')
+   .description('Show voice transcription status')
+   .action(() => { ... });
```

#### `src/setup/wizard.ts` (+15 lines)

```
Add optional Step 6:
  "Would you like to enable Voice Message transcription?"
  → Yes → Prompt for OpenAI API Key input
  → No  → Skip
```

## 7. Error Handling

| Scenario | Behavior |
|---|---|
| OpenAI API key not configured | Voice messages silently ignored |
| Network error (Discord CDN download) | ❌ reaction on the voice message |
| Whisper API auth failure (401) | ❌ reaction + ephemeral-style reply: "Transcription failed. Please check your API key." |
| Whisper API error (other) | ❌ reaction |
| Transcription result is empty | ❌ reaction |
| File size exceeds 25MB | ❌ reaction |
| Bot is busy (existing task running) | 📥 reaction → added to queue (same as text messages) |

## 8. UX Feedback

| Stage | Indicator |
|---|---|
| Transcription started | 🎙️ reaction added to voice message |
| Transcription complete | 🎙️ reaction removed → normal flow (📌 Prompt displayed) |
| Transcription failed | ❌ reaction on voice message |
| Bot busy | 📥 reaction (same queue behavior as text) |

## 9. Constraints & Limitations

- **Whisper API cost**: $0.006/min. Typical voice message (10-30s) costs $0.001-0.003
- **Language**: Whisper auto-detects language (no configuration needed; supports Korean, English, Japanese, etc.)
- **Latency**: ~1-2s transcription time for a 10-second voice message
- **Concurrency**: Sequential voice messages in one thread are handled by the existing queue system
- **Discord Voice Channels**: Not supported — only asynchronous Voice Messages (🎤 button), not live voice channels

## 10. Estimated Effort

| File | Action | Est. Lines |
|---|---|---|
| `src/services/voiceService.ts` | New | ~50 |
| `src/commands/voice.ts` | New | ~70 |
| `src/handlers/messageHandler.ts` | Modify | +20 |
| `src/services/configStore.ts` | Modify | +15 |
| `src/commands/index.ts` | Modify | +3 |
| `src/cli.ts` | Modify | +25 |
| `src/setup/wizard.ts` | Modify | +15 |
| **Total** | | **~200 lines** |

New dependencies: **0** (uses Node.js built-in `fetch` + `FormData`)

## 11. Test Plan

| Test Case | Description |
|---|---|
| Voice message detection | Verify `MessageFlags.IsVoiceMessage` flag is correctly detected |
| Whisper API call | Mock API returns expected transcription text |
| Error handling | API key missing, network error, empty response — each handled correctly |
| Queue integration | Voice message while busy → added to queue with 📥 reaction |
| Passthrough disabled | Voice message in non-`/code` thread is ignored |
| CLI `voice set` | API key stored in config.json, `voice status` reflects it |
| CLI `voice remove` | API key removed, `voice status` shows disabled |
| Discord `/voice set` | Ephemeral reply, key stored correctly |
| Discord `/voice status` | Shows masked key and source |
| Env var priority | `OPENAI_API_KEY` env var takes precedence over config file |
