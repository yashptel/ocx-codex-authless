import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "ocx-codex-authless.cjs");
const require = createRequire(import.meta.url);
const { run } = require(scriptPath);

function makeFixture({ config, token, envContents } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-codex-authless-"));
  const ocxHome = path.join(root, "opencodex");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(ocxHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const configContents =
    config ??
    [
      "[model_providers.opencodex]",
      'name = "OCX"',
      "requires_openai_auth = true",
      'env_key = "OLD_KEY"',
      "",
    ].join("\n");

  fs.writeFileSync(path.join(ocxHome, "service-api-token"), `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.writeFileSync(path.join(codexHome, "config.toml"), configContents);
  if (envContents !== undefined) {
    fs.writeFileSync(path.join(codexHome, ".env"), envContents);
  }

  return {
    root,
    ocxHome,
    codexHome,
    tokenFile: path.join(ocxHome, "service-api-token"),
    configFile: path.join(codexHome, "config.toml"),
    envFile: path.join(codexHome, ".env"),
  };
}

function isolatedEnvironment(fixture) {
  return {
    ...process.env,
    HOME: fixture.root,
    USERPROFILE: fixture.root,
    HOMEDRIVE: "",
    HOMEPATH: fixture.root,
    CODEX_HOME: fixture.codexHome,
    OPENCODEX_HOME: fixture.ocxHome,
  };
}

function runScript(fixture) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: os.tmpdir(),
    env: isolatedEnvironment(fixture),
    encoding: "utf8",
  });
}

function runScriptFromStdin(fixture) {
  return spawnSync(process.execPath, [], {
    cwd: os.tmpdir(),
    env: isolatedEnvironment(fixture),
    input: fs.readFileSync(scriptPath),
    encoding: "utf8",
  });
}

function backupFiles(directory, prefix) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(`${prefix}.bak-`))
    .map((name) => path.join(directory, name));
}

function removeFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("patches only the exact provider section and backs up changed files", () => {
  const token = "test-token-never-print-this";
  const originalConfig = [
    "# unrelated settings",
    "[model_providers.other]",
    "requires_openai_auth = true",
    'env_key = "OTHER_KEY"',
    "",
    "[model_providers.opencodex]",
    'name = "OCX"',
    "requires_openai_auth = true",
    'env_key = "OLD_KEY"',
    "",
    "[model_providers.opencodex.extra]",
    "requires_openai_auth = true",
    'env_key = "NESTED_KEY"',
    "",
    "[model_providers.after]",
    "requires_openai_auth = true",
    'env_key = "AFTER_KEY"',
    "",
  ].join("\n");
  const originalEnv = "# preserved\nOTHER=value\nOPENCODEX_API_AUTH_TOKEN=old-token\n\n";
  const fixture = makeFixture({
    config: originalConfig,
    token,
    envContents: originalEnv,
  });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));

    const updatedConfig = fs.readFileSync(fixture.configFile, "utf8");
    assert.match(
      updatedConfig,
      /\[model_providers\.opencodex\]\nname = "OCX"\nrequires_openai_auth = false\nenv_key = "OPENCODEX_API_AUTH_TOKEN"\n\n\[model_providers\.opencodex\.extra\]/,
    );
    assert.match(
      updatedConfig,
      /\[model_providers\.other\]\nrequires_openai_auth = true\nenv_key = "OTHER_KEY"/,
    );
    assert.match(
      updatedConfig,
      /\[model_providers\.opencodex\.extra\]\nrequires_openai_auth = true\nenv_key = "NESTED_KEY"/,
    );
    assert.match(
      updatedConfig,
      /\[model_providers\.after\]\nrequires_openai_auth = true\nenv_key = "AFTER_KEY"/,
    );

    const updatedEnv = fs.readFileSync(fixture.envFile, "utf8");
    assert.equal(
      updatedEnv,
      `# preserved\nOTHER=value\n${"OPENCODEX_API_AUTH_TOKEN"}='${token}'\n`,
    );
    assert.ok(!updatedEnv.includes("old-token"));

    const configBackups = backupFiles(fixture.codexHome, "config.toml");
    const envBackups = backupFiles(fixture.codexHome, ".env");
    assert.equal(configBackups.length, 1);
    assert.equal(envBackups.length, 1);
    assert.equal(fs.readFileSync(configBackups[0], "utf8"), originalConfig);
    assert.equal(fs.readFileSync(envBackups[0], "utf8"), originalEnv);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fixture.envFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(envBackups[0]).mode & 0o777, 0o600);
    }
  } finally {
    removeFixture(fixture);
  }
});

test("preserves CRLF files and does not duplicate the token on rerun", () => {
  const token = "crlf-token-never-print-this";
  const originalConfig =
    '[model_providers.opencodex]\r\nrequires_openai_auth = true\r\n\r\n[model_providers.other]\r\nrequires_openai_auth = true\r\n';
  const fixture = makeFixture({
    config: originalConfig,
    token,
    envContents: "OTHER=value\r\nOPENCODEX_API_AUTH_TOKEN=old\r\n",
  });

  try {
    const first = runScript(fixture);
    const second = runScript(fixture);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(!first.stdout.includes(token));
    assert.ok(!second.stdout.includes(token));

    const updatedConfig = fs.readFileSync(fixture.configFile, "utf8");
    const updatedEnv = fs.readFileSync(fixture.envFile, "utf8");
    assert.ok(updatedConfig.includes("\r\n"));
    assert.ok(updatedEnv.includes("\r\n"));
    assert.equal(
      updatedEnv.split("OPENCODEX_API_AUTH_TOKEN=").length - 1,
      1,
    );
    assert.equal(
      backupFiles(fixture.codexHome, "config.toml").length,
      2,
    );
    assert.equal(backupFiles(fixture.codexHome, ".env").length, 2);
  } finally {
    removeFixture(fixture);
  }
});

test("runs when piped to node from stdin", () => {
  const token = "stdin-token-never-print-this";
  const fixture = makeFixture({ token });

  try {
    const result = runScriptFromStdin(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    assert.match(
      fs.readFileSync(fixture.configFile, "utf8"),
      /requires_openai_auth = false/,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("ignores table-looking lines inside basic and literal multiline strings", () => {
  const token = "multiline-section-token";
  const originalConfig = [
    "[metadata]",
    'basic = """',
    "[model_providers.opencodex]",
    "requires_openai_auth = true",
    'env_key = "FROM_BASIC_STRING"',
    '"""',
    "literal = '''",
    "[model_providers.other]",
    "requires_openai_auth = true",
    "'''",
    "",
    "[model_providers.opencodex]",
    'description = """',
    "[model_providers.fake]",
    "requires_openai_auth = true",
    'env_key = "FROM_TARGET_STRING"',
    '"""',
    "requires_openai_auth = true",
    'env_key = "OLD_KEY"',
    "",
    "[model_providers.after]",
    "requires_openai_auth = true",
    'env_key = "AFTER_KEY"',
    "",
  ].join("\n");
  const fixture = makeFixture({ config: originalConfig, token });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(token));
    const updatedConfig = fs.readFileSync(fixture.configFile, "utf8");
    assert.match(
      updatedConfig,
      /basic = """\n\[model_providers\.opencodex\]\nrequires_openai_auth = true\nenv_key = "FROM_BASIC_STRING"\n"""/,
    );
    assert.match(
      updatedConfig,
      /literal = '''\n\[model_providers\.other\]\nrequires_openai_auth = true\n'''/,
    );
    assert.match(
      updatedConfig,
      /\[model_providers\.opencodex\]\ndescription = """\n\[model_providers\.fake\]\nrequires_openai_auth = true\nenv_key = "FROM_TARGET_STRING"\n"""\nrequires_openai_auth = false\nenv_key = "OPENCODEX_API_AUTH_TOKEN"/,
    );
    assert.match(
      updatedConfig,
      /\[model_providers\.after\]\nrequires_openai_auth = true\nenv_key = "AFTER_KEY"/,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("quotes dotenv-significant token characters without printing the token", () => {
  const token = 'token with spaces # equals = "quotes" \\slashes $dollar';
  const fixture = makeFixture({ token });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    assert.equal(
      fs.readFileSync(fixture.envFile, "utf8"),
      `OPENCODEX_API_AUTH_TOKEN='${token}'\n`,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("uses a double-quoted dotenv value when the token contains a single quote", () => {
  const token = "token's # equals = $dollar";
  const fixture = makeFixture({ token });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    assert.equal(
      fs.readFileSync(fixture.envFile, "utf8"),
      `OPENCODEX_API_AUTH_TOKEN="${token}"\n`,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("rejects an ambiguously quoted token before writing files", () => {
  const token = "token's\\ambiguous\"value";
  const originalConfig =
    '[model_providers.opencodex]\nrequires_openai_auth = true\nenv_key = "OLD"\n';
  const fixture = makeFixture({ config: originalConfig, token });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be serialized safely/);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    assert.equal(fs.readFileSync(fixture.configFile, "utf8"), originalConfig);
    assert.equal(fs.existsSync(fixture.envFile), false);
  } finally {
    removeFixture(fixture);
  }
});

test("adds missing settings inside the target section only", () => {
  const token = "missing-settings-token-never-print-this";
  const originalConfig = [
    "[model_providers.other]",
    "requires_openai_auth = true",
    "",
    "[model_providers.opencodex]",
    'name = "OCX"',
    "",
    "[model_providers.after]",
    "requires_openai_auth = true",
    'env_key = "AFTER_KEY"',
    "",
  ].join("\n");
  const fixture = makeFixture({ config: originalConfig, token });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(token));
    assert.match(
      fs.readFileSync(fixture.configFile, "utf8"),
      /\[model_providers\.opencodex\]\nname = "OCX"\nrequires_openai_auth = false\nenv_key = "OPENCODEX_API_AUTH_TOKEN"\n\n\[model_providers\.after\]/,
    );
    assert.match(
      fs.readFileSync(fixture.configFile, "utf8"),
      /\[model_providers\.other\]\nrequires_openai_auth = true/,
    );
  } finally {
    removeFixture(fixture);
  }
});

test("fails before writing when the exact provider section is absent", () => {
  const token = "missing-section-token-never-print-this";
  const originalConfig =
    '[model_providers.other]\nrequires_openai_auth = true\nenv_key = "OTHER"\n';
  const fixture = makeFixture({ config: originalConfig, token });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not find \[model_providers\.opencodex\]/);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    assert.equal(fs.readFileSync(fixture.configFile, "utf8"), originalConfig);
    assert.equal(fs.existsSync(fixture.envFile), false);
    assert.equal(backupFiles(fixture.codexHome, "config.toml").length, 0);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects a token containing an embedded newline without writing files", () => {
  const token = "multiline-token-never-print-this";
  const fixture = makeFixture({
    token: `${token}\nsecond-line`,
    config: "[model_providers.opencodex]\nrequires_openai_auth = true\n",
  });

  try {
    const result = runScript(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /control character/);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
    assert.equal(
      fs.readFileSync(fixture.configFile, "utf8"),
      "[model_providers.opencodex]\nrequires_openai_auth = true\n",
    );
    assert.equal(fs.existsSync(fixture.envFile), false);
  } finally {
    removeFixture(fixture);
  }
});

test("rolls back config and env when the env write fails", () => {
  const token = "rollback-write-token";
  const originalConfig =
    '[model_providers.opencodex]\nrequires_openai_auth = true\nenv_key = "OLD"\n';
  const originalEnv = "KEEP=1\n";
  const fixture = makeFixture({
    config: originalConfig,
    token,
    envContents: originalEnv,
  });
  const originalWriteFileSync = fs.writeFileSync;
  let injectedFailure = false;

  fs.writeFileSync = (filePath, ...args) => {
    if (path.resolve(filePath) === fixture.envFile && !injectedFailure) {
      injectedFailure = true;
      originalWriteFileSync.call(fs, filePath, ...args);
      throw new Error("simulated env write failure");
    }
    return originalWriteFileSync.call(fs, filePath, ...args);
  };

  try {
    assert.throws(
      () => run(isolatedEnvironment(fixture)),
      /Could not write file/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  try {
    assert.equal(injectedFailure, true);
    assert.equal(fs.readFileSync(fixture.configFile, "utf8"), originalConfig);
    assert.equal(fs.readFileSync(fixture.envFile, "utf8"), originalEnv);
  } finally {
    removeFixture(fixture);
  }
});

test("rolls back config and removes a new env file after verification failure", () => {
  const token = "rollback-verification-token";
  const originalConfig =
    '[model_providers.opencodex]\nrequires_openai_auth = true\nenv_key = "OLD"\n';
  const fixture = makeFixture({ config: originalConfig, token });
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  let configWritten = false;

  fs.writeFileSync = (filePath, ...args) => {
    const result = originalWriteFileSync.call(fs, filePath, ...args);
    if (path.resolve(filePath) === fixture.configFile) configWritten = true;
    return result;
  };
  fs.readFileSync = (filePath, ...args) => {
    if (configWritten && path.resolve(filePath) === fixture.configFile) {
      return originalConfig;
    }
    return originalReadFileSync.call(fs, filePath, ...args);
  };

  try {
    assert.throws(
      () => run(isolatedEnvironment(fixture)),
      /Verification failed after writing the configuration/,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
  }

  try {
    assert.equal(configWritten, true);
    assert.equal(fs.readFileSync(fixture.configFile, "utf8"), originalConfig);
    assert.equal(fs.existsSync(fixture.envFile), false);
  } finally {
    removeFixture(fixture);
  }
});

test("package metadata exposes only the built-in test command", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );

  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts.test, "node --test");
  assert.deepEqual(packageJson.dependencies, undefined);
  assert.deepEqual(packageJson.devDependencies, undefined);
});
