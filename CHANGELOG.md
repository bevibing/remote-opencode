# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-03-10

### Added
- **Voice Message Transcription (STT)**: Automatically transcribe Discord voice messages to text using OpenAI Whisper API.
  - Send voice messages in `/code` passthrough threads — they are transcribed and processed identically to typed text.
  - 🎙️ reaction indicates transcription in progress; removed on completion.
  - Voice messages sent while the bot is busy are queued with attachment metadata — STT is deferred until the queue processes them.
  - **CLI commands**: `remote-opencode voice set <apiKey>`, `voice remove`, `voice status` for managing the OpenAI API key.
  - **Discord `/voice` command**: `remove` and `status` subcommands (API key setting is CLI-only for security).
  - **Setup wizard integration**: Optional step to configure OpenAI API key during `remote-opencode setup`.
  - **API key resolution**: `OPENAI_API_KEY` environment variable takes priority over `config.json`.
  - Graceful degradation — voice messages are silently ignored when no API key is configured.
  - Timeout protection: 30s for Discord CDN download, 60s for Whisper API transcription.
  - File size validation: rejects files exceeding Whisper's 25MB limit before download.

### Changed
- **Queue system**: `QueuedMessage` interface extended with `voiceAttachmentUrl` and `voiceAttachmentSize` fields to support deferred voice transcription.
- **Message handler**: Refactored to check busy state before STT, with error-tolerant reaction helpers (`safeReact`, `safeRemoveReaction`).
## [1.3.0] - 2026-03-02

### Added
- **`/diff` Command**: View git diffs directly from Discord — ideal for reviewing AI-made changes on mobile.
  - `target` option: `unstaged` (default), `staged`, or `branch`
  - `stat` option: show `--stat` summary only instead of full diff
  - `base` option: specify base branch for `target:branch` diffs (default: `main`)
  - Inside a worktree thread → diffs the worktree path for that branch
  - In a regular channel → diffs the channel-bound project path
  - Output formatted in a `diff` code block; automatically truncated at Discord's 2000-char limit

## [1.2.0] - 2026-02-15

### Added
- **Access Control (Allowlist)**: Restrict bot usage to specific Discord users via a user ID allowlist.
  - **Setup wizard** (Step 5): Optionally set a bot owner during initial setup.
  - **CLI commands**: `remote-opencode allow add <userId>`, `remove <userId>`, `list`, and `reset` for managing the allowlist from the terminal.
  - **Discord `/allow` command**: Authorized users can manage the allowlist directly from Discord (`/allow add`, `/allow remove`, `/allow list`) — only available when at least one user is already on the allowlist.
  - **Auth guards**: All Discord interactions (slash commands, buttons, passthrough messages) are checked against the allowlist.
  - Unauthorized users receive an ephemeral "not authorized" message; passthrough messages are silently ignored.
  - Empty allowlist = unrestricted mode (backward compatible — all server members can use the bot).
  - Cannot remove the last allowed user via Discord (prevents lockout).

### Security
- Initial allowlist setup **must** be done via the CLI (`remote-opencode allow add`) or the setup wizard (`remote-opencode setup`). The Discord `/allow` command is intentionally disabled when the allowlist is empty to prevent unauthorized users from bootstrapping access.
- Config directory (`~/.remote-opencode/`) is created with `0700` permissions (owner-only access).
- Config file (`config.json`) is written with `0600` permissions (owner read/write only).
- CLI `allow add` validates Discord snowflake format (17-20 digits).

## [1.1.1] - 2026-02-11

### Added
- **Context Header**: All execution messages now display the current branch name and AI model at the top (e.g. `🌿 feature/dark-mode · 🤖 claude-sonnet-4-20250514`).
- `getCurrentBranch()` utility in `worktreeManager` to resolve the active git branch via `git rev-parse --abbrev-ref HEAD`.
- `buildContextHeader()` formatter in `messageFormatter` for consistent header rendering.

### Changed
- Replaced inline `(Model: ...)` suffix with a dedicated context header line across all 7 message states (Starting, Waiting, Sending, Running, Done, Error-SSE, Error-catch).

## [1.1.0] - 2026-02-05

### Added
- **Automated Message Queuing**: Added a new system to queue multiple prompts in a thread. If the bot is busy, new messages are automatically queued and processed sequentially.
- **Fresh Context Mode**: Each queued job can optionally start with a fresh AI conversation context (new session) while maintaining the same code state.
- **Queue Management**: New `/queue` slash command suite to list, clear, pause, resume, and configure queue settings.
- **Queue Settings**:
  - `continue_on_failure`: Toggle whether the queue stops or continues when a job encounters an error.
  - `fresh_context`: Toggle between persistent conversation memory and fresh starts per job.
- **Visual Feedback**: The bot now reacts with `📥` when a message is successfully queued via chat.

### Changed
- **Refactored Execution Logic**: Moved core prompt execution to a dedicated `executionService` for better reliability and code reuse.
- **Hardened Server Binding**: Reverted `opencode serve` to use default `127.0.0.1` binding (previously `0.0.0.0`) and updated port availability checks to match, preventing local network exposure.

## [1.0.11] - 2026-02-04

### Added
- Model confirmation in Discord messages: The bot now displays which model is being used when starting a session.
- Real-time logging: Added always-on logging for `opencode serve` startup commands, working directories, and process output (stdout/stderr) for easier debugging.

### Fixed
- Fixed `opencode serve` startup failures: The bot now correctly detects when the server fails to start immediately and reports the actual error message to Discord instead of timing out after 30 seconds.
- Resolved `--model` flag error: Moved model selection from the `opencode serve` command (where it was unsupported) to the prompt API.
- Fixed Model API format: Correctly formatted model identifiers as objects (`{ providerID, modelID }`) as required by the OpenCode API.
- Improved Port Management: Fixed port availability checks to bind to `0.0.0.0` (matching the server) and added checks for orphaned servers to prevent "Address already in use" errors.
- Fixed button handlers (Interrupt, Create PR) to correctly respect channel model preferences.
- Fixed instance key logic to include the model, allowing multiple models to be used for the same project in different channels.

## [1.0.10] - 2026-02-04

### Added
- New `/setports` slash command to configure the port range for OpenCode server instances.

### Fixed
- Fixed Windows-specific spawning issue where the bot failed to find the `opencode` command (now targeting `opencode.cmd`).
- Resolved `spawn EINVAL` errors on Windows by correctly configuring shell execution.
- Fixed a crash where the bot would attempt to pass an unsupported `--model` flag to `opencode serve`.
- Improved server reliability by extending the ready-check timeout to 30 seconds.
- Suppressed `DEP0190` security warnings in the terminal caused by Windows-specific shell execution requirements.
- Standardized internal communication to use `127.0.0.1` and added real-time process logging (available via `DEBUG` env var).

## [1.0.9] - 2026-02-04

### Added
- New `/model` slash command to list and set AI models per channel.
- Support for `--model` flag in OpenCode server instances.
- Persistent storage for channel-specific model preferences.

### Fixed
- Fixed a connection timeout issue where the bot failed to connect to the internal `opencode serve` process.
- Added `--hostname 0.0.0.0` to the `opencode serve` command to ensure the service is reachable.
- Standardized internal communication to use `127.0.0.1` instead of `localhost` to avoid IPv6 resolution conflicts on some systems.
- Improved process exit handling in `serveManager` to ensure cleaner state management.
- Fixed `DiscordAPIError[40060]` (Interaction already acknowledged) by adding safety checks and better error handling in `interactionHandler.ts`.
- Resolved a `TypeError` in `opencode.ts` by adding safety checks for stream message updates.
- Updated all interaction responses to use `MessageFlags.Ephemeral` instead of the deprecated `ephemeral` property to resolve terminal warnings.
