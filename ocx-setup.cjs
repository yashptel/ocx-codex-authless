#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_HUB = "https://ocx.squiwo.com";
const OCX_PACKAGE = "@bitkyc08/opencodex";
const AUTHLESS_URL =
  "https://raw.githubusercontent.com/yashptel/ocx-codex-authless/main/ocx-codex-authless.cjs";

const USAGE = `Usage: ocx-setup --pairing-code <code> [--hub <url>]

Connect this machine to an OpenCodex hub for Codex and Claude, replacing any
stale connection, and install the connection's key for Codex Desktop.

Create the pairing code on the hub with \`ocx hub invite --clients codex,claude\`.`;

function parseArgs(argv) {
  const options = { hub: DEFAULT_HUB, pairingCode: "" };

  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[index + 1];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag !== "--pairing-code" && flag !== "--hub") {
      throw new Error(`Unknown argument: ${argv[index]}\n\n${USAGE}`);
    }
    if (!value) throw new Error(`${flag} needs a value\n\n${USAGE}`);
    if (inlineValue === undefined) index += 1;
    if (flag === "--hub") options.hub = value.replace(/\/+$/, "");
    else options.pairingCode = value.trim();
  }

  if (!options.pairingCode) throw new Error(`--pairing-code is required\n\n${USAGE}`);
  return options;
}

function getPaths(environment = process.env, home = os.homedir()) {
  const ocxHome = path.resolve(environment.OPENCODEX_HOME || path.join(home, ".opencodex"));
  const codexHome = path.resolve(environment.CODEX_HOME || path.join(home, ".codex"));
  return {
    tokenFile: path.join(ocxHome, "service-api-token"),
    configFile: path.join(codexHome, "config.toml"),
    journalFile: path.join(codexHome, "opencodex-journal.json"),
  };
}

function ocx(args, { input, environment = process.env } = {}) {
  const result = spawnSync("ocx", args, {
    input,
    env: environment,
    encoding: "utf8",
    // npm installs ocx as ocx.cmd on Windows, which only cmd.exe can launch.
    shell: process.platform === "win32",
  });
  if (result.error?.code === "ENOENT") return { status: 127, output: "" };
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function npm(args, environment) {
  return spawnSync("npm", args, {
    env: environment,
    stdio: "inherit",
    shell: process.platform === "win32",
  }).status;
}

async function hubVersion(hub) {
  const response = await fetch(`${hub}/healthz`);
  if (!response.ok) throw new Error(`Hub ${hub} is not healthy (HTTP ${response.status})`);
  const { version } = await response.json();
  if (!version) throw new Error(`Hub ${hub} did not report a version`);
  return version;
}

function installedVersion(environment) {
  const { status, output } = ocx(["--version"], { environment });
  return status === 0 ? output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null : null;
}

function connectionState(environment) {
  const { status, output } = ocx(["connect", "status", "--json"], { environment });
  if (status !== 0) return "disconnected";
  try {
    return JSON.parse(output.slice(output.indexOf("{"))).state ?? "disconnected";
  } catch {
    return "disconnected";
  }
}

function backup(filePath) {
  const target = `${filePath}.bak-${new Date().toISOString().replace(/[.:]/g, "-")}-${process.pid}`;
  fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
  return target;
}

// ocx refuses to disconnect when config.toml changed after it was injected, because
// disconnect would restore the older copy and drop those edits. Recording the current
// config as both the original and the injected state lets disconnect keep it as is.
function adoptCurrentCodexConfig(paths) {
  const config = fs.readFileSync(paths.configFile);
  const journal = JSON.parse(fs.readFileSync(paths.journalFile, "utf8"));
  const backups = [backup(paths.configFile), backup(paths.journalFile)];
  journal.originalConfig = config.toString("base64");
  journal.injectedConfigHash = crypto.createHash("sha256").update(config).digest("hex");
  fs.writeFileSync(paths.journalFile, JSON.stringify(journal), { mode: 0o600 });
  return backups;
}

function disconnect(environment, paths) {
  let result = ocx(["disconnect", "--keep-catalog"], { environment });
  if (result.status !== 0 && result.output.includes("journal restore was partial")) {
    const backups = adoptCurrentCodexConfig(paths);
    process.stdout.write(`   Kept your current Codex config. Backups:\n${backups.map((b) => `     ${b}`).join("\n")}\n`);
    result = ocx(["disconnect", "--keep-catalog"], { environment });
  }
  if (result.status !== 0) throw new Error(`ocx disconnect failed:\n${result.output.trim()}`);
}

function connect(environment, { hub, pairingCode }) {
  const result = ocx(
    ["connect", hub, "--management-url", hub, "--clients", "codex,claude", "--pairing-code-stdin"],
    { input: `${pairingCode}\n`, environment },
  );
  if (result.status !== 0) {
    throw new Error(
      `ocx connect failed:\n${result.output.trim()}\n\n` +
        "A pairing code works once and expires quickly. Create a new one on the hub and rerun.",
    );
  }
}

async function assertHubAcceptsKey(hub, tokenFile) {
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const response = await fetch(`${hub}/v1/catalog`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    throw new Error(`The hub rejected this machine's new key (HTTP ${response.status}).`);
  }
}

async function loadAuthless() {
  const local = path.join(__dirname, "ocx-codex-authless.cjs");
  const source = fs.existsSync(local)
    ? fs.readFileSync(local, "utf8")
    : await fetch(AUTHLESS_URL).then((response) => {
        if (!response.ok) throw new Error(`Could not download ${AUTHLESS_URL}`);
        return response.text();
      });
  // ocx-codex-authless runs itself when argv[1] is "-", which is also true when this
  // script is piped into `node -`, so load it as a plain module.
  const argv1 = process.argv[1];
  process.argv[1] = local;
  try {
    const authless = new Module(local);
    authless.filename = local;
    authless.paths = Module._nodeModulePaths(path.dirname(local));
    authless._compile(source, local);
    return authless.exports;
  } finally {
    process.argv[1] = argv1;
  }
}

async function setup(options, environment = process.env) {
  const paths = getPaths(environment);
  const steps = [
    ["Match the hub's OpenCodex version", async () => {
      const wanted = await hubVersion(options.hub);
      const current = installedVersion(environment);
      if (current === wanted) return `ocx ${current}`;
      if (npm(["install", "-g", `${OCX_PACKAGE}@${wanted}`], environment) !== 0) {
        throw new Error(`npm install -g ${OCX_PACKAGE}@${wanted} failed`);
      }
      const after = installedVersion(environment);
      if (after !== wanted) {
        throw new Error(
          `Installed ${OCX_PACKAGE}@${wanted}, but \`ocx --version\` reports ${after ?? "nothing"}. ` +
            "Another ocx is earlier on PATH; remove it or update it the same way it was installed.",
        );
      }
      return `ocx ${current ?? "missing"} -> ${after}`;
    }],
    ["Drop the previous hub connection", () => {
      if (connectionState(environment) === "disconnected") return "none";
      disconnect(environment, paths);
      return "disconnected";
    }],
    ["Connect Codex and Claude to the hub", () => {
      connect(environment, options);
      return options.hub;
    }],
    ["Check the hub accepts the new key", async () => {
      await assertHubAcceptsKey(options.hub, paths.tokenFile);
      return "accepted";
    }],
    ["Give Codex Desktop the new key", async () => {
      const result = (await loadAuthless()).run(environment);
      return result.envFile;
    }],
  ];

  for (const [index, [name, run]] of steps.entries()) {
    process.stdout.write(`[${index + 1}/${steps.length}] ${name}... `);
    process.stdout.write(`${await run()}\n`);
  }

  process.stdout.write(
    "\nDone. Fully quit Codex and Claude Desktop, then reopen them.\n" +
      "Check with: ocx connect status\n",
  );
}

module.exports = { parseArgs, setup };

if (require.main === module || !process.argv[1] || process.argv[1] === "-") {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
      }
      await setup(options);
    } catch (error) {
      process.stdout.write("\n");
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  })();
}
