# Nemesis

<p align="center"><img src="nms_logo.svg" alt="Nemesis" width="360"></p>

Terminal coding agent. The model calls tools (read, edit, search, shell, MCP, sub-agents) in a loop until the task is done. Zero runtime dependencies, Node 20+.

## Quick start

### Install

Requires Node 20+ and git.

```sh
npm install -g github:ashdenlilley/Nemesis   # installs from GitHub, no clone needed
nemesis                                      # first run: provider, model, key, then PATH check
```

Do not use `npm install -g nemesis`. The npm registry has an unrelated package with that name.

The first run asks whether to add the npm global bin directory to PATH (Windows: User PATH; POSIX: an `export` line in `~/.zshrc` or `~/.bashrc`). Open a new terminal afterwards.

Re-run key and PATH setup at any time with `nemesis --setup`.

From a local clone, use `npm link` instead of the GitHub install, or run `node bin/nemesis.js`.

```sh
npm test
```

First run without a key shows a short tutorial, then asks:

1. Provider: Anthropic, or OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio, vLLM, ...)
2. Base URL (OpenAI-compatible only), model
3. API key (input hidden)

The key is written to `~/.nemesis/.env` and loaded on every later run. The provider and model are written to `~/.nemesis/config.json`. The next run uses them unless you pass `--provider`, `--model`, or `NEMESIS_*` env vars. `/login` changes them later; `/logout` removes the key.

## Slash commands

Type `/help` for the live list. Custom commands come from `.nemesis/commands/*.md` (project) or `~/.nemesis/commands/*.md` (user). `$ARGUMENTS` in the body is replaced with the typed text.

| Command | What it does |
|---|---|
| `/help` | list commands |
| `/clear` (`/reset`, `/new`) | new session |
| `/compact [focus]` | summarize older turns now |
| `/context` | estimated context usage |
| `/cost` (`/usage`) | token totals for this run |
| `/config` | effective configuration (key masked) |
| `/doctor` | node, git, key, sessions dir, MCP checks |
| `/status` | version, model, session, roots, plan mode, hooks |
| `/model [name]` | show or set model; remembered per provider |
| `/login` | change provider, model, or key |
| `/logout` | remove the saved key |
| `/output-style [default\|concise\|explanatory]` | response style |
| `/permissions allow\|deny\|ask <tool>` | per-tool rules; `/permissions reset` |
| `/plan` | toggle read-only plan mode |
| `/add-dir <path>` | let file tools reach another directory |
| `/init` | agent writes `NEMESIS.md` for this repo |
| `/memory [add <note>]` | show or append to `NEMESIS.md` |
| `/review [focus]` | review uncommitted changes |
| `/pr_comments [n]` | fetch and address PR review comments (needs `gh`) |
| `/agents` | list sub-agents |
| `/mcp` | MCP server status and tools |
| `/hooks` | configured hooks |
| `/resume [id]` | list sessions, or switch to one |
| `/export [file]` | export transcript to Markdown |
| `/todos` | last task list written by the agent |
| `/bug` (`/feedback`) | bug report hint |
| `/release-notes`, `/version` | version info |
| `/exit` (`/quit`) | quit |

Stubs that print a message: `/ide`, `/install-github-app`, `/terminal-setup`, `/upgrade`, `/vim`. These depend on Claude Code's own UI and are not implemented.

## Streaming

Text prints as it arrives (Anthropic SSE and OpenAI-compatible SSE, including streamed tool-call arguments). `--no-stream` or `"stream": false` waits for complete responses.

## Context compaction

Before each model call, Nemesis estimates prompt size (about 4 characters per token). Past `compactThreshold` (default 0.8) of `contextWindow`, it summarizes everything before the last few user turns and replaces those turns with the summary. The cut only lands on plain user-text messages, so tool calls and results are never split. The original transcript is kept as `<session>.jsonl.bak-<timestamp>`.

## Sub-agents

The `task` tool runs a sub-agent with its own message history, a tool subset, and a step budget. Only its final report returns to the parent, so large searches do not fill the main context.

Built-ins:
- `general`: all tools, 30 steps
- `explore`: `read_file`, `glob`, `grep` only

Custom agents are markdown files in `.nemesis/agents/` or `~/.nemesis/agents/`:

```markdown
---
name: reviewer
description: Reviews diffs for bugs
tools: read_file, glob, grep
model: claude-haiku-5-5
maxSteps: 15
---
You review code changes. Report file:line for each finding.
```

Sub-agents cannot spawn sub-agents. Their tool calls still go through the permission prompt.

## Hooks

Configured under `hooks` in `.nemesis/config.json`, same shape as Claude Code:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "edit_file|write_file", "hooks": [ { "type": "command", "command": "node scripts/no-edit-main.js" } ] }
    ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "npm test --silent" } ] } ]
  }
}
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`.

- The command reads the event as JSON on stdin.
- Exit 2 blocks. Stderr becomes the reason shown to the model.
- Exit 0 with `{"decision":"block","reason":"..."}` also blocks.
- Plain stdout from `SessionStart` or `UserPromptSubmit` is added as context.
- A blocked `Stop` feeds its reason back to the model, and the turn continues.
- Hooks run with your user privileges. Only add commands you trust. On Windows they run in PowerShell.

## MCP

Configured under `mcpServers`. Servers start at launch over stdio (newline-delimited JSON-RPC):

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "local": { "command": "C:\\tools\\my-server.exe", "env": { "TOKEN": "..." }, "risk": "read" }
  }
}
```

MCP tools appear as `mcp__<server>__<tool>`. Default risk is `exec`, so they prompt unless you allow them. A failing server is reported and skipped. Restart Nemesis after changing `mcpServers`.

## Architecture

```
bin/nemesis.js         entry point
src/cli.js             args, startup, REPL, one-shot, shared runtime state
src/onboarding.js      first-run tutorial and key setup
src/env.js             ~/.nemesis/.env read/write
src/config.js          layered config and per-provider profiles
src/agent.js           turn loop: model -> tool_use -> tool_result -> model
src/compact.js         context estimate and compaction
src/hooks.js           event hooks (command, stdin JSON, exit-code protocol)
src/subagents.js       sub-agent definitions, runner, task tool
src/mcp/               stdio MCP client and tool bridge
src/commands/          slash command registry, built-ins, custom markdown commands
src/providers/         anthropic + openai adapters, SSE reader, retry
src/tools/             read_file, write_file, edit_file, glob, grep, bash, todo_write
src/permissions.js     allow | ask | deny per risk, plus per-tool rules
src/session.js         JSONL transcripts in .nemesis/sessions/
src/usage.js           token accounting
src/prompt.js          system prompt, output style, NEMESIS.md / AGENTS.md / CLAUDE.md
src/ui.js              terminal rendering (honors NO_COLOR)
```

### Message model

Internal messages use Anthropic-style blocks (`text`, `tool_use`, `tool_result`). Provider adapters translate to and from the wire format. A provider implements `createMessage({ system, messages, tools, signal, onText, model, maxTokens }) -> { content, stopReason, usage }`.

### Safety

- Every tool call passes the permission gate. Defaults: reads allowed; writes, shell, and MCP tools ask.
- `-p` mode and non-TTY runs deny prompted tools unless `-y` is passed.
- Interrupted turns get synthetic `tool_result` entries, so the transcript stays valid.
- File tools stay inside the workspace roots (`cwd` plus `--add-dir` / `/add-dir`).
- `maxSteps` caps tool rounds per turn.
- API keys are stored in plain text in `~/.nemesis/.env`. On Windows the file gets no restricted ACL, so protect your user profile accordingly.

## Config reference

Precedence, lowest to highest: defaults, `~/.nemesis/config.json`, `.nemesis/config.json`, `.nemesis/config.local.json` (git-ignored), env vars, CLI flags.

```json
{
  "provider": "openai",
  "profiles": { "openai": { "model": "llama3", "baseUrl": "http://localhost:11434/v1" } },
  "maxSteps": 40,
  "stream": true,
  "autoCompact": true,
  "compactThreshold": 0.8,
  "outputStyle": "default",
  "permissions": { "read": "allow", "write": "ask", "exec": "ask" },
  "mcpServers": {},
  "hooks": {}
}
```

Env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NEMESIS_API_KEY` (overrides the provider key), `NEMESIS_PROVIDER`, `NEMESIS_MODEL`, `NEMESIS_BASE_URL`.

Do not put API keys in config files.

## Known limits

- Live API calls were verified only against a local fake Anthropic SSE server. The OpenAI streaming path is covered by unit tests only.
- The masked key prompt and onboarding were not exercised in an interactive terminal here.
- Sub-agent intermediate text is hidden. Only its final report reaches the parent.
- Changes to `mcpServers` and `hooks` take effect on restart, not on `/login`.
- Token counts are estimates (about 4 characters per token) used to decide when to compact.
