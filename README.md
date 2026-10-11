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

#### Tarball (private repo, or no GitHub access)

On a machine with the repo:

```sh
npm pack                                     # writes nemesis-0.9.0.tgz
```

Send the `.tgz` file to the user. They run:

```sh
npm install -g ./nemesis-0.9.0.tgz
nemesis
```

Requires Node 20+. No git or GitHub access needed. Upgrade by installing the newer `.tgz` the same way.

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
| `/max-steps [n\|off]` | cap tool rounds per turn; no limit by default |
| `/context-window [size]` | context window for the active provider, e.g. `200k`, `1m` |
| `/effort [level\|default]` | `low`, `medium`, `high`, `xhigh`, `max`; sent as `output_config.effort` (Anthropic) or `reasoning_effort` (OpenAI-compatible) |
| `/reasoning [mode\|default]` (`/thinking`) | Anthropic thinking: `adaptive`, `summarized` (shown dim in the feed), `disabled` |
| `/agents` | list sub-agents |
| `/mcp` | MCP server status and tools |
| `/hooks` | configured hooks |
| `/resume [id]` | pick a session from a list (or switch to `<id>`) |
| `/rename <title>` | name this session for the picker |
| `/rewind` (`/undo`) | restore files, the conversation, or both to before an earlier prompt |
| `/now` | during a turn: stop it and send the queued follow-ups now |
| `/paste` (`/paste-image`) | attach the clipboard image to the next prompt |
| `/skills` | list skills |
| `/sandbox [off\|strict]` | strict: no keys in shell commands, network-looking commands refused |
| `/mcp login <name>` | sign in to a remote MCP server (OAuth) |
| `/model` | pick a profile and model from a menu (or `/model <name>` for this profile's model) |
| `/profile` | list profiles; `/profile use\|add\|edit\|rm <name>` |
| `/jobs` | list background shells; `/jobs show\|kill <id>` |
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

## Profiles

A profile is a named provider setup: provider, base URL, one or more models, and the variable its key lives in. Use several at once: a Claude account, a hosted OpenAI-compatible endpoint, a local Ollama or LM Studio server.

```json
{
  "activeProfile": "lab",
  "profiles": {
    "claude": { "provider": "anthropic", "models": ["claude-opus-5-5", "claude-sonnet-5-5"], "model": "claude-opus-5-5" },
    "lab": { "provider": "openai", "baseUrl": "http://10.0.0.5:8000/v1", "models": ["qwen2.5-coder", "llama3"], "model": "qwen2.5-coder", "keyless": true }
  }
}
```

- Keys are stored in `~/.nemesis/.env` under the profile's `keyEnv` (`NEMESIS_KEY_<NAME>` for new profiles). `keyless: true` is for servers that need no key.
- `/model` switches profile and model together. `/profile add` creates one, `/profile edit <name>` changes it (blank key keeps the saved key), `/profile rm <name>` removes the entry.
- `nemesis --setup` lists profiles to add or edit. `--profile <name>` or `NEMESIS_PROFILE` picks one for a run.
- Entries written before profiles existed, keyed by provider name, still work.

## Background shells

`bash` with `run_in_background: true` starts a command and returns a shell id at once. `bash_output` reads new output (`wait_ms` waits for it to finish) and `kill_shell` stops it along with the processes it started. `/jobs` lists them. Background shells end when Nemesis exits. Sandbox rules apply to them too.

## Input

- `!command` runs a shell command now and keeps its output as context for the model. The prompt turns yellow.
- `#note` appends a line to `NEMESIS.md`. The prompt turns cyan.
- `@path` attaches a file (text is inlined; images are sent as image blocks). Tab completes paths.
- Up and Down recall earlier prompts; Ctrl+R searches them.
- Ctrl+O expands the last run of read-only tool calls (`Read 3 files, searched 2 patterns`).
- Ctrl+V attaches a clipboard image where the terminal passes the key through. `/paste` does the same from a command.
- Esc or Ctrl+C cancels a running turn or slash command. At an empty prompt, Ctrl+C twice exits.
- A `statusLine` command in config is run after each turn; its first line is shown under the prompt.

## Skills

A skill is a folder with a `SKILL.md`, in `.nemesis/skills/<name>/` (project) or `~/.nemesis/skills/<name>/` (user). Its frontmatter gives `name` and `description`. Only the names and descriptions go into the system prompt; the `skill` tool loads the full instructions when the model needs them.

## Permission rules

Rules live in `allowRules` and `denyRules` (config), or in `/permissions allow|deny <rule>`. A rule is a tool name or `tool(pattern)`:

- `bash(npm test:*)` allows `npm test` and `npm test -w app`, but not `npm testing`, and never a command that chains on with `;`, `&&`, `|` or `$(`.
- Any other pattern is a glob where `*` matches anything: `read_file(src/*.ts)`.
- A matching deny rule beats any allow.

Setup can import the allow and deny lists from `~/.claude/settings.json`. Tools with no Nemesis equivalent are skipped.

## Web

`web_fetch` fetches an http(s) URL and returns its text. `web_search` uses Brave Search and needs `BRAVE_API_KEY`. Both ask before running by default.

## Checkpoints

Before `write_file` or `edit_file` changes a file, Nemesis keeps its earlier content, once per user turn. `/rewind` restores code, the conversation, or both. Files changed by shell commands are not tracked, so `/rewind` does not undo them.

## Sub-agents in parallel and background

Several `task` calls in one reply run together, and each prints its progress tagged with its name. `run_in_background: true` returns a task id at once; `task_output` collects the result. Esc stops the turn but not background tasks.

## MCP

Configured under `mcpServers`. Two transports:

- stdio: `command` (and optional `args`, `env`), newline-delimited JSON-RPC.
- remote: `url` (Streamable HTTP). Headers may use `${VAR}` from the environment. For OAuth servers, run `/mcp login <name>`; tokens are kept in `~/.nemesis/mcp-auth.json` (mode 0600) and refreshed automatically.

Servers start at launch. After `/mcp login`, Nemesis reconnects that server.

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "local": { "command": "C:\\tools\\my-server.exe", "env": { "TOKEN": "..." }, "risk": "read" },
    "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
    "linear": { "url": "https://mcp.linear.app/mcp", "oauth": true }
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
- `maxSteps` caps tool rounds per turn. Unset by default: a turn runs until the model stops or you press Esc or Ctrl+C.
- API keys are stored in plain text in `~/.nemesis/.env`. On Windows the file gets no restricted ACL, so protect your user profile accordingly.

## Config reference

Precedence, lowest to highest: defaults, `~/.nemesis/config.json`, `.nemesis/config.json`, `.nemesis/config.local.json` (git-ignored), env vars, CLI flags.

```json
{
  "provider": "openai",
  "profiles": { "openai": { "model": "llama3", "baseUrl": "http://localhost:11434/v1" } },
  "maxSteps": null,
  "stream": true,
  "idleTimeoutSec": 120,
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
- Background shells on Windows: a command started and stopped within the first 1.5 seconds may leave a child process behind; the kill waits for that window before stopping the tree. Shells still running when Nemesis exits are not killed if the exit comes within that window.
- Changes to `hooks` take effect on restart. `mcpServers` changes need a restart too, except after `/mcp login`.
- `sandbox: strict` is a guardrail. A command that avoids the listed network commands (a script, an unlisted tool) is not stopped, and nothing isolates the file system. Real isolation needs OS-level containment.
- OAuth login and remote MCP were tested against a local fake server and a fake authorization flow, not against GitHub or another live provider.
- Interactive features (the footer, `!`/`#` labels, Ctrl+R, the session and rewind pickers, clipboard images) were unit-tested with a fake terminal. They were not run in a live Windows Terminal session.
- Image attachments are stored as base64 inside the session file, so sessions with images are larger.
- Token counts are estimates (about 4 characters per token) used to decide when to compact.
