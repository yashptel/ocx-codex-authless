import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "ocx-port-threads.cjs");
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

function jsonLine(timestamp, ordinal, type, payload) {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

function makeFixture({
  threads,
  historyTurns = [],
  historyProjections = [],
  config = "[model_providers.opencodex]\nname = \"OCX\"\n",
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-port-threads-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), config);

  const statePath = path.join(codexHome, "state_5.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec(
    [
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT)",
    ].join("\n"),
  );
  const insertThread = state.prepare(
    "INSERT INTO threads (id, rollout_path, model_provider) VALUES (?, ?, ?)",
  );

  const rolloutPaths = new Map();
  for (const thread of threads) {
    const rolloutPath = path.join(root, `${thread.id}.jsonl`);
    fs.writeFileSync(rolloutPath, thread.contents, "utf8");
    rolloutPaths.set(thread.id, rolloutPath);
    insertThread.run(thread.id, rolloutPath, thread.dbProvider);
  }
  state.close();

  const historyPath = path.join(codexHome, "thread_history_1.sqlite");
  if (historyTurns.length > 0 || historyProjections.length > 0) {
    const history = new DatabaseSync(historyPath);
    history.exec(
      [
        "CREATE TABLE thread_turns (",
        "  thread_id TEXT NOT NULL,",
        "  turn_id TEXT NOT NULL,",
        "  rollout_ordinal INTEGER,",
        "  rollout_byte_offset INTEGER,",
        "  rollout_end_ordinal INTEGER,",
        "  rollout_end_byte_offset INTEGER,",
        "  PRIMARY KEY (thread_id, turn_id)",
        ");",
        "CREATE TABLE thread_history_projection_state (",
        "  thread_id TEXT PRIMARY KEY,",
        "  next_rollout_byte_offset INTEGER,",
        "  next_rollout_ordinal INTEGER",
        ");",
      ].join("\n"),
    );
    const insertTurn = history.prepare(
      [
        "INSERT INTO thread_turns (",
        "thread_id, turn_id, rollout_ordinal, rollout_byte_offset,",
        "rollout_end_ordinal, rollout_end_byte_offset",
        ") VALUES (?, ?, ?, ?, ?, ?)",
      ].join(" "),
    );
    for (const row of historyTurns) {
      insertTurn.run(
        row.threadId,
        row.turnId,
        row.rolloutOrdinal,
        row.rolloutByteOffset,
        row.rolloutEndOrdinal,
        row.rolloutEndByteOffset,
      );
    }
    const insertProjection = history.prepare(
      [
        "INSERT INTO thread_history_projection_state (",
        "thread_id, next_rollout_byte_offset, next_rollout_ordinal",
        ") VALUES (?, ?, ?)",
      ].join(" "),
    );
    for (const row of historyProjections) {
      insertProjection.run(
        row.threadId,
        row.nextRolloutByteOffset,
        row.nextRolloutOrdinal,
      );
    }
    history.close();
  }

  return {
    root,
    codexHome,
    statePath,
    historyPath,
    rolloutPaths,
  };
}

function environmentFor(fixture) {
  return {
    ...process.env,
    HOME: fixture.root,
    USERPROFILE: fixture.root,
    HOMEDRIVE: "",
    HOMEPATH: fixture.root,
    CODEX_HOME: fixture.codexHome,
    CODEX_SQLITE_HOME: fixture.codexHome,
  };
}

function runScript(fixture, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: os.tmpdir(),
    env: environmentFor(fixture),
    encoding: "utf8",
  });
}

function runFromStdin(fixture, args = []) {
  return spawnSync(process.execPath, ["-", ...args], {
    cwd: os.tmpdir(),
    env: environmentFor(fixture),
    input: fs.readFileSync(scriptPath),
    encoding: "utf8",
  });
}

function readThreadProvider(fixture, id) {
  const state = new DatabaseSync(fixture.statePath, { readOnly: true });
  const row = state
    .prepare("SELECT model_provider FROM threads WHERE id = ?")
    .get(id);
  state.close();
  return row?.model_provider ?? null;
}

function readHistoryRows(fixture) {
  const history = new DatabaseSync(fixture.historyPath, { readOnly: true });
  const turns = history
    .prepare(
      "SELECT * FROM thread_turns ORDER BY thread_id, turn_id",
    )
    .all();
  const projections = history
    .prepare(
      "SELECT * FROM thread_history_projection_state ORDER BY thread_id",
    )
    .all();
  history.close();
  return {
    turns: turns.map((row) => ({ ...row })),
    projections: projections.map((row) => ({ ...row })),
  };
}

function backupDirectories(fixture) {
  const backupsDirectory = path.join(fixture.codexHome, "backups");
  if (!fs.existsSync(backupsDirectory)) return [];
  return fs
    .readdirSync(backupsDirectory)
    .filter((name) => name.startsWith("ocx-port-threads-"))
    .map((name) => path.join(backupsDirectory, name))
    .sort();
}

function removeFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function basicThread(id, dbProvider = "openai", settingsProvider = "openai") {
  const header = jsonLine(
    "2026-01-01T00:00:00.000Z",
    0,
    "session_meta",
    {
      id,
      model_provider: "openai",
      git: { branch: "main", dirty: false },
      preserved: { source: "fixture" },
    },
  );
  const settings = jsonLine(
    "2026-01-01T00:00:01.000Z",
    1,
    "event_msg",
    {
      type: "thread_settings_applied",
      thread_settings: { model_provider_id: settingsProvider },
    },
  );
  const userMessage = jsonLine(
    "2026-01-01T00:00:02.000Z",
    2,
    "event_msg",
    {
      type: "user_message",
      text: 'escaped "model_provider":"openai" text',
    },
  );

  return {
    id,
    dbProvider,
    header,
    contents: `${header}\n${settings}\n${userMessage}\n`,
  };
}

test("ports an openai thread by appending a canonical marker", () => {
  const thread = basicThread("thread-port-1");
  const fixture = makeFixture({ threads: [thread] });

  try {
    const before = Buffer.from(thread.contents);
    const result = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 0, result.stderr);
    const after = fs.readFileSync(fixture.rolloutPaths.get(thread.id));
    assert.ok(after.subarray(0, before.length).equals(before));
    const addedLines = after.subarray(before.length).toString("utf8").split("\n");
    assert.equal(addedLines.length, 2);
    assert.equal(addedLines[1], "");

    const marker = JSON.parse(addedLines[0]);
    assert.equal(marker.type, "session_meta");
    assert.equal(marker.ordinal, 3);
    assert.equal(marker.payload.id, thread.id);
    assert.equal(marker.payload.model_provider, "opencodex");
    assert.equal(Object.hasOwn(marker.payload, "git"), false);
    assert.deepEqual(marker.payload.preserved, { source: "fixture" });
    assert.equal(readThreadProvider(fixture, thread.id), "opencodex");
    assert.match(result.stdout, /Markers appended: 1/);
    const backup = backupDirectories(fixture)[0];
    const manifest = JSON.parse(
      fs.readFileSync(path.join(backup, "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.threads, [
      {
        id: thread.id,
        rolloutPath: fixture.rolloutPaths.get(thread.id),
        appendedMarker: true,
        dbUpdated: true,
        offsetsRepaired: false,
      },
    ]);
  } finally {
    removeFixture(fixture);
  }
});

test("rerunning the port is byte-identical and appends no marker", () => {
  const thread = basicThread("thread-port-rerun");
  const fixture = makeFixture({ threads: [thread] });

  try {
    const first = runScript(fixture, ["--ignore-running-codex"]);
    assert.equal(first.status, 0, first.stderr);
    const rolloutBefore = fs.readFileSync(fixture.rolloutPaths.get(thread.id));
    const stateBefore = fs.readFileSync(fixture.statePath);
    const backupsBefore = backupDirectories(fixture);

    const second = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      fs.readFileSync(fixture.rolloutPaths.get(thread.id)),
      rolloutBefore,
    );
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBefore);
    assert.deepEqual(backupDirectories(fixture), backupsBefore);
    assert.match(second.stdout, /Markers appended: 0/);
    assert.equal(readThreadProvider(fixture, thread.id), "opencodex");
  } finally {
    removeFixture(fixture);
  }
});

test("appends when the file still re-extracts openai even if the DB is opencodex", () => {
  const thread = basicThread("thread-file-wins", "opencodex", "openai");
  const fixture = makeFixture({ threads: [thread] });

  try {
    const result = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 0, result.stderr);
    const lines = fs
      .readFileSync(fixture.rolloutPaths.get(thread.id), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines.at(-1)).payload.model_provider, "opencodex");
    assert.equal(readThreadProvider(fixture, thread.id), "opencodex");
    assert.match(result.stdout, /Markers appended: 1/);
  } finally {
    removeFixture(fixture);
  }
});

test("updates a stale DB without appending when the file already ends at opencodex", () => {
  const thread = basicThread("thread-db-wins", "openai", "opencodex");
  const fixture = makeFixture({ threads: [thread] });

  try {
    const rolloutBefore = fs.readFileSync(fixture.rolloutPaths.get(thread.id));
    const result = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fs.readFileSync(fixture.rolloutPaths.get(thread.id)),
      rolloutBefore,
    );
    assert.equal(readThreadProvider(fixture, thread.id), "opencodex");
    assert.match(result.stdout, /Markers appended: 0/);
    assert.match(result.stdout, /DB rows updated: 1/);
  } finally {
    removeFixture(fixture);
  }
});

test("repairs non-fork offsets but leaves fork offsets untouched", () => {
  const nonFork = {
    id: "thread-offsets",
    dbProvider: "opencodex",
    contents: [
      jsonLine("2026-01-01T00:00:00.000Z", 0, "session_meta", {
        id: "thread-offsets",
        model_provider: "opencodex",
      }),
      jsonLine("2026-01-01T00:00:01.000Z", 1, "event_msg", {
        type: "user_message",
        text: "one",
      }),
      jsonLine("2026-01-01T00:00:02.000Z", 2, "event_msg", {
        type: "user_message",
        text: "two",
      }),
    ].join("\n") + "\n",
  };
  const fork = {
    id: "thread-fork-offsets",
    dbProvider: "opencodex",
    contents: [
      jsonLine("2026-01-01T00:00:00.000Z", 0, "session_meta", {
        id: "thread-fork-offsets",
        model_provider: "opencodex",
        history_base: { parent_thread_id: "parent" },
      }),
      jsonLine("2026-01-01T00:00:01.000Z", 1, "event_msg", {
        type: "user_message",
        text: "fork",
      }),
    ].join("\n") + "\n",
  };
  const fixture = makeFixture({
    threads: [nonFork, fork],
    historyTurns: [
      {
        threadId: "thread-offsets",
        turnId: "turn-1",
        rolloutOrdinal: 1,
        rolloutByteOffset: 135,
        rolloutEndOrdinal: 2,
        rolloutEndByteOffset: 373,
      },
      {
        threadId: "thread-fork-offsets",
        turnId: "turn-1",
        rolloutOrdinal: 1,
        rolloutByteOffset: 7,
        rolloutEndOrdinal: 1,
        rolloutEndByteOffset: 8,
      },
    ],
    historyProjections: [
      {
        threadId: "thread-offsets",
        nextRolloutByteOffset: 373,
        nextRolloutOrdinal: 3,
      },
      {
        threadId: "thread-fork-offsets",
        nextRolloutByteOffset: 8,
        nextRolloutOrdinal: 2,
      },
    ],
  });

  try {
    const result = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 0, result.stderr);
    const history = readHistoryRows(fixture);
    assert.deepEqual(history.turns[0], {
      thread_id: "thread-fork-offsets",
      turn_id: "turn-1",
      rollout_ordinal: 1,
      rollout_byte_offset: 7,
      rollout_end_ordinal: 1,
      rollout_end_byte_offset: 8,
    });
    assert.deepEqual(history.turns[1], {
      thread_id: "thread-offsets",
      turn_id: "turn-1",
      rollout_ordinal: 1,
      rollout_byte_offset: 138,
      rollout_end_ordinal: 2,
      rollout_end_byte_offset: 376,
    });
    assert.deepEqual(history.projections[0], {
      thread_id: "thread-fork-offsets",
      next_rollout_byte_offset: 8,
      next_rollout_ordinal: 2,
    });
    assert.deepEqual(history.projections[1], {
      thread_id: "thread-offsets",
      next_rollout_byte_offset: 376,
      next_rollout_ordinal: 3,
    });
    assert.match(result.stdout, /Offsets repaired in 1 tasks/);
    const backup = backupDirectories(fixture)[0];
    assert.ok(fs.existsSync(path.join(backup, "state_5.sqlite")));
    assert.ok(fs.existsSync(path.join(backup, "thread_history_1.sqlite")));
  } finally {
    removeFixture(fixture);
  }
});

test("dry-run does not change rollout or database bytes", () => {
  const thread = basicThread("thread-dry-run");
  const fixture = makeFixture({
    threads: [thread],
    historyTurns: [
      {
        threadId: thread.id,
        turnId: "turn-1",
        rolloutOrdinal: 1,
        rolloutByteOffset: 0,
        rolloutEndOrdinal: 2,
        rolloutEndByteOffset: 0,
      },
    ],
    historyProjections: [
      {
        threadId: thread.id,
        nextRolloutByteOffset: 0,
        nextRolloutOrdinal: 3,
      },
    ],
  });

  try {
    const rolloutBefore = fs.readFileSync(fixture.rolloutPaths.get(thread.id));
    const stateBefore = fs.readFileSync(fixture.statePath);
    const historyBefore = fs.readFileSync(fixture.historyPath);
    const result = runScript(fixture, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fs.readFileSync(fixture.rolloutPaths.get(thread.id)),
      rolloutBefore,
    );
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBefore);
    assert.deepEqual(fs.readFileSync(fixture.historyPath), historyBefore);
    assert.equal(backupDirectories(fixture).length, 0);
    assert.match(result.stdout, /Planned markers: 1/);
  } finally {
    removeFixture(fixture);
  }
});

test("skips a missing rollout without updating its provider", () => {
  const thread = basicThread("thread-missing-rollout");
  const fixture = makeFixture({ threads: [thread] });

  try {
    fs.unlinkSync(fixture.rolloutPaths.get(thread.id));
    const result = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readThreadProvider(fixture, thread.id), "openai");
    assert.equal(backupDirectories(fixture).length, 0);
    assert.match(result.stdout, /Skipped missing: 1/);
  } finally {
    removeFixture(fixture);
  }
});

test("revert appends openai only for threads in the selected backup manifest", () => {
  const thread = basicThread("thread-revert");
  const fixture = makeFixture({ threads: [thread] });

  try {
    const port = runScript(fixture, ["--ignore-running-codex"]);
    assert.equal(port.status, 0, port.stderr);
    const portBackup = backupDirectories(fixture)[0];

    const extra = basicThread("thread-outside-manifest", "opencodex", "opencodex");
    const extraPath = path.join(fixture.root, "outside.jsonl");
    fs.writeFileSync(extraPath, extra.contents, "utf8");
    const state = new DatabaseSync(fixture.statePath);
    state
      .prepare(
        "INSERT INTO threads (id, rollout_path, model_provider) VALUES (?, ?, ?)",
      )
      .run(extra.id, extraPath, extra.dbProvider);
    state.close();

    const extraBefore = fs.readFileSync(extraPath);
    const result = runScript(fixture, [
      "--revert",
      portBackup,
      "--ignore-running-codex",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const revertedLines = fs
      .readFileSync(fixture.rolloutPaths.get(thread.id), "utf8")
      .trimEnd()
      .split("\n");
    const marker = JSON.parse(revertedLines.at(-1));
    assert.equal(marker.ordinal, 4);
    assert.equal(marker.payload.model_provider, "openai");
    assert.equal(Object.hasOwn(marker.payload, "git"), false);
    assert.equal(readThreadProvider(fixture, thread.id), "openai");
    assert.deepEqual(fs.readFileSync(extraPath), extraBefore);
    assert.equal(readThreadProvider(fixture, extra.id), "opencodex");
  } finally {
    removeFixture(fixture);
  }
});

test("revert only selects tasks changed by the port", () => {
  const ported = basicThread("thread-revert-ported");
  const alreadyOpencodex = basicThread(
    "thread-revert-existing",
    "opencodex",
    "opencodex",
  );
  const fixture = makeFixture({ threads: [ported, alreadyOpencodex] });

  try {
    const existingBefore = fs.readFileSync(
      fixture.rolloutPaths.get(alreadyOpencodex.id),
    );
    const port = runScript(fixture, ["--ignore-running-codex"]);
    assert.equal(port.status, 0, port.stderr);
    const portBackup = backupDirectories(fixture)[0];

    const result = runScript(fixture, [
      "--revert",
      portBackup,
      "--ignore-running-codex",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readThreadProvider(fixture, alreadyOpencodex.id), "opencodex");
    assert.deepEqual(
      fs.readFileSync(fixture.rolloutPaths.get(alreadyOpencodex.id)),
      existingBefore,
    );
    assert.equal(readThreadProvider(fixture, ported.id), "openai");
    const revertedLines = fs
      .readFileSync(fixture.rolloutPaths.get(ported.id), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(JSON.parse(revertedLines.at(-1)).payload.model_provider, "openai");
  } finally {
    removeFixture(fixture);
  }
});

test("refuses to port without the opencodex provider table", () => {
  const thread = basicThread("thread-no-config");
  const fixture = makeFixture({
    threads: [thread],
    config: "[model_providers.other]\nname = \"Other\"\n",
  });

  try {
    const rolloutBefore = fs.readFileSync(fixture.rolloutPaths.get(thread.id));
    const stateBefore = fs.readFileSync(fixture.statePath);
    const result = runScript(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /model_providers\.opencodex/);
    assert.deepEqual(
      fs.readFileSync(fixture.rolloutPaths.get(thread.id)),
      rolloutBefore,
    );
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBefore);
    assert.equal(backupDirectories(fixture).length, 0);
  } finally {
    removeFixture(fixture);
  }
});

test("runs from stdin with node - and flags", () => {
  const thread = basicThread("thread-stdin");
  const fixture = makeFixture({ threads: [thread] });

  try {
    const result = runFromStdin(fixture, ["--ignore-running-codex"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readThreadProvider(fixture, thread.id), "opencodex");
    const lines = fs
      .readFileSync(fixture.rolloutPaths.get(thread.id), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(lines.length, 4);
  } finally {
    removeFixture(fixture);
  }
});
