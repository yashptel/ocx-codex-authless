#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX_OFF = Object.freeze({
  set: Object.freeze({
    coworkEgressAllowedHosts: Object.freeze(["*"]),
  }),
  remove: Object.freeze([
    "allowedWorkspaceFolders",
    "blockReadsOutsideWorkingDirectories",
  ]),
});

function timestamp() {
  return new Date().toISOString().replace(/[.:]/g, "-");
}

function environmentValue(environment, key) {
  const value = environment?.[key];
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed || null;
}

function resolveConfigLibraryDir({ env, platform, home }) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const override = environmentValue(env, "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR");
  if (override) return override;

  let userData = environmentValue(env, "CLAUDE_USER_DATA_DIR");

  if (!userData && platform === "win32") {
    const localAppData = environmentValue(env, "LOCALAPPDATA");
    if (localAppData) {
      userData = path.win32.join(localAppData, "Claude-3p");
    }
  }

  if (!userData) {
    let electronUserData;

    if (platform === "win32") {
      const appData = environmentValue(env, "APPDATA");
      electronUserData = appData
        ? path.win32.join(appData, "Claude")
        : path.win32.join(home, "AppData", "Roaming", "Claude");
    } else if (platform === "darwin") {
      electronUserData = path.posix.join(
        home,
        "Library",
        "Application Support",
        "Claude",
      );
    } else {
      const xdgConfigHome = environmentValue(env, "XDG_CONFIG_HOME");
      electronUserData = xdgConfigHome
        ? path.posix.join(xdgConfigHome, "Claude")
        : path.posix.join(home, ".config", "Claude");
    }

    userData = electronUserData.endsWith("-3p")
      ? electronUserData
      : `${electronUserData}-3p`;
  }

  return join(userData, "configLibrary");
}

function parseArgs(argv) {
  let mode = "apply";

  for (const argument of argv) {
    if (argument === "-") continue;
    if (argument === "--revert") {
      mode = "revert";
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return mode;
}

function readAppliedId(metaFile) {
  try {
    const metadata = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      typeof metadata.appliedId !== "string" ||
      !metadata.appliedId
    ) {
      throw new Error("missing appliedId");
    }

    return metadata.appliedId;
  } catch {
    throw new Error(
      `Could not read Claude Desktop metadata or find appliedId at ${metaFile}. ` +
        "Run `ocx claude desktop apply` first.",
    );
  }
}

function readProfile(profileFile) {
  let contents;

  try {
    contents = fs.readFileSync(profileFile, "utf8");
  } catch {
    throw new Error(`Could not read Claude Desktop profile: ${profileFile}`);
  }

  let profile;
  try {
    profile = JSON.parse(contents);
  } catch {
    throw new Error(`Could not parse Claude Desktop profile: ${profileFile}`);
  }

  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(
      `Claude Desktop profile is not a JSON object: ${profileFile}`,
    );
  }

  return profile;
}

function valuesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSandboxOff(profile) {
  return (
    Object.entries(SANDBOX_OFF.set).every(([key, value]) =>
      valuesMatch(profile[key], value),
    ) &&
    SANDBOX_OFF.remove.every((key) => !Object.hasOwn(profile, key))
  );
}

function applySandboxOff(profile) {
  const patched = { ...profile };

  for (const [key, value] of Object.entries(SANDBOX_OFF.set)) {
    patched[key] = value;
  }
  for (const key of SANDBOX_OFF.remove) {
    delete patched[key];
  }

  return patched;
}

function createBackup(profileFile, platform) {
  const base = `${profileFile}.bak-sandbox-off-${timestamp()}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const backupFile =
      attempt === 0 ? base : `${base}-${attempt}`;

    try {
      fs.copyFileSync(profileFile, backupFile, fs.constants.COPYFILE_EXCL);
      if (platform !== "win32") fs.chmodSync(backupFile, 0o600);
      return backupFile;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw new Error(`Could not create backup: ${profileFile}`);
    }
  }

  throw new Error(`Could not create a unique backup: ${profileFile}`);
}

function replaceFile(filePath, contents, platform) {
  const tempFile = `${filePath}.tmp-${process.pid}`;

  try {
    fs.writeFileSync(tempFile, contents, { mode: 0o600 });
    if (platform !== "win32") fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, filePath);
  } catch {
    fs.rmSync(tempFile, { force: true });
    throw new Error(`Could not write Claude Desktop profile: ${filePath}`);
  }
}

function latestBackupName(configLibraryDir, appliedId, profileFile) {
  const prefix = `${appliedId}.json.bak-sandbox-off-`;
  let names;

  try {
    names = fs.readdirSync(configLibraryDir);
  } catch {
    names = [];
  }

  const backupName = names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .at(-1);
  if (!backupName) {
    throw new Error(`No sandbox-off backup found for ${profileFile}`);
  }

  return backupName;
}

function run(
  environment = process.env,
  argv = [],
  { platform = process.platform, home = os.homedir() } = {},
) {
  const mode = parseArgs(argv);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const configLibraryDir = resolveConfigLibraryDir({
    env: environment,
    platform,
    home,
  });
  const metaFile = join(configLibraryDir, "_meta.json");
  const appliedId = readAppliedId(metaFile);

  if (
    appliedId.includes("/") ||
    appliedId.includes("\\") ||
    appliedId.includes("..")
  ) {
    throw new Error(`Invalid appliedId in ${metaFile}`);
  }

  const profileFile = join(configLibraryDir, `${appliedId}.json`);

  if (mode === "revert") {
    const restoredFrom = join(
      configLibraryDir,
      latestBackupName(configLibraryDir, appliedId, profileFile),
    );
    replaceFile(profileFile, fs.readFileSync(restoredFrom), platform);

    return {
      mode,
      configLibraryDir,
      profileFile,
      changed: true,
      backupFile: null,
      restoredFrom,
    };
  }

  const profile = readProfile(profileFile);

  if (isSandboxOff(profile)) {
    return {
      mode,
      configLibraryDir,
      profileFile,
      changed: false,
      backupFile: null,
      restoredFrom: null,
    };
  }

  const backupFile = createBackup(profileFile, platform);
  replaceFile(
    profileFile,
    JSON.stringify(applySandboxOff(profile), null, 2),
    platform,
  );

  if (!isSandboxOff(readProfile(profileFile))) {
    throw new Error(`Verification failed for Claude Desktop profile: ${profileFile}`);
  }

  return {
    mode,
    configLibraryDir,
    profileFile,
    changed: true,
    backupFile,
    restoredFrom: null,
  };
}

function printSummary(result) {
  const lines = [
    "",
    result.mode === "revert"
      ? "Claude Desktop sandbox profile restored."
      : result.changed
        ? "Claude Desktop sandbox turned off."
        : "Claude Desktop sandbox is already off.",
    "",
    `Profile: ${result.profileFile}`,
  ];

  if (result.mode === "revert") {
    lines.push(`Restored from: ${result.restoredFrom}`);
  } else {
    if (result.backupFile) lines.push(`Backup: ${result.backupFile}`);
    lines.push('coworkEgressAllowedHosts: ["*"]');
  }

  lines.push(
    "",
    "Fully quit Claude Desktop and reopen it, then start a new Code session.",
    "",
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

module.exports = { resolveConfigLibraryDir, run };

if (require.main === module || !process.argv[1] || process.argv[1] === "-") {
  try {
    printSummary(run(process.env, process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
