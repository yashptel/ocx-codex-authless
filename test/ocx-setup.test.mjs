import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "ocx-setup.cjs");
const PAIRING_CODE = "ocx_pair_test-code";
const NEW_TOKEN = "new-hub-key";

const FAKE_OCX = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const statePath = process.env.FAKE_OCX_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
console.error("opencode-free support was removed because every free model now returns 403 permission_denied under OpenCode's upstream free-tier gate (#7255); the entry and dependent references are disabled. Use opencode-go, or another provider such as opencode-zen or openrouter.");
state.calls.push(args.join(" "));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const configFile = process.env.CODEX_HOME + "/config.toml";
const journalFile = process.env.CODEX_HOME + "/opencodex-journal.json";

if (args[0] === "--version") { console.log("opencodex " + state.version); save(); return; }
if (args.join(" ") === "connect status --json") {
  console.log(state.brokenStatus ? "Connection: connected" : JSON.stringify({ state: state.connection })); save(); return;
}
if (args[0] === "disconnect") {
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(configFile)).digest("hex");
  save();
  if (hash !== journal.injectedConfigHash) {
    console.error("Error: disconnect refused: Codex journal restore was partial");
    process.exit(1);
  }
  state.connection = "disconnected"; save(); return;
}
if (args[0] === "connect") {
  if (state.connection !== "disconnected") { console.error("Error: client_connection_changed"); save(); process.exit(1); }
  const code = fs.readFileSync(0, "utf8").trim();
  state.stdinCode = code;
  if (code !== state.expectedCode) { save(); console.error("Error: pairing code rejected"); process.exit(1); }
  fs.writeFileSync(process.env.OPENCODEX_HOME + "/service-api-token", state.issuedToken + "\\n");
  fs.writeFileSync(configFile, fs.readFileSync(configFile, "utf8") +
    '\\n[model_providers.opencodex]\\nbase_url = "' + args[1] + '/v1"\\nrequires_openai_auth = true\\nenv_key = "OPENCODEX_API_AUTH_TOKEN"\\n');
  state.connection = "connected"; save(); return;
}
save();
process.exit(2);
`;

function makeFixture({ acceptedToken = NEW_TOKEN } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-setup-"));
  const bin = path.join(root, "bin");
  const ocxHome = path.join(root, "opencodex");
  const codexHome = path.join(root, "codex");
  for (const dir of [bin, ocxHome, codexHome]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(bin, "ocx"), FAKE_OCX, { mode: 0o755 });
  fs.writeFileSync(path.join(ocxHome, "service-api-token"), "old-hub-key\n", { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, ".env"), "OPENCODEX_API_AUTH_TOKEN='old-hub-key'\n", { mode: 0o600 });

  const injected = 'model = "gpt-6-astra"\n';
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-luna"\n');
  fs.writeFileSync(
    path.join(codexHome, "opencodex-journal.json"),
    JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(injected).toString("base64"),
      injectedConfigHash: crypto.createHash("sha256").update(injected).digest("hex"),
    }),
  );

  const statePath = path.join(root, "ocx-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    version: "2.92.0",
    connection: "connected",
    expectedCode: PAIRING_CODE,
    issuedToken: NEW_TOKEN,
    calls: [],
  }));

  return { root, bin, ocxHome, codexHome, statePath, acceptedToken };
}

async function withHub(acceptedToken, fn) {
  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", version: "2.92.0" }));
      return;
    }
    if (request.url === "/v1/catalog") {
      response.statusCode = request.headers.authorization === `Bearer ${acceptedToken}` ? 200 : 401;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function runSetup(fixture, args, { viaStdin = false } = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fixture.root,
    USERPROFILE: fixture.root,
    CODEX_HOME: fixture.codexHome,
    OPENCODEX_HOME: fixture.ocxHome,
    FAKE_OCX_STATE: fixture.statePath,
  };
  const child = spawn(process.execPath, viaStdin ? ["-", ...args] : [scriptPath, ...args], {
    cwd: viaStdin ? projectRoot : os.tmpdir(),
    env,
  });
  if (viaStdin) child.stdin.end(fs.readFileSync(scriptPath));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

const readState = (fixture) => JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
const readCodex = (fixture, name) => fs.readFileSync(path.join(fixture.codexHome, name), "utf8");

test("replaces a stale connection, keeps edited Codex config, and installs the new key", async () => {
  const fixture = makeFixture();
  const result = await withHub(NEW_TOKEN, (hub) =>
    runSetup(fixture, ["--pairing-code", PAIRING_CODE, "--hub", hub], { viaStdin: true }));

  assert.equal(result.status, 0, result.stderr);
  const state = readState(fixture);
  assert.equal(state.connection, "connected");
  assert.equal(state.stdinCode, PAIRING_CODE);
  assert.ok(state.calls.every((call) => !call.includes(PAIRING_CODE)), "pairing code never in argv");
  assert.deepEqual(state.calls.filter((call) => call.startsWith("disconnect")), [
    "disconnect --keep-catalog",
    "disconnect --keep-catalog",
  ]);

  assert.match(readCodex(fixture, "config.toml"), /^model = "gpt-6-luna"$/m);
  assert.match(readCodex(fixture, "config.toml"), /requires_openai_auth = false/);
  assert.equal(readCodex(fixture, ".env"), `OPENCODEX_API_AUTH_TOKEN='${NEW_TOKEN}'\n`);
  assert.ok(fs.readdirSync(fixture.codexHome).some((name) => name.startsWith("opencodex-journal.json.bak-")));
  assert.ok(!result.stdout.includes(NEW_TOKEN) && !result.stdout.includes(PAIRING_CODE));
  assert.match(result.stdout, /\[5\/5\] Give Codex Desktop the new key/);
});

test("stops before touching Codex when the hub rejects the new key", async () => {
  const fixture = makeFixture();
  const result = await withHub("some-other-key", (hub) =>
    runSetup(fixture, ["--pairing-code", PAIRING_CODE, "--hub", hub]));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /hub rejected this machine's new key \(HTTP 401\)/);
  assert.equal(readCodex(fixture, ".env"), "OPENCODEX_API_AUTH_TOKEN='old-hub-key'\n");
});

test("requires a pairing code", async () => {
  const fixture = makeFixture();
  const result = await runSetup(fixture, []);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--pairing-code is required/);
  assert.deepEqual(readState(fixture).calls, []);
});

test("stops when the connection state cannot be read", async () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.statePath, JSON.stringify({ ...readState(fixture), brokenStatus: true }));
  const result = await withHub(NEW_TOKEN, (hub) =>
    runSetup(fixture, ["--pairing-code", PAIRING_CODE, "--hub", hub]));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not read the ocx connection state/);
  assert.ok(readState(fixture).calls.every((call) => !call.startsWith("connect ") || call === "connect status --json"));
});
