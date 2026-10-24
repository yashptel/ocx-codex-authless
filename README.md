# ocx-codex-authless

Small, cross-platform Node.js utility that configures the OCX Codex provider to use the local OCX service token without requiring OpenAI authentication.

## Set up a device in one command

`ocx-setup.cjs` connects a machine to the OpenCodex hub for Codex and Claude and installs the new key for Codex Desktop. It also replaces a connection to an older or rebuilt hub.

Create a pairing code on the hub. Each code works once and expires within about 30 minutes:

```bash
ocx hub invite --clients codex,claude
```

Then run this on the device, with the `ocx_pair_…` code from that output.

macOS, Linux, and Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.4.1/ocx-setup.cjs | node - --pairing-code ocx_pair_...
```

Windows PowerShell:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.4.1/ocx-setup.cjs | node - --pairing-code ocx_pair_...
```

It runs these steps in order and stops at the first failure:

1. Read the hub's version from `/healthz` and install the same `@bitkyc08/opencodex` version with `npm install -g` if `ocx --version` differs.
2. Run `ocx disconnect --keep-catalog` if the machine is connected. If ocx refuses because `~/.codex/config.toml` changed after it was injected, the script backs up `config.toml` and `opencodex-journal.json`, records the current config as the one to keep, and retries. Your Codex settings stay as they are.
3. Run `ocx connect` for Codex and Claude. The pairing code goes to ocx on stdin, never on its command line.
4. Check that the hub accepts the new key with `HEAD /v1/catalog`. Nothing in Codex changes if it does not.
5. Run `ocx-codex-authless.cjs`, which writes the new key to `~/.codex/.env`. Codex Desktop otherwise keeps reading the key for the previous hub from that file.

Afterward, fully quit Codex and Claude Desktop and reopen them. `--hub <url>` connects to a hub other than `https://ocx.squiwo.com`.

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
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert "$env:USERPROFILE\.codex\backups\ocx-port-threads-<timestamp>"
```

### Windows Command Prompt

```bat
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --dry-run
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | node - --revert "%USERPROFILE%\.codex\backups\ocx-port-threads-<timestamp>"
```

### Options

Pass options after `node -` when you pipe the script, or after the file name when you run a downloaded copy.

| Option | Effect |
| --- | --- |
| none | Port every `openai` task to `opencodex` and repair stale history offsets. |
| `--dry-run` | Print the plan for each task and the totals. Changes nothing. Codex can stay open. |
| `--revert` | Undo the newest port backup. Only tasks that the port changed go back to `openai`. |
| `--revert <backupDir>` | Undo the port recorded in that backup directory. |
| `--ignore-running-codex` | Skip the check for running Codex processes. Use it only when no Codex process uses the target `CODEX_HOME`, for example with a custom `CODEX_HOME`. |

The porter reads `CODEX_HOME` (default `~/.codex`) and `CODEX_SQLITE_HOME` (default `CODEX_HOME`):

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs | CODEX_HOME=/path/to/codex-home node - --dry-run
```

To inspect the porter before you run it, download it first:

```bash
curl -fsSLo ocx-port-threads.cjs https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.2.0/ocx-port-threads.cjs
node ocx-port-threads.cjs --dry-run
node ocx-port-threads.cjs
```

### What it changes

The porter updates `threads.model_provider` and appends a small `session_meta` marker to each selected rollout file. Existing rollout bytes stay unchanged. In port mode it also repairs stored history offsets for non-fork tasks when their content shows they are stale. Backups are stored under `CODEX_HOME/backups/ocx-port-threads-<timestamp>/`; the state database is always backed up before a write, and the history database is backed up when offset repairs are needed. Reopen Codex after it succeeds.

## Turn off the Claude Desktop sandbox

In opencodex gateway mode, Claude Desktop turns its local 3P profile into managed policy, so Settings › Claude Code shows "Local sandbox" locked on. This script sets `coworkEgressAllowedHosts` to `["*"]` in the profile opencodex applied and removes `allowedWorkspaceFolders` and `blockReadsOutsideWorkingDirectories`. Shell commands Claude runs can then reach any host and write outside the project.

### macOS and Linux

```bash
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.3.0/ocx-claude-sandbox-off.cjs | node
curl -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.3.0/ocx-claude-sandbox-off.cjs | node - --revert
```

### Windows PowerShell

Use `curl.exe` because `curl` may be a PowerShell alias:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.3.0/ocx-claude-sandbox-off.cjs | node
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.3.0/ocx-claude-sandbox-off.cjs | node - --revert
```

### Windows Command Prompt

```bat
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.3.0/ocx-claude-sandbox-off.cjs | node
curl.exe -fsSL https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.3.0/ocx-claude-sandbox-off.cjs | node - --revert
```

Native Windows Claude Code has no local sandbox, so this change only affects Desktop's egress allowlist there.

After it runs, fully quit and reopen Claude Desktop and start a new Code session. Older sessions keep the old rules. A backup is written next to the profile; `--revert` restores the newest one. `ocx claude desktop apply` keeps keys it does not own, so the change survives re-applying. If a managed Claude Desktop policy exists (`/Library/Managed Preferences/<user>/com.anthropic.claudefordesktop.plist` on macOS, `/etc/claude-desktop/managed-settings.json` on Linux, or `HKLM/HKCU\SOFTWARE\Policies\Claude` on Windows), Desktop ignores the local profile and this script has no effect. Custom locations are supported with `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` or `CLAUDE_USER_DATA_DIR`.

## Remote-pipe warning

`curl ... | node` downloads and immediately executes remote code with your local user permissions. Review the script and prefer a pinned tag or commit. For higher-assurance use, download it first, inspect it, and run the local file instead:

```bash
curl -fsSLo ocx-codex-authless.cjs https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.1.0/ocx-codex-authless.cjs
node ocx-codex-authless.cjs
```

In PowerShell or Command Prompt, use `curl.exe` for the download command too.

## Development

The authless configurator and sandbox script support Node.js 18 or newer; the task porter requires Node.js 22.13 or newer. There are no third-party dependencies.

```bash
npm test
```

Tests use temporary `CODEX_HOME` and `OPENCODEX_HOME` directories and do not touch the real home directory.
