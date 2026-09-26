# ocx-codex-authless

Small, cross-platform Node.js utility that configures the OCX Codex provider to use the local OCX service token without requiring OpenAI authentication.

## Run it

Prerequisites: run `ocx connect` and `ocx sync` first. The examples below use the reviewed, immutable `v0.1.0` tag. `main` is also shown for the latest development version.

### macOS, Linux, and Git Bash

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.1.0/ocx-codex-authless.cjs | node
```

For `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/main/ocx-codex-authless.cjs | node
```

### Windows PowerShell

Use `curl.exe` because `curl` may be a PowerShell alias:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.1.0/ocx-codex-authless.cjs | node
```

For `main`:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/main/ocx-codex-authless.cjs | node
```

### Windows Command Prompt

On current Windows versions, `curl.exe` and `node` can be piped directly:

```bat
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.1.0/ocx-codex-authless.cjs | node
```

For `main`:

```bat
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/main/ocx-codex-authless.cjs | node
```

Pinned tags are recommended for repeatable use. `main` is mutable and can change between runs.

The script reads `~/.opencodex/service-api-token`, patches only `[model_providers.opencodex]` in `~/.codex/config.toml`, and writes `OPENCODEX_API_AUTH_TOKEN` to `~/.codex/.env`. Existing `config.toml` and `.env` files are backed up before they are changed. The token is never printed.

Custom locations are supported with `OPENCODEX_HOME` and `CODEX_HOME`.

After it succeeds, fully quit and reopen Codex Desktop. Running `ocx sync` later may restore `requires_openai_auth = true`; run this utility again afterward.

## Port old Codex tasks

Older Codex tasks can stay on the `openai` provider even after OCX is configured. This utility moves them to `opencodex` and keeps the change when Codex reconciles a task during resume or search.

It requires Node.js 22.13 or newer. Fully quit Codex Desktop, ChatGPT Desktop, Codex CLI, and any editor extension that runs Codex before applying it.

### macOS, Linux, and Git Bash

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node
```

Preview the plan without changing anything:

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --dry-run
```

Revert the newest port backup, or pass a backup directory explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert /path/to/ocx-port-threads-backup
```

### Windows PowerShell

Use `curl.exe` because `curl` may be a PowerShell alias:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --dry-run
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert
```

### Windows Command Prompt

```bat
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --dry-run
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert
```

The porter updates `threads.model_provider` and appends a small `session_meta` marker to each selected rollout file. Existing rollout bytes stay unchanged. In port mode it also repairs stored history offsets for non-fork tasks when their content shows they are stale. Backups are stored under `CODEX_HOME/backups/ocx-port-threads-<timestamp>/`; the state database is always backed up before a write, and the history database is backed up when offset repairs are needed. Reopen Codex after it succeeds.

## Remote-pipe warning

`curl ... | node` downloads and immediately executes remote code with your local user permissions. Review the script and prefer a pinned tag or commit. For higher-assurance use, download it first, inspect it, and run the local file instead:

```bash
curl -fsSLo ocx-codex-authless.cjs https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.1.0/ocx-codex-authless.cjs
node ocx-codex-authless.cjs
```

In PowerShell or Command Prompt, use `curl.exe` for the download command too.

## Development

The authless configurator supports Node.js 18 or newer; the task porter requires Node.js 22.13 or newer. There are no third-party dependencies.

```bash
npm test
```

Tests use temporary `CODEX_HOME` and `OPENCODEX_HOME` directories and do not touch the real home directory.
