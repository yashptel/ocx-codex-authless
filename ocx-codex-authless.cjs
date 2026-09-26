#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TARGET_SECTION = "model_providers.opencodex";
const TOKEN_ENV_KEY = "OPENCODEX_API_AUTH_TOKEN";

function timestamp() {
  return new Date().toISOString().replace(/[.:]/g, "-");
}

function getPaths(environment = process.env, home = os.homedir()) {
  const ocxHome = path.resolve(
    environment.OPENCODEX_HOME || path.join(home, ".opencodex"),
  );
  const codexHome = path.resolve(
    environment.CODEX_HOME || path.join(home, ".codex"),
  );

  return {
    ocxHome,
    codexHome,
    tokenFile: path.join(ocxHome, "service-api-token"),
    configFile: path.join(codexHome, "config.toml"),
    envFile: path.join(codexHome, ".env"),
  };
}

function readText(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Could not read ${label}: ${filePath}`);
  }
}

function splitLines(text) {
  const lines = [];
  let lineStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;

    const eol =
      text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : text[index];
    lines.push({ text: text.slice(lineStart, index), eol });
    index += eol.length - 1;
    lineStart = index + 1;
  }

  if (lineStart < text.length || lines.length === 0) {
    lines.push({ text: text.slice(lineStart), eol: "" });
  }

  return lines;
}

function joinLines(lines) {
  return lines.map(({ text, eol }) => `${text}${eol}`).join("");
}

function detectEol(text) {
  if (text.includes("\r\n")) return "\r\n";
  if (text.includes("\r")) return "\r";
  if (text.includes("\n")) return "\n";
  return os.EOL;
}

function parseTableHeader(line) {
  const text = line.startsWith("\uFEFF") ? line.slice(1) : line;
  const trimmed = text.trim();

  const arrayMatch = trimmed.match(/^\[\[([^\]]+)\]\](?:[ \t]*#.*)?$/);
  if (arrayMatch) {
    return { name: arrayMatch[1].trim(), array: true };
  }

  const tableMatch = trimmed.match(/^\[([^\]]+)\](?:[ \t]*#.*)?$/);
  if (tableMatch) {
    return { name: tableMatch[1].trim(), array: false };
  }

  return null;
}

function scanTomlLine(text, multilineState) {
  let state = multilineState;
  let index = 0;
  let containsMultilineString = false;

  while (index < text.length) {
    if (state === "basic-multiline") {
      if (text[index] === "\\") {
        index += 2;
      } else if (text.startsWith('"""', index)) {
        state = null;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }

    if (state === "literal-multiline") {
      if (text.startsWith("'''", index)) {
        state = null;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }

    if (text[index] === "#") break;

    if (text[index] === '"') {
      if (text.startsWith('"""', index)) {
        state = "basic-multiline";
        containsMultilineString = true;
        index += 3;
        continue;
      }

      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
        } else if (text[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (text[index] === "'") {
      if (text.startsWith("'''", index)) {
        state = "literal-multiline";
        containsMultilineString = true;
        index += 3;
        continue;
      }

      index += 1;
      while (index < text.length && text[index] !== "'") index += 1;
      if (index < text.length) index += 1;
      continue;
    }

    index += 1;
  }

  return { state, containsMultilineString };
}

function annotateTomlLines(lines) {
  let multilineState = null;

  return lines.map((line) => {
    const insideMultilineString = multilineState !== null;
    const scan = scanTomlLine(line.text, multilineState);
    multilineState = scan.state;

    return {
      ...line,
      insideMultilineString,
      containsMultilineString: scan.containsMultilineString,
    };
  });
}

function findTargetSection(lines) {
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (
      lines[index].insideMultilineString ||
      lines[index].containsMultilineString
    ) {
      continue;
    }

    const header = parseTableHeader(lines[index].text);
    if (header?.name === TARGET_SECTION && !header.array) {
      matches.push(index);
    }
  }

  if (matches.length === 0) {
    throw new Error(`Could not find [${TARGET_SECTION}]`);
  }

  if (matches.length > 1) {
    throw new Error(`Found multiple [${TARGET_SECTION}] sections`);
  }

  const start = matches[0];
  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    if (
      !lines[index].insideMultilineString &&
      !lines[index].containsMultilineString &&
      parseTableHeader(lines[index].text)
    ) {
      end = index;
      break;
    }
  }

  return { start, end };
}

function parseTargetAssignment(line) {
  const match = line.match(
    /^([ \t]*)(requires_openai_auth|env_key)([ \t]*)=([\s\S]*)$/,
  );
  if (!match) return null;

  return {
    indent: match[1],
    key: match[2],
    value: match[4].trim(),
  };
}

function appendSectionLine(lines, section, text, eol) {
  let insertAt = section.end;

  while (
    insertAt > section.start &&
    lines[insertAt - 1].text.length === 0
  ) {
    insertAt -= 1;
  }

  const previous = lines[insertAt - 1];
  if (previous && previous.eol === "") previous.eol = eol;

  const hasFollowingLine = insertAt < lines.length;
  const newLineEol = previous?.eol || (hasFollowingLine ? eol : "");
  lines.splice(insertAt, 0, { text, eol: newLineEol });
  section.end += 1;
}

function patchConfig(config) {
  const lines = annotateTomlLines(splitLines(config));
  const section = findTargetSection(lines);
  const eol = detectEol(config);
  let authlessConfigured = false;
  let envKeyConfigured = false;

  for (let index = section.start + 1; index < section.end; index += 1) {
    if (
      lines[index].insideMultilineString ||
      lines[index].containsMultilineString
    ) {
      continue;
    }

    const assignment = parseTargetAssignment(lines[index].text);
    if (!assignment) continue;

    const expectedValue =
      assignment.key === "requires_openai_auth"
        ? "false"
        : `"${TOKEN_ENV_KEY}"`;

    lines[index].text =
      `${assignment.indent}${assignment.key} = ${expectedValue}`;

    if (assignment.key === "requires_openai_auth") {
      authlessConfigured = true;
    } else {
      envKeyConfigured = true;
    }
  }

  if (!authlessConfigured) {
    appendSectionLine(
      lines,
      section,
      "requires_openai_auth = false",
      eol,
    );
  }

  if (!envKeyConfigured) {
    appendSectionLine(
      lines,
      section,
      `env_key = "${TOKEN_ENV_KEY}"`,
      eol,
    );
  }

  return joinLines(lines);
}

function readTargetState(config) {
  const lines = annotateTomlLines(splitLines(config));
  const section = findTargetSection(lines);
  const state = {
    authless: false,
    envKeyConfigured: false,
  };

  for (let index = section.start + 1; index < section.end; index += 1) {
    if (
      lines[index].insideMultilineString ||
      lines[index].containsMultilineString
    ) {
      continue;
    }

    const assignment = parseTargetAssignment(lines[index].text);
    if (!assignment) continue;

    if (
      assignment.key === "requires_openai_auth" &&
      assignment.value === "false"
    ) {
      state.authless = true;
    }

    if (
      assignment.key === "env_key" &&
      assignment.value === `"${TOKEN_ENV_KEY}"`
    ) {
      state.envKeyConfigured = true;
    }
  }

  return state;
}

function isTokenAssignment(line) {
  return new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?${TOKEN_ENV_KEY}[ \\t]*=`,
  ).test(line);
}

function serializeDotenvValue(value) {
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) {
    throw new Error(
      "OCX token contains a control character that cannot be stored safely in .env",
    );
  }

  if (!value.includes("'")) return `'${value}'`;

  if (!value.includes('"') && !value.includes("\\")) {
    return `"${value}"`;
  }

  throw new Error(
    "OCX token contains quotes that cannot be serialized safely in .env",
  );
}

function patchEnv(envContents, token) {
  const lines = envContents ? splitLines(envContents).map(({ text }) => text) : [];
  const serializedToken = serializeDotenvValue(token);

  while (lines.at(-1) === "") lines.pop();

  const retained = lines.filter((line) => !isTokenAssignment(line));
  retained.push(`${TOKEN_ENV_KEY}=${serializedToken}`);

  return `${retained.join(detectEol(envContents))}${detectEol(envContents)}`;
}

function tokenFromFile(tokenFile) {
  const token = readText(tokenFile, "OCX token file").replace(/[\r\n]+$/, "");

  if (!token) {
    throw new Error(`OCX token file is empty: ${tokenFile}`);
  }

  return token;
}

function createBackup(filePath, { privateFile = false } = {}) {
  if (!fs.existsSync(filePath)) return null;

  const originalMode = fs.statSync(filePath).mode & 0o777;
  const base = `${filePath}.bak-${timestamp()}-${process.pid}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const backupPath = attempt === 0 ? base : `${base}-${attempt}`;

    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      if (process.platform !== "win32") {
        fs.chmodSync(backupPath, privateFile ? 0o600 : originalMode);
      }
      return backupPath;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw new Error(`Could not create backup: ${filePath}`);
    }
  }

  throw new Error(`Could not create a unique backup: ${filePath}`);
}

function writeText(filePath, contents, { privateFile = false } = {}) {
  try {
    const options = { encoding: "utf8" };
    if (privateFile) options.mode = 0o600;
    fs.writeFileSync(filePath, contents, options);

    if (privateFile && process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    throw new Error(`Could not write file: ${filePath}`);
  }
}

function chmodPrivateBestEffort(filePath) {
  if (process.platform === "win32") return;

  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Permission tightening is best effort on platforms/filesystems that do not support it.
  }
}

function hasTokenAssignment(envContents, token) {
  const serializedToken = serializeDotenvValue(token);

  return splitLines(envContents).some(
    ({ text }) => text === `${TOKEN_ENV_KEY}=${serializedToken}`,
  );
}

function restoreFile(filePath, existed, contents, mode) {
  if (!existed) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }

  fs.writeFileSync(filePath, contents, { encoding: "utf8" });
  if (process.platform !== "win32") fs.chmodSync(filePath, mode);
}

function rollback(paths, snapshots) {
  const failures = [];

  try {
    restoreFile(
      paths.configFile,
      snapshots.config.existed,
      snapshots.config.contents,
      snapshots.config.mode,
    );
  } catch {
    failures.push(paths.configFile);
  }

  try {
    restoreFile(
      paths.envFile,
      snapshots.env.existed,
      snapshots.env.contents,
      snapshots.env.mode,
    );
  } catch {
    failures.push(paths.envFile);
  }

  if (failures.length > 0) {
    throw new Error(`Could not roll back: ${failures.join(", ")}`);
  }
}

function run(environment = process.env) {
  const paths = getPaths(environment);

  if (!fs.existsSync(paths.tokenFile)) {
    throw new Error(
      `OCX token not found:\n${paths.tokenFile}\n\n` +
        `Make sure this machine is connected using "ocx connect".`,
    );
  }

  if (!fs.existsSync(paths.configFile)) {
    throw new Error(
      `Codex config not found:\n${paths.configFile}\n\n` +
        `Run "ocx sync" first so OCX creates the Codex provider configuration.`,
    );
  }

  const token = tokenFromFile(paths.tokenFile);
  const config = readText(paths.configFile, "Codex config");
  const patchedConfig = patchConfig(config);
  const envExisted = fs.existsSync(paths.envFile);
  const existingEnv = envExisted
    ? readText(paths.envFile, "Codex environment file")
    : "";
  const patchedEnv = patchEnv(existingEnv, token);
  const snapshots = {
    config: {
      existed: true,
      contents: config,
      mode: fs.statSync(paths.configFile).mode & 0o777,
    },
    env: {
      existed: envExisted,
      contents: existingEnv,
      mode: envExisted ? fs.statSync(paths.envFile).mode & 0o777 : 0o600,
    },
  };

  fs.mkdirSync(paths.codexHome, { recursive: true });

  const configBackup = createBackup(paths.configFile);
  const envBackup = createBackup(paths.envFile, { privateFile: true });

  try {
    writeText(paths.configFile, patchedConfig);
    writeText(paths.envFile, patchedEnv, { privateFile: true });
    chmodPrivateBestEffort(paths.tokenFile);

    const finalState = readTargetState(
      readText(paths.configFile, "updated Codex config"),
    );
    const finalEnv = readText(paths.envFile, "updated Codex environment file");

    if (
      !finalState.authless ||
      !finalState.envKeyConfigured ||
      !hasTokenAssignment(finalEnv, token)
    ) {
      throw new Error("Verification failed after writing the configuration");
    }

    return {
      ...paths,
      configBackup,
      envBackup,
      authless: finalState.authless,
      envKeyConfigured: finalState.envKeyConfigured,
      tokenInstalled: true,
    };
  } catch (error) {
    try {
      rollback(paths, snapshots);
    } catch (rollbackError) {
      throw new Error(`${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

function printSummary(result) {
  const lines = [
    "",
    "Codex Desktop authless OCX configuration applied.",
    "",
    `   OCX home:   ${result.ocxHome}`,
    `   Codex home: ${result.codexHome}`,
    `   Config:     ${result.configFile}`,
    `   Env:        ${result.envFile}`,
  ];

  if (result.configBackup) lines.push(`   Config backup: ${result.configBackup}`);
  if (result.envBackup) lines.push(`   Env backup:    ${result.envBackup}`);

  lines.push(
    "",
    `   requires_openai_auth=false: ${result.authless ? "yes" : "no"}`,
    `   env_key configured:         ${result.envKeyConfigured ? "yes" : "no"}`,
    `   OCX token installed:        ${result.tokenInstalled ? "yes" : "no"}`,
    "",
    "Fully quit Codex Desktop and reopen it.",
    "",
    "Note: if you run `ocx sync` again, OCX may restore `requires_openai_auth = true`. Run this script again afterward.",
    "",
  );

  process.stdout.write(`${lines.join("\n")}\n`);
}

module.exports = { run };

if (require.main === module || !process.argv[1] || process.argv[1] === "-") {
  try {
    printSummary(run());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
