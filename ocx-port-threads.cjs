#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DIRECTIONS = Object.freeze({
  port: Object.freeze({ from: "openai", to: "opencodex" }),
  revert: Object.freeze({ from: "opencodex", to: "openai" }),
});
const ROLLOUT_CHUNK_BYTES = 64 * 1024;
const ROLLOUT_PREFIX_BYTES = 64 * 1024;
const BACKUP_PREFIX = "ocx-port-threads-";

/** @typedef {{from: string, to: string}} Direction */
/** @typedef {{id: string, rolloutPath: string|null, dbProvider: string|null}} ThreadRecord */
/** @typedef {{effectiveProvider: string|null, header: object, lastOrdinal: number, hasHistoryBase: boolean, spans: Map<number, {start: number, end: number}>, endsWithNewline: boolean}} RolloutFacts */
/** @typedef {{record: ThreadRecord, facts: RolloutFacts|null, appendMarker: boolean, updateDb: boolean, offsetFixes: object[], skipReason: string|null}} Plan */

let DatabaseSync;

function timestamp() {
  return new Date().toISOString().replace(/[.:]/g, "-");
}

function getPaths(environment = process.env, home = os.homedir()) {
  const codexHome = path.resolve(
    environment.CODEX_HOME || path.join(home, ".codex"),
  );
  const sqliteHome = path.resolve(
    environment.CODEX_SQLITE_HOME || codexHome,
  );

  return {
    codexHome,
    sqliteHome,
    configFile: path.join(codexHome, "config.toml"),
    stateDatabase: path.join(sqliteHome, "state_5.sqlite"),
    historyDatabase: path.join(sqliteHome, "thread_history_1.sqlite"),
    backupsDirectory: path.join(codexHome, "backups"),
  };
}

function parseArgs(argv) {
  let mode = "port";
  let dryRun = false;
  let ignoreRunningCodex = false;
  let backupDirectory = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "-") continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--ignore-running-codex") {
      ignoreRunningCodex = true;
      continue;
    }
    if (argument === "--revert") {
      if (mode === "revert") {
        throw new Error("--revert may only be specified once");
      }

      mode = "revert";
      const next = argv[index + 1];
      if (next && !next.startsWith("--") && next !== "-") {
        backupDirectory = next;
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--revert=")) {
      if (mode === "revert") {
        throw new Error("--revert may only be specified once");
      }

      mode = "revert";
      backupDirectory = argument.slice("--revert=".length);
      if (!backupDirectory) {
        throw new Error("--revert requires a backup directory when using =");
      }
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    mode,
    direction: DIRECTIONS[mode],
    dryRun,
    ignoreRunningCodex,
    backupDirectory,
  };
}

function isSqliteExperimentalWarning(warning, type) {
  const warningType =
    typeof type === "string" ? type : type?.name || type?.type || null;
  const warningName =
    warning && typeof warning === "object" ? warning.name : warningType;
  const message =
    warning && typeof warning === "object"
      ? warning.message
      : String(warning ?? "");

  return (
    (warningName === "ExperimentalWarning" ||
      warningType === "ExperimentalWarning") &&
    /sqlite/i.test(message || "")
  );
}

function loadDatabaseSync() {
  if (DatabaseSync) return DatabaseSync;

  const originalEmitWarning = process.emitWarning;
  let replacedEmitWarning = false;

  try {
    process.emitWarning = function emitWarning(warning, ...argumentsList) {
      if (isSqliteExperimentalWarning(warning, argumentsList[0])) return;
      return originalEmitWarning.call(this, warning, ...argumentsList);
    };
    replacedEmitWarning = true;

    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    if (
      error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
      /node:sqlite|Cannot find module/i.test(String(error?.message || error))
    ) {
      throw new Error(
        "Install Node.js 22.13 or newer; this utility uses the built-in node:sqlite module.",
      );
    }
    throw error;
  } finally {
    if (replacedEmitWarning) process.emitWarning = originalEmitWarning;
  }

  if (typeof DatabaseSync !== "function") {
    throw new Error(
      "Install Node.js 22.13 or newer; this utility uses the built-in node:sqlite module.",
    );
  }

  return DatabaseSync;
}

function openDatabase(filePath, readOnly) {
  const Constructor = loadDatabaseSync();

  try {
    return new Constructor(filePath, { readOnly });
  } catch (error) {
    throw new Error(
      `Could not open SQLite database ${filePath}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

function closeDatabase(database) {
  if (!database) return;
  try {
    database.close();
  } catch {
    // The original operation is more useful than a close failure.
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function vacuumInto(database, destination) {
  database.exec(`VACUUM INTO ${sqlString(destination)}`);
}

function readConfigHasOpenCodexProvider(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Codex config not found: ${filePath}`);
  }

  let multilineState = null;

  for (const line of contents.split(/\r?\n/)) {
    const insideMultiline = multilineState !== null;
    const scan = scanTomlStrings(line, multilineState);
    multilineState = scan.state;

    if (insideMultiline || scan.containsMultilineString) continue;

    const table = line
      .replace(/^\uFEFF/, "")
      .trim()
      .match(/^\[([^\]]+)\](?:[ \t]*#.*)?$/);
    if (table && table[1].trim() === "model_providers.opencodex") {
      return true;
    }
  }

  return false;
}

function scanTomlStrings(line, multilineState) {
  let state = multilineState;
  let index = 0;
  let containsMultilineString = false;

  while (index < line.length) {
    if (state === "basic") {
      if (line.startsWith('"""', index)) {
        state = null;
        index += 3;
      } else if (line[index] === "\\") {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (state === "literal") {
      if (line.startsWith("'''", index)) {
        state = null;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }

    if (line[index] === "#") break;

    if (line.startsWith('"""', index)) {
      state = "basic";
      containsMultilineString = true;
      index += 3;
      continue;
    }

    if (line.startsWith("'''", index)) {
      state = "literal";
      containsMultilineString = true;
      index += 3;
      continue;
    }

    if (line[index] === '"') {
      index += 1;
      while (index < line.length) {
        if (line[index] === "\\") index += 2;
        else if (line[index++] === '"') break;
      }
      continue;
    }

    if (line[index] === "'") {
      index += 1;
      while (index < line.length && line[index++] !== "'") {}
      continue;
    }

    index += 1;
  }

  return { state, containsMultilineString };
}

function processBasename(value) {
  return String(value).trim().split(/[\\/]/).at(-1) || "";
}

function firstCsvField(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"')) return trimmed.split(",", 1)[0];

  let value = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    if (trimmed[index] === '"') {
      if (trimmed[index + 1] === '"') {
        value += '"';
        index += 1;
        continue;
      }
      break;
    }
    value += trimmed[index];
  }
  return value;
}

function runningCodexProcesses() {
  const windows = process.platform === "win32";
  let output;

  try {
    output = execFileSync(
      windows ? "tasklist" : "ps",
      windows ? ["/fo", "csv", "/nh"] : ["-A", "-o", "comm="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error(
      "Could not inspect running processes. Fully quit Codex/ChatGPT desktop and any codex CLI or editor extension, then rerun.",
    );
  }

  return String(output)
    .split(/\r?\n/)
    .map((line) => (windows ? firstCsvField(line) : line))
    .map(processBasename)
    .filter((name) => name.toLowerCase().startsWith("codex"));
}

function assertCodexStopped() {
  if (runningCodexProcesses().length === 0) return;

  throw new Error(
    "Codex appears to be running. Fully quit Codex/ChatGPT desktop and any codex CLI or editor extension, then rerun.",
  );
}

function getThreadRows(database) {
  let rows;

  try {
    rows = database
      .prepare(
        "SELECT id, rollout_path, model_provider FROM threads ORDER BY id",
      )
      .all();
  } catch (error) {
    throw new Error(
      `Could not read threads from state_5.sqlite: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  return rows.map((row) => ({
    id: row.id,
    rolloutPath:
      typeof row.rollout_path === "string" && row.rollout_path
        ? path.resolve(row.rollout_path)
        : null,
    dbProvider: row.model_provider ?? null,
  }));
}

function historyEntry(historyByThread, threadId) {
  const key = String(threadId);
  let entry = historyByThread.get(key);
  if (!entry) {
    entry = {
      refs: new Set(),
      turnRows: [],
      projectionRows: [],
    };
    historyByThread.set(key, entry);
  }
  return entry;
}

function addOrdinalReference(entry, ordinal) {
  if (ordinal === null || ordinal === undefined) return;

  const number = Number(ordinal);
  if (Number.isSafeInteger(number)) entry.refs.add(number);
}

function queryHistoryTable(database, sql) {
  try {
    return database.prepare(sql).all();
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : "")) {
      return [];
    }
    throw error;
  }
}

function loadHistory(database) {
  const historyByThread = new Map();
  if (!database) return historyByThread;

  const turnRows = queryHistoryTable(
    database,
    [
      "SELECT thread_id, turn_id, rollout_ordinal, rollout_byte_offset,",
      "rollout_end_ordinal, rollout_end_byte_offset",
      "FROM thread_turns ORDER BY thread_id, turn_id",
    ].join(" "),
  );
  for (const row of turnRows) {
    const entry = historyEntry(historyByThread, row.thread_id);
    entry.turnRows.push(row);
    addOrdinalReference(entry, row.rollout_ordinal);
    addOrdinalReference(entry, row.rollout_end_ordinal);
  }

  const projectionRows = queryHistoryTable(
    database,
    [
      "SELECT thread_id, next_rollout_byte_offset, next_rollout_ordinal",
      "FROM thread_history_projection_state ORDER BY thread_id",
    ].join(" "),
  );
  for (const row of projectionRows) {
    const entry = historyEntry(historyByThread, row.thread_id);
    entry.projectionRows.push(row);

    if (row.next_rollout_ordinal !== null) {
      const ordinal = Number(row.next_rollout_ordinal);
      if (Number.isSafeInteger(ordinal)) entry.refs.add(ordinal - 1);
    }
  }

  return historyByThread;
}

function parseLeadingOrdinal(prefix) {
  const text = prefix.toString("utf8");
  const match = text.match(
    /^\s*\{\s*"timestamp"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"ordinal"\s*:\s*(-?\d+)/,
  );
  if (!match) return null;

  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function candidateKindInPrefix(prefix) {
  const text = prefix.toString("utf8");
  const topLevelType = text.match(
    /^\s*\{[\s\S]*?(?<!\\)"type"\s*:\s*"(session_meta|event_msg)"/,
  );
  if (!topLevelType) return null;
  if (topLevelType[1] === "session_meta") return "session_meta";

  return /(?<!\\)"payload"\s*:\s*\{[\s\S]{0,4096}?(?<!\\)"type"\s*:\s*"thread_settings_applied"/.test(text)
    ? "thread_settings_applied"
    : null;
}

function parseCandidate(bytes, filePath) {
  let text = bytes.toString("utf8");
  if (text.endsWith("\r")) text = text.slice(0, -1);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Could not parse rollout metadata in ${filePath}`);
  }
}

function scanRolloutFile(filePath, threadId, neededOrdinals) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
  } catch {
    throw new Error(`Could not read rollout file: ${filePath}`);
  }

  const prefix = Buffer.alloc(ROLLOUT_PREFIX_BYTES);
  const chunk = Buffer.allocUnsafe(ROLLOUT_CHUNK_BYTES);
  const spans = new Map();
  let prefixLength = 0;
  let candidateParts = null;
  let lineLength = 0;
  let lineStart = 0;
  let readOffset = 0;
  let lastByte = null;
  let lastOrdinal = null;
  let header = null;
  let effectiveProvider = null;

  function consume(data) {
    if (data.length === 0) return;

    const availablePrefixBytes = ROLLOUT_PREFIX_BYTES - prefixLength;
    const prefixBytes = Math.min(availablePrefixBytes, data.length);
    if (prefixBytes > 0) {
      data.copy(prefix, prefixLength, 0, prefixBytes);
      prefixLength += prefixBytes;
    }
    lineLength += data.length;

    if (candidateParts) {
      candidateParts.push(Buffer.from(data));
      return;
    }

    if (
      prefixLength < ROLLOUT_PREFIX_BYTES &&
      candidateKindInPrefix(prefix.subarray(0, prefixLength))
    ) {
      candidateParts = [Buffer.from(prefix.subarray(0, prefixLength))];
      if (data.length > prefixBytes) {
        candidateParts.push(Buffer.from(data.subarray(prefixBytes)));
      }
    }
  }

  function finishLine(lineEnd) {
    if (lineLength === 0) {
      lineStart = lineEnd;
      prefixLength = 0;
      candidateParts = null;
      return;
    }

    const linePrefix = prefix.subarray(0, prefixLength);
    const ordinal = parseLeadingOrdinal(linePrefix);
    if (ordinal === null) {
      throw new Error(`Could not read rollout ordinal in ${filePath}`);
    }
    lastOrdinal = ordinal;

    if (neededOrdinals.has(ordinal)) {
      spans.set(ordinal, { start: lineStart, end: lineEnd });
    }

    if (candidateParts) {
      const candidate = parseCandidate(Buffer.concat(candidateParts), filePath);
      const payload = candidate && typeof candidate.payload === "object"
        ? candidate.payload
        : null;

      if (candidate.type === "session_meta" && payload) {
        if (
          payload.id !== undefined &&
          payload.id !== null &&
          String(payload.id) === String(threadId)
        ) {
          if (!header) header = candidate;
          effectiveProvider = payload.model_provider ?? null;
        }
      }

      if (
        candidate.type === "event_msg" &&
        payload?.type === "thread_settings_applied"
      ) {
        effectiveProvider = payload.thread_settings?.model_provider_id ?? null;
      }
    }

    lineStart = lineEnd;
    lineLength = 0;
    prefixLength = 0;
    candidateParts = null;
  }

  try {
    while (true) {
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        ROLLOUT_CHUNK_BYTES,
        readOffset,
      );
      if (bytesRead === 0) break;

      lastByte = chunk[bytesRead - 1];
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] !== 0x0a) continue;

        consume(chunk.subarray(segmentStart, index));
        finishLine(lineStart + lineLength + 1);
        segmentStart = index + 1;
      }

      if (segmentStart < bytesRead) {
        consume(chunk.subarray(segmentStart, bytesRead));
      }
      readOffset += bytesRead;
    }

    if (lineLength > 0) finishLine(lineStart + lineLength);
  } finally {
    fs.closeSync(descriptor);
  }

  if (lastOrdinal === null) {
    throw new Error(`Rollout file has no JSONL records: ${filePath}`);
  }

  return {
    effectiveProvider,
    header,
    lastOrdinal,
    hasHistoryBase: Boolean(
      header?.payload &&
        Object.prototype.hasOwnProperty.call(header.payload, "history_base"),
    ),
    spans,
    endsWithNewline: lastByte === 0x0a,
  };
}

function numberValue(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function valuesEqual(left, right) {
  const leftNumber = numberValue(left);
  return leftNumber !== null && leftNumber === right;
}

function offsetFixesFor(facts, history) {
  if (facts.hasHistoryBase || !history) return [];

  const fixes = [];
  for (const row of history.turnRows) {
    const rolloutOrdinal = numberValue(row.rollout_ordinal);
    const rolloutSpan =
      rolloutOrdinal === null ? null : facts.spans.get(rolloutOrdinal);
    if (rolloutSpan && !valuesEqual(row.rollout_byte_offset, rolloutSpan.start)) {
      fixes.push({
        table: "thread_turns",
        column: "rollout_byte_offset",
        threadId: row.thread_id,
        turnId: row.turn_id,
        value: rolloutSpan.start,
      });
    }

    const endOrdinal = numberValue(row.rollout_end_ordinal);
    const endSpan = endOrdinal === null ? null : facts.spans.get(endOrdinal);
    if (
      endSpan &&
      !valuesEqual(row.rollout_end_byte_offset, endSpan.end)
    ) {
      fixes.push({
        table: "thread_turns",
        column: "rollout_end_byte_offset",
        threadId: row.thread_id,
        turnId: row.turn_id,
        value: endSpan.end,
      });
    }
  }

  for (const row of history.projectionRows) {
    const nextOrdinal = numberValue(row.next_rollout_ordinal);
    if (nextOrdinal === null) continue;

    const previousSpan = facts.spans.get(nextOrdinal - 1);
    if (
      previousSpan &&
      !valuesEqual(row.next_rollout_byte_offset, previousSpan.end)
    ) {
      fixes.push({
        table: "thread_history_projection_state",
        column: "next_rollout_byte_offset",
        threadId: row.thread_id,
        value: previousSpan.end,
      });
    }
  }

  return fixes;
}

function makePlan(record, direction, historyByThread) {
  if (!record.rolloutPath || !fs.existsSync(record.rolloutPath)) {
    return {
      record,
      appendMarker: false,
      updateDb: false,
      offsetFixes: [],
      facts: null,
      skipReason: "missing-rollout",
    };
  }

  const history = historyByThread.get(String(record.id));
  const neededOrdinals = history?.refs || new Set();
  const facts = scanRolloutFile(record.rolloutPath, record.id, neededOrdinals);

  if (!facts.header) {
    throw new Error(
      `Could not find the canonical session header for thread ${String(
        record.id,
      )}`,
    );
  }

  return {
    record,
    facts,
    appendMarker: facts.effectiveProvider !== direction.to,
    updateDb: record.dbProvider !== direction.to,
    offsetFixes:
      direction === DIRECTIONS.port
        ? offsetFixesFor(facts, history)
        : [],
    skipReason: null,
  };
}

function makeMarker(facts, targetProvider) {
  const payload = { ...facts.header.payload, model_provider: targetProvider };
  delete payload.git;

  return {
    ...facts.header,
    timestamp: new Date().toISOString(),
    ordinal: facts.lastOrdinal + 1,
    payload,
  };
}

function writeAll(descriptor, bytes) {
  let written = 0;
  while (written < bytes.length) {
    written += fs.writeSync(descriptor, bytes, written, bytes.length - written);
  }
}

function appendMarker(plan, targetProvider) {
  const marker = Buffer.from(`${JSON.stringify(makeMarker(plan.facts, targetProvider))}\n`);
  const bytes = plan.facts.endsWithNewline
    ? marker
    : Buffer.concat([Buffer.from("\n"), marker]);
  let descriptor;

  try {
    descriptor = fs.openSync(
      plan.record.rolloutPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND,
    );
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw new Error(
      `Could not append the rollout marker to ${plan.record.rolloutPath}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function applyDatabaseChanges(stateDatabase, historyDatabase, plan) {
  if (plan.offsetFixes.length > 0) {
    if (!historyDatabase) {
      throw new Error("Offset repairs require thread_history_1.sqlite");
    }

    historyDatabase.exec("BEGIN IMMEDIATE");
    try {
      for (const fix of plan.offsetFixes) {
        if (fix.table === "thread_turns") {
          historyDatabase
            .prepare(
              `UPDATE thread_turns SET ${fix.column} = ? WHERE thread_id = ? AND turn_id = ?`,
            )
            .run(fix.value, fix.threadId, fix.turnId);
        } else {
          historyDatabase
            .prepare(
              `UPDATE thread_history_projection_state SET ${fix.column} = ? WHERE thread_id = ?`,
            )
            .run(fix.value, fix.threadId);
        }
      }

      historyDatabase.exec("COMMIT");
    } catch (error) {
      try {
        historyDatabase.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  if (plan.updateDb) {
    stateDatabase.exec("BEGIN IMMEDIATE");
    try {
      stateDatabase
        .prepare("UPDATE threads SET model_provider = ? WHERE id = ?")
        .run(plan.direction.to, plan.record.id);
      stateDatabase.exec("COMMIT");
    } catch (error) {
      try {
        stateDatabase.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }
}

function createBackupDirectory(backupsDirectory) {
  fs.mkdirSync(backupsDirectory, { recursive: true });
  const baseName = `${BACKUP_PREFIX}${timestamp()}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${attempt}`;
    const directory = path.join(backupsDirectory, name);
    try {
      fs.mkdirSync(directory);
      return directory;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw new Error(`Could not create backup directory: ${directory}`);
    }
  }

  throw new Error("Could not create a unique backup directory");
}

function replaceFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) {
      throw error;
    }
    fs.unlinkSync(destination);
    fs.renameSync(source, destination);
  }
}

function writeManifest(backupDirectory, manifest) {
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const temporaryPath = path.join(
    backupDirectory,
    `.manifest-${process.pid}-${Date.now()}.tmp`,
  );
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  let descriptor;

  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    writeAll(descriptor, Buffer.from(contents));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    replaceFile(temporaryPath, manifestPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function manifestEntryFor(plan) {
  return {
    id: plan.record.id,
    rolloutPath: plan.record.rolloutPath,
    appendedMarker: false,
    dbUpdated: false,
    offsetsRepaired: false,
  };
}

function makeManifest(direction, plans) {
  return {
    createdAt: new Date().toISOString(),
    from: direction.from,
    to: direction.to,
    threads: plans.map(manifestEntryFor),
  };
}

function backupBeforeWrites(paths, direction, plans, stateDatabase, historyDatabase) {
  const backupDirectory = createBackupDirectory(paths.backupsDirectory);
  const needsHistoryBackup = plans.some((plan) => plan.offsetFixes.length > 0);

  try {
    vacuumInto(stateDatabase, path.join(backupDirectory, "state_5.sqlite"));
    if (needsHistoryBackup) {
      if (!historyDatabase) {
        throw new Error("Offset repairs require thread_history_1.sqlite");
      }
      vacuumInto(
        historyDatabase,
        path.join(backupDirectory, "thread_history_1.sqlite"),
      );
    }

    const manifest = makeManifest(direction, plans);
    writeManifest(backupDirectory, manifest);
    return { backupDirectory, manifest };
  } catch (error) {
    throw new Error(
      `Could not create the backup before writing: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

function updateManifestEntry(manifest, index, plan, { appended, db, offsets }) {
  const entry = manifest.threads[index];
  entry.appendedMarker = appended;
  entry.dbUpdated = db;
  entry.offsetsRepaired = offsets;
}

function applyPlans(plans, direction, stateDatabase, historyDatabase, backup) {
  let markersAppended = 0;
  let dbRowsUpdated = 0;
  let offsetTasksRepaired = 0;

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (plan.skipReason) {
      writeManifest(backup.backupDirectory, backup.manifest);
      continue;
    }

    let appended = false;
    if (plan.appendMarker) {
      appendMarker(plan, direction.to);
      appended = true;
      markersAppended += 1;
      updateManifestEntry(backup.manifest, index, plan, {
        appended,
        db: false,
        offsets: false,
      });
      writeManifest(backup.backupDirectory, backup.manifest);
    }

    applyDatabaseChanges(stateDatabase, historyDatabase, { ...plan, direction });
    const db = plan.updateDb;
    const offsets = plan.offsetFixes.length > 0;
    if (db) dbRowsUpdated += 1;
    if (offsets) offsetTasksRepaired += 1;

    updateManifestEntry(backup.manifest, index, plan, {
      appended,
      db,
      offsets,
    });
    writeManifest(backup.backupDirectory, backup.manifest);
  }

  return { markersAppended, dbRowsUpdated, offsetTasksRepaired };
}

function loadManifest(directory) {
  const manifestPath = path.join(directory, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Could not read backup manifest: ${manifestPath}`);
  }

  if (
    !manifest ||
    manifest.from !== DIRECTIONS.port.from ||
    manifest.to !== DIRECTIONS.port.to ||
    !Array.isArray(manifest.threads)
  ) {
    throw new Error(
      "The selected backup manifest is not an ocx-port-threads port backup",
    );
  }

  const threads = [];
  const seen = new Set();
  for (const entry of manifest.threads) {
    if (!entry || entry.id === undefined || entry.id === null) continue;
    const key = String(entry.id);
    if (seen.has(key)) continue;
    seen.add(key);
    threads.push(entry);
  }

  return { ...manifest, threads };
}

function newestBackupDirectory(backupsDirectory) {
  if (!fs.existsSync(backupsDirectory)) {
    throw new Error(`No ocx-port-threads backups found in ${backupsDirectory}`);
  }

  const candidates = fs
    .readdirSync(backupsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX),
    )
    .map((entry) => path.join(backupsDirectory, entry.name))
    .sort((left, right) =>
      path.basename(right).localeCompare(path.basename(left)),
    );

  for (const candidate of candidates) {
    try {
      loadManifest(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(`No usable ocx-port-threads backup found in ${backupsDirectory}`);
}

function resolveRevertBackup(paths, requestedDirectory) {
  const directory = path.resolve(
    requestedDirectory || newestBackupDirectory(paths.backupsDirectory),
  );
  return { directory, manifest: loadManifest(directory) };
}

function createPortThreads(rows, manifest) {
  if (!manifest) return rows;

  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  const changedThreads = manifest.threads.filter(
    (entry) => entry.appendedMarker || entry.dbUpdated,
  );
  return changedThreads.map((entry) => {
    const row = rowsById.get(String(entry.id));
    if (!row) {
      return {
        id: entry.id,
        rolloutPath:
          typeof entry.rolloutPath === "string" && entry.rolloutPath
            ? path.resolve(entry.rolloutPath)
            : null,
        dbProvider: null,
        missingStateRow: true,
      };
    }

    return {
      ...row,
      rolloutPath:
        typeof entry.rolloutPath === "string" && entry.rolloutPath
          ? path.resolve(entry.rolloutPath)
          : row.rolloutPath,
      missingStateRow: false,
    };
  });
}

function planThreads(rows, direction, historyByThread) {
  return rows.map((record) => {
    if (record.missingStateRow) {
      return {
        record,
        appendMarker: false,
        updateDb: false,
        offsetFixes: [],
        facts: null,
        skipReason: "missing-state-row",
      };
    }
    return makePlan(record, direction, historyByThread);
  });
}

function printDryRunPlans(plans) {
  for (const plan of plans) {
    const id = String(plan.record.id);
    if (plan.skipReason) {
      process.stdout.write(`Thread ${id}: skipped (${plan.skipReason})\n`);
      continue;
    }
    process.stdout.write(
      `Thread ${id}: marker=${plan.appendMarker ? "yes" : "no"}, ` +
        `db=${plan.updateDb ? "yes" : "no"}, ` +
        `offsets=${plan.offsetFixes.length}\n`,
    );
  }
}

function resultFor({
  args,
  plans,
  skippedMissing,
  backupDirectory,
  markersAppended,
  dbRowsUpdated,
  offsetTasksRepaired,
}) {
  const scanned = plans.length;
  const plannedMarkers = plans.filter((plan) => plan.appendMarker).length;
  const plannedDbUpdates = plans.filter((plan) => plan.updateDb).length;
  const plannedOffsetTasks = plans.filter(
    (plan) => plan.offsetFixes.length > 0,
  ).length;

  return {
    dryRun: args.dryRun,
    plans,
    threadsScanned: scanned,
    skippedMissing,
    backupDirectory,
    markersAppended: args.dryRun ? plannedMarkers : markersAppended,
    dbRowsUpdated: args.dryRun ? plannedDbUpdates : dbRowsUpdated,
    offsetTasksRepaired: args.dryRun
      ? plannedOffsetTasks
      : offsetTasksRepaired,
  };
}

function printSummary(result) {
  const lines = [
    "",
    result.dryRun
      ? "OCX Codex task port dry run."
      : "OCX Codex task port applied.",
    "",
    `Threads scanned: ${result.threadsScanned}`,
    result.dryRun
      ? `Planned markers: ${result.markersAppended}`
      : `Markers appended: ${result.markersAppended}`,
    result.dryRun
      ? `Planned DB updates: ${result.dbRowsUpdated}`
      : `DB rows updated: ${result.dbRowsUpdated}`,
    result.dryRun
      ? `Planned offset repairs in ${result.offsetTasksRepaired} tasks`
      : `Offsets repaired in ${result.offsetTasksRepaired} tasks`,
    `Skipped missing: ${result.skippedMissing}`,
  ];

  if (result.backupDirectory) {
    lines.push(`Backup directory: ${result.backupDirectory}`);
  } else if (!result.dryRun) {
    lines.push("Backup directory: none (no changes needed)");
  }

  if (!result.dryRun) lines.push("", "Reopen Codex");
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function run(environment = process.env, argv = []) {
  const args = parseArgs(argv);
  const paths = getPaths(environment);

  if (args.mode === "port" && !readConfigHasOpenCodexProvider(paths.configFile)) {
    throw new Error(
      `Could not find [model_providers.opencodex] in ${paths.configFile}`,
    );
  }
  if (!fs.existsSync(paths.stateDatabase)) {
    throw new Error(`Codex state database not found: ${paths.stateDatabase}`);
  }
  if (!args.dryRun && !args.ignoreRunningCodex) assertCodexStopped();

  const sourceBackup =
    args.mode === "revert"
      ? resolveRevertBackup(paths, args.backupDirectory)
      : null;
  const stateDatabase = openDatabase(paths.stateDatabase, args.dryRun);
  let historyDatabase = null;

  try {
    const allRows = getThreadRows(stateDatabase);
    const rows = createPortThreads(allRows, sourceBackup?.manifest || null);

    const historyByThread = new Map();
    if (args.mode === "port" && fs.existsSync(paths.historyDatabase)) {
      historyDatabase = openDatabase(paths.historyDatabase, args.dryRun);
      for (const [key, value] of loadHistory(historyDatabase)) {
        historyByThread.set(key, value);
      }
    }

    const plans = planThreads(rows, args.direction, historyByThread);
    if (args.dryRun) {
      printDryRunPlans(plans);
      return resultFor({
        args,
        plans,
        skippedMissing: plans.filter(
          (plan) => plan.skipReason === "missing-rollout",
        ).length,
        backupDirectory: null,
        markersAppended: 0,
        dbRowsUpdated: 0,
        offsetTasksRepaired: 0,
      });
    }

    const hasWrites = plans.some(
      (plan) =>
        !plan.skipReason &&
        (plan.appendMarker || plan.updateDb || plan.offsetFixes.length > 0),
    );
    if (!hasWrites) {
      return resultFor({
        args,
        plans,
        skippedMissing: plans.filter(
          (plan) => plan.skipReason === "missing-rollout",
        ).length,
        backupDirectory: null,
        markersAppended: 0,
        dbRowsUpdated: 0,
        offsetTasksRepaired: 0,
      });
    }

    const backup = backupBeforeWrites(
      paths,
      args.direction,
      plans,
      stateDatabase,
      historyDatabase,
    );
    const applied = applyPlans(
      plans,
      args.direction,
      stateDatabase,
      historyDatabase,
      backup,
    );

    return resultFor({
      args,
      plans,
      skippedMissing: plans.filter(
        (plan) => plan.skipReason === "missing-rollout",
      ).length,
      backupDirectory: backup.backupDirectory,
      ...applied,
    });
  } finally {
    closeDatabase(historyDatabase);
    closeDatabase(stateDatabase);
  }
}

module.exports = {
  getPaths,
  parseArgs,
  run,
};

if (require.main === module || !process.argv[1] || process.argv[1] === "-") {
  try {
    printSummary(run(process.env, process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
