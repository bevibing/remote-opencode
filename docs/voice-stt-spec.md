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
4. If bot is busy → 📥 reaction, voice attachment metadata queued (STT deferred)
5. If bot is idle → 🎙️ reaction added to indicate transcription in progress
6. OpenAI Whisper API converts speech → text
7. 🎙️ reaction removed after transcription completes
8. Transcribed text is displayed as "📌 Prompt: {text}"
9. Forwarded to OpenCode via runPrompt() — same as typed messages
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
  └── message.content empty + isVoiceEnabled() + IsVoiceMessage flag?
        ↓
      isBusy(threadId)?
        ├── YES → 📥 reaction, queue voice attachment metadata (STT deferred)
        └── NO ↓
      Add 🎙️ reaction
        ↓
      voiceService.ts — transcribe(attachmentUrl, fileSize)
        ├── Check fileSize against 25MB limit
        ├── fetchWithTimeout() to download .ogg from Discord CDN (30s timeout)
        ├── Build FormData (file + model)
        └── POST https://api.openai.com/v1/audio/transcriptions (60s timeout)
        ↓
      Return transcribed text
        ↓
      Remove 🎙️ reaction
        ↓
      runPrompt(channel, threadId, transcribedText, parentChannelId)
        ↓
      [existing flow unchanged]

Queued voice messages (dequeued by queueManager.ts):
  popFromQueue() → voiceAttachmentUrl present?
    ├── YES → transcribe(url, size) → runPrompt()
    └── NO  → normal text prompt flow
```

### 4.2 Voice Message Detection

Discord.js v14 identifies voice messages via message flags:

```typescript
// Voice Messages have the IsVoiceMessage flag (1 << 13)
// Detection also requires isVoiceEnabled() (API key configured)
const isVoiceMessage = !prompt && isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage);
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
Note: the `set` subcommand is **not** exposed via Discord slash command — API key setting is CLI-only to avoid accidental key exposure in Discord command history.

```
/voice remove               Remove the stored OpenAI API key
/voice status               Show current voice transcription status
```

#### `/voice remove`
- Removes API key from config
- Ephemeral reply
- Output: `✅ OpenAI API key removed. Voice transcription disabled.`

#### `/voice status`
- Shows whether voice transcription is active
- Masks the API key (first 3 + last 6 chars, e.g., `sk-...abc123`)
- Ephemeral reply
- If disabled, suggests CLI command or env var to enable
- Output example (enabled):
  ```
  🎙️ Voice Transcription: Enabled
    Source: environment variable
    API Key: sk-...abc123
  ```
- Output example (disabled):
  ```
  🎙️ Voice Transcription: Disabled
    No OpenAI API key configured.
    Use `remote-opencode voice set <key>` (CLI) or set `OPENAI_API_KEY` env var.
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

#### `src/services/voiceService.ts` (~70 lines)

```typescript
// Responsibility: Discord voice message attachment → text transcription

const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const DOWNLOAD_TIMEOUT_MS = 30_000;     // 30s for Discord CDN download
const WHISPER_TIMEOUT_MS = 60_000;       // 60s for Whisper API transcription

export function isVoiceEnabled(): boolean
// Check if OpenAI API key is configured (env var or config file)

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response>
// Wraps fetch() with AbortController-based timeout

export async function transcribe(attachmentUrl: string, fileSize?: number): Promise<string>
// 1. Check fileSize against MAX_FILE_SIZE (if provided)
// 2. fetchWithTimeout() to download audio binary from attachmentUrl (30s timeout)
// 3. Build FormData:
//    - file: Blob (downloaded binary, type: 'audio/ogg'), filename: 'voice.ogg'
//    - model: 'whisper-1'
//    - response_format: 'text'
// 4. POST https://api.openai.com/v1/audio/transcriptions (60s timeout)
//    - Authorization: Bearer {apiKey}
// 5. On 401: throw Error('AUTH_FAILURE')
// 6. Return response text (trimmed)
```

#### `src/commands/voice.ts` (~55 lines)

```typescript
// Responsibility: /voice slash command (remove, status subcommands)
// Pattern: follows src/commands/model.ts structure
// Note: 'set' subcommand intentionally omitted from Discord — CLI-only

export const voice: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage voice message transcription settings')
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove OpenAI API key'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show voice transcription status')),

  async execute(interaction) { ... }
}
```

### 6.2 Modified Files

#### `src/handlers/messageHandler.ts` (+70 lines)

Key changes from the original handler:
- Imports `transcribe`, `isVoiceEnabled` from voiceService
- Adds `safeReact()` and `safeRemoveReaction()` helpers (error-tolerant reaction handling)
- Detects voice messages via `isVoiceEnabled() && message.flags.has(MessageFlags.IsVoiceMessage)`
- Checks `isBusy()` **before** STT — queues voice attachment metadata if busy
- Queued voice messages include `voiceAttachmentUrl` and `voiceAttachmentSize`
- On auth failure: sends reply "❌ Transcription failed. Please check your API key with `/voice status`."
- On other errors: sends reply "❌ Voice transcription failed. Check server logs for details."

```diff
 import { MessageFlags } from 'discord.js';
 import { transcribe, isVoiceEnabled } from '../services/voiceService.js';

  // Helper functions for error-tolerant reactions
  async function safeReact(message, emoji) { ... }
  async function safeRemoveReaction(message, emoji) { ... }

  export async function handleMessageCreate(message: Message): Promise<void> {
    // ... existing checks ...

-   const prompt = message.content.trim();
-   if (!prompt) return;
   let prompt = message.content.trim();

   // Detect voice message before busy check
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
       dataStore.addToQueue(threadId, { prompt, userId, timestamp });
     }
     await safeReact(message, '📥');
     return;
   }

   // Perform STT only when not busy
   if (voiceAttachment) {
     await safeReact(message, '🎙️');
     try {
       prompt = await transcribe(voiceAttachment.url, voiceAttachment.size);
       await safeRemoveReaction(message, '🎙️');
     } catch (error) {
       await safeReact(message, '❌');
       if (error.message === 'AUTH_FAILURE') {
         await message.reply({ content: '❌ Transcription failed...' }).catch(() => {});
       } else {
         await message.reply({ content: '❌ Voice transcription failed...' }).catch(() => {});
       }
       return;
     }
     if (!prompt.trim()) {
       await safeReact(message, '❌');
       return;
     }
   }

    // ... rest of existing flow (runPrompt) ...
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

#### `src/cli.ts` (+40 lines)

```diff
 const voiceCmd = program.command('voice').description('Manage voice transcription settings');

 voiceCmd
   .command('set <apiKey>')
   .description('Set OpenAI API key for voice transcription')
   .action((apiKey: string) => { ... });

 voiceCmd
   .command('remove')
   .description('Remove OpenAI API key')
   .action(() => { ... });

 voiceCmd
   .command('status')
   .description('Show voice transcription status')
   .action(() => { ... });
```

#### `src/setup/wizard.ts` (+30 lines)

```
Add optional Step 6 (after saving bot config, before invite step):
  "Would you like to enable Voice Message transcription?"
  → Yes → Prompt for OpenAI API Key (password input) → validate format → store via setOpenAIApiKey()
  → No  → Skip
```

#### `src/types/index.ts` (+2 lines)

```diff
  export interface QueuedMessage {
    prompt: string;
    userId: string;
    timestamp: number;
   voiceAttachmentUrl?: string;
   voiceAttachmentSize?: number;
  }
```

#### `src/services/queueManager.ts` (+20 lines)

```diff
 import { transcribe } from './voiceService.js';

  // In processNextInQueue():
   // Handle queued voice messages — perform STT now that it's our turn
   if (!prompt && next.voiceAttachmentUrl) {
     try {
       prompt = await transcribe(next.voiceAttachmentUrl, next.voiceAttachmentSize);
       if (!prompt.trim()) { /* skip, process next */ }
     } catch (error) {
       /* skip, process next */
     }
   }
```

## 7. Error Handling

| Scenario | Behavior |
|---|---|
| OpenAI API key not configured | Voice messages silently ignored |
| Network error (Discord CDN download) | ❌ reaction + reply: "Voice transcription failed. Check server logs for details." |
| Whisper API auth failure (401) | ❌ reaction + reply: "Transcription failed. Please check your API key with `/voice status`." |
| Whisper API error (other) | ❌ reaction + reply: "Voice transcription failed. Check server logs for details." |
| Transcription result is empty | ❌ reaction |
| File size exceeds 25MB | Error thrown (❌ reaction + reply) |
| Bot is busy (existing task running) | 📥 reaction → voice attachment metadata queued (STT deferred to dequeue time) |
| Queued voice transcription fails | Silently skipped, next queue item processed |

## 8. UX Feedback

| Stage | Indicator |
|---|---|
| Transcription started | 🎙️ reaction added to voice message |
| Transcription complete | 🎙️ reaction removed → normal flow (📌 Prompt displayed) |
| Transcription failed | ❌ reaction + error reply on voice message |
| Bot busy | 📥 reaction → voice attachment metadata queued (STT deferred) |

## 9. Constraints & Limitations

- **Whisper API cost**: $0.006/min. Typical voice message (10-30s) costs $0.001-0.003
- **Language**: Whisper auto-detects language (no configuration needed; supports Korean, English, Japanese, etc.)
- **Latency**: ~1-2s transcription time for a 10-second voice message
- **Concurrency**: Sequential voice messages in one thread are handled by the existing queue system
- **Discord Voice Channels**: Not supported — only asynchronous Voice Messages (🎤 button), not live voice channels

## 10. Estimated Effort

| File | Action | Est. Lines |
|---|---|---|
| `src/services/voiceService.ts` | New | ~70 |
| `src/commands/voice.ts` | New | ~55 |
| `src/handlers/messageHandler.ts` | Modify | +70 |
| `src/services/configStore.ts` | Modify | +15 |
| `src/commands/index.ts` | Modify | +3 |
| `src/cli.ts` | Modify | +40 |
| `src/setup/wizard.ts` | Modify | +30 |
| `src/types/index.ts` | Modify | +2 |
| `src/services/queueManager.ts` | Modify | +20 |
| **Total** | | **~305 lines** |

New dependencies: **0** (uses Node.js built-in `fetch` + `FormData`)

## 11. Test Plan

| Test Case | Description |
|---|---|
| Voice message detection | Verify `isVoiceEnabled() && MessageFlags.IsVoiceMessage` flag is correctly detected |
| Whisper API call | Mock API returns expected transcription text |
| Error handling | API key missing, network error, empty response, auth failure — each handled with correct reaction + reply |
| Queue integration | Voice message while busy → attachment metadata queued with 📥 reaction, STT deferred to dequeue |
| Queued voice dequeue | `queueManager.ts` performs STT on dequeued voice items, skips on failure |
| Passthrough disabled | Voice message in non-`/code` thread is ignored |
| CLI `voice set` | API key stored in config.json, `voice status` reflects it |
| CLI `voice remove` | API key removed, `voice status` shows disabled |
| Discord `/voice status` | Shows masked key and source (ephemeral reply) |
| Discord `/voice remove` | Removes key (ephemeral reply) |
| Env var priority | `OPENAI_API_KEY` env var takes precedence over config file |
| File size validation | Files > 25MB are rejected before download |
| Timeout handling | Download (30s) and API (60s) timeouts are enforced |
