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

## Remote-pipe warning

`curl ... | node` downloads and immediately executes remote code with your local user permissions. Review the script and prefer a pinned tag or commit. For higher-assurance use, download it first, inspect it, and run the local file instead:

```bash
curl -fsSLo ocx-codex-authless.cjs https://raw.githubusercontent.com/yashptel/ocx-codex-authless/v0.1.0/ocx-codex-authless.cjs
node ocx-codex-authless.cjs
```

In PowerShell or Command Prompt, use `curl.exe` for the download command too.

## Development

Requires Node.js 18 or newer. There are no third-party dependencies.

```bash
npm test
```

Tests use temporary `CODEX_HOME` and `OPENCODEX_HOME` directories and do not touch the real home directory.
