# AGENTS.md — remote-opencode

## What This Repo Is

A Discord bot that bridges Discord threads to **OpenCode CLI** agents running in git worktrees. Users `/work` in a Discord channel → bot creates a git worktree, spawns an OpenCode serve instance, wires up SSE for streaming, and all messages in that thread become prompts to the agent.

**Upstream:** `bevibing/remote-opencode` (we contribute via forks → PRs to upstream)

## Contribution Workflow

### Setup

```bash
git clone git@github.com:YOUR_USERNAME/remote-opencode.git
cd remote-opencode
git remote add upstream git@github.com:bevibing/remote-opencode.git
npm install
```

### Branch + PR Flow

1. **Open an issue first** for features (bug fixes can skip this — see CONTRIBUTING.md)
2. **Branch from main** — `git checkout -b feature/your-name main`
3. **Make changes**, build: `npm run build` (runs `tsc`)
4. **Do NOT bump version** in `package.json` — maintainer handles releases
5. Push to fork, open PR against `bevibing/remote-opencode:main`

### Templates

- **PR template:** `.github/PULL_REQUEST_TEMPLATE.md` — summary, related issue, type, changes, testing checklist
- **Bug report:** `.github/ISSUE_TEMPLATE/bug_report.md` — title `[Bug]`, labels `bug`
- **Feature request:** `.github/ISSUE_TEMPLATE/feature_request.md` — title `[Feature]`, labels `enhancement`
- **Question:** `.github/ISSUE_TEMPLATE/question.md`

## Architecture Notes

### Key Pattern: Worktree + SSE (buttonHandler.ts)

When a PR is triggered from a thread, `handleWorktreePR`:
1. Spawns a fresh OpenCode serve on a dynamic port
2. Creates SSE client, registers callbacks (part updated, idle, error, connection error)
3. Sends the prompt async
4. On idle → disconnects SSE, posts accumulated result to the thread
5. On error → disconnects SSE, posts error to the thread
6. Always cleans up SSE client in outer catch block

### Discord 2000-Character Limit

**This is a hard constraint.** Any `channel.send({ content })` must stay under 2000 characters or it silently fails. Always compute:
```
maxContentLength = 2000 - prefix.length
```
Never hardcode `slice(0, 1990)` — prefix lengths vary.

Also: never use `.catch(() => {})` — at minimum `console.error` the failure so it's debuggable.

### Code Review with AI Agents

When using autonomous coding agents (OpenCode, Claude Code, etc.) for code review:
- **PASS DIFFS AS FILES**, not inline text. Inline diffs get parsed as CLI arguments, causing cryptic failures.
- Generate the diff file: `git diff main -- path/to/file > /tmp/review.patch`
- Run via: `opencode run "Review this diff for bugs, code quality, correctness." --file /tmp/review.patch --model "PROVIDER/MODEL"`
- DO NOT use `--prompt` (doesn't exist) or `--format` (exists but for output format, not review). Use the positional argument for instructions + `--file` for context.
- Run 3+ reviewers in parallel for best coverage (Codex, Gemini Pro, Opus recommended)

### Files to Know

| File | Purpose |
|---|---|
| `src/bot.ts` | Main entry, Discord.js client setup |
| `src/handlers/messageHandler.ts` | Routes thread messages to OpenCode |
| `src/handlers/buttonHandler.ts` | Interrupt, delete worktree, PR creation buttons |
| `src/services/serveManager.ts` | Spawns/manages OpenCode serve processes |
| `src/services/sessionManager.ts` | Session lifecycle, SSE client tracking, prompt sending |
| `src/services/worktreeManager.ts` | Git worktree create/remove/list/cleanup |
| `src/services/dataStore.ts` | JSON file persistence (worktree mappings, channel models) |
| `src/services/sseClient.ts` | EventSource wrapper for OpenCode SSE streaming |
| `src/services/executionService.ts` | Core prompt execution with streaming, queue, button management |
| `CONTRIBUTING.md` | Official contribution guide (read this before submitting) |

### Testing

```bash
npm test          # runs jest
npm run build     # tsc type-check (must pass)
```
