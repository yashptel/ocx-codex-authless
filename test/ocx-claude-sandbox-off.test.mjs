import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "ocx-claude-sandbox-off.cjs");
const require = createRequire(import.meta.url);
const { resolveConfigLibraryDir } = require(scriptPath);

function makeFixture({ includeMeta = true } = {}) {
  const configLibraryDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ocx-claude-sandbox-off-"),
  );
  const profileFile = path.join(configLibraryDir, "abc.json");
  const originalProfile = {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "https://gateway.example.test",
    inferenceGatewayApiKey: "sk-test-secret",
    inferenceModels: [{ name: "m1" }],
    allowedWorkspaceFolders: ["/tmp/x"],
    blockReadsOutsideWorkingDirectories: true,
    coworkEgressAllowedHosts: ["github.com"],
  };
  const originalProfileBytes = JSON.stringify(originalProfile, null, 2);

  if (includeMeta) {
    fs.writeFileSync(
      path.join(configLibraryDir, "_meta.json"),
      JSON.stringify({
        appliedId: "abc",
        entries: [{ id: "abc", name: "opencodex" }],
      }),
    );
  }
  fs.writeFileSync(profileFile, originalProfileBytes, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    configLibraryDir,
    profileFile,
    originalProfileBytes,
    environment: {
      ...process.env,
      HOME: configLibraryDir,
      USERPROFILE: configLibraryDir,
      OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: configLibraryDir,
    },
  };
}

function runScript(fixture, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: os.tmpdir(),
    env: fixture.environment,
    encoding: "utf8",
  });
}

function runScriptFromStdin(fixture, args = []) {
  return spawnSync(process.execPath, ["-", ...args], {
    cwd: os.tmpdir(),
    env: fixture.environment,
    input: fs.readFileSync(scriptPath),
    encoding: "utf8",
  });
}

function backupFiles(fixture) {
  return fs
    .readdirSync(fixture.configLibraryDir)
    .filter((name) => name.startsWith("abc.json.bak-sandbox-off-"))
    .sort()
    .map((name) => path.join(fixture.configLibraryDir, name));
}

function removeFixture(fixture) {
  fs.rmSync(fixture.configLibraryDir, { recursive: true, force: true });
}

test("applies the sandbox change, preserves the profile, and is idempotent", () => {
  const fixture = makeFixture();

  try {
    const first = runScript(fixture);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.profileFile, "utf8")), {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://gateway.example.test",
      inferenceGatewayApiKey: "sk-test-secret",
      inferenceModels: [{ name: "m1" }],
      coworkEgressAllowedHosts: ["*"],
    });

    const backups = backupFiles(fixture);
    assert.equal(backups.length, 1);
    assert.equal(
      fs.readFileSync(backups[0], "utf8"),
      fixture.originalProfileBytes,
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fixture.profileFile).mode & 0o777, 0o600);
    }
    assert.ok(!first.stdout.includes("sk-test-secret"));
    assert.ok(!first.stderr.includes("sk-test-secret"));

    const second = runScript(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already off/);
    assert.equal(backupFiles(fixture).length, 1);
    assert.ok(!second.stdout.includes("sk-test-secret"));
    assert.ok(!second.stderr.includes("sk-test-secret"));
  } finally {
    removeFixture(fixture);
  }
});

test("revert restores the original profile bytes", () => {
  const fixture = makeFixture();

  try {
    const applied = runScript(fixture);
    assert.equal(applied.status, 0, applied.stderr);

    const reverted = runScript(fixture, ["--revert"]);
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(
      fs.readFileSync(fixture.profileFile, "utf8"),
      fixture.originalProfileBytes,
    );
    assert.match(reverted.stdout, /Claude Desktop sandbox profile restored/);
    assert.ok(!reverted.stdout.includes("sk-test-secret"));
    assert.ok(!reverted.stderr.includes("sk-test-secret"));
  } finally {
    removeFixture(fixture);
  }
});

test("revert works when the script is piped to node on stdin", () => {
  const fixture = makeFixture();

  try {
    const applied = runScript(fixture);
    assert.equal(applied.status, 0, applied.stderr);

    const reverted = runScriptFromStdin(fixture, ["--revert"]);
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(
      fs.readFileSync(fixture.profileFile, "utf8"),
      fixture.originalProfileBytes,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("revert restores a backup even when the current profile is corrupt", () => {
  const fixture = makeFixture();

  try {
    assert.equal(runScript(fixture).status, 0);
    fs.writeFileSync(fixture.profileFile, "{not json");

    const reverted = runScript(fixture, ["--revert"]);
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(
      fs.readFileSync(fixture.profileFile, "utf8"),
      fixture.originalProfileBytes,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("missing metadata tells the user to run the Desktop apply command", () => {
  const fixture = makeFixture({ includeMeta: false });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ocx claude desktop apply/);
    assert.ok(!result.stdout.includes("sk-test-secret"));
    assert.ok(!result.stderr.includes("sk-test-secret"));
  } finally {
    removeFixture(fixture);
  }
});

test("unknown arguments fail with their exact argument", () => {
  const fixture = makeFixture();

  try {
    const result = runScript(fixture, ["--nope"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument: --nope/);
  } finally {
    removeFixture(fixture);
  }
});

test("resolves Claude Desktop config library locations", () => {
  assert.equal(
    resolveConfigLibraryDir({
      env: {},
      platform: "darwin",
      home: "/Users/u",
    }),
    "/Users/u/Library/Application Support/Claude-3p/configLibrary",
  );
  assert.equal(
    resolveConfigLibraryDir({
      env: { XDG_CONFIG_HOME: "/x" },
      platform: "linux",
      home: "/home/u",
    }),
    "/x/Claude-3p/configLibrary",
  );
  assert.equal(
    resolveConfigLibraryDir({
      env: {},
      platform: "linux",
      home: "/home/u",
    }),
    "/home/u/.config/Claude-3p/configLibrary",
  );
  assert.equal(
    resolveConfigLibraryDir({
      env: { LOCALAPPDATA: "C:\\L" },
      platform: "win32",
      home: "C:\\Users\\u",
    }),
    "C:\\L\\Claude-3p\\configLibrary",
  );
  assert.equal(
    resolveConfigLibraryDir({
      env: { CLAUDE_USER_DATA_DIR: "/d" },
      platform: "linux",
      home: "/home/u",
    }),
    "/d/configLibrary",
  );
  assert.equal(
    resolveConfigLibraryDir({
      env: { OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: "/override" },
      platform: "darwin",
      home: "/ignored",
    }),
    "/override",
  );
});
