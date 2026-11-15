// Run after npm run build -w server. Uses the compiled API and a fresh temporary
// catalogue. No gateway download or game/tunnel process is permitted by this test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = await realpath(os.tmpdir());
const root = await mkdtemp(
  path.join(temporaryDirectory, "nodepilot-browser-api-"),
);
const dataDirectory = path.join(root, "data");
const serverId = "12345678-1234-4234-8234-123456789abc";
const otherId = "12345678-1234-4234-8234-123456789abd";
const bedrockId = "12345678-1234-4234-8234-123456789abe";
const modernId = "12345678-1234-4234-8234-123456789abf";
const pin = "browser-api-fixture-pin";
const password = "browser-fixture-password";
const replacementPassword = "browser-replacement-password";
const route = (id) => "/servers/" + id + "/browser-access";
let child;
let database;
let output = "";

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const running = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      running.kill("SIGKILL");
      reject(
        new Error("Isolated Browser Players backend did not stop gracefully."),
      );
    }, 15_000);
    running.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("Isolated Browser Players backend exited " + code));
    });
    if (process.platform === "win32") running.send("test-shutdown");
    else running.kill("SIGTERM");
  });
  child = undefined;
}

function privateFieldsAbsent(body) {
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /"[^"]*(?:password|hash|salt|token)[^"]*"\s*:/i);
  assert.equal(json.includes(password), false);
  assert.equal(json.includes(replacementPassword), false);
}

try {
  const port = await freePort();
  await mkdir(path.join(root, "server"), { recursive: true });
  await cp(
    path.join(projectRoot, "server", "dist"),
    path.join(root, "server", "dist"),
    { recursive: true },
  );
  await cp(
    path.join(projectRoot, "package.json"),
    path.join(root, "package.json"),
  );
  await cp(
    path.join(projectRoot, "server", "package.json"),
    path.join(root, "server", "package.json"),
  );
  await symlink(
    path.join(projectRoot, "node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(
    path.join(root, ".env"),
    [
      "NODEPILOT_HOST=127.0.0.1",
      "NODEPILOT_PORT=" + port,
      "NODEPILOT_PIN=" + pin,
      'NODEPILOT_DATA_DIR="' + dataDirectory.replaceAll("\\", "/") + '"',
      'NODEPILOT_CLIENT_DIST="' +
        path.join(root, "no-client").replaceAll("\\", "/") +
        '"',
      "NODEPILOT_LOG_LEVEL=error",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "run.mjs"),
    `
import { PlayitService } from './server/dist/services/playit-service.js';
import { UpdateService } from './server/dist/services/update-service.js';
import { BrowserDependencyService } from './server/dist/services/browser-dependencies.js';
import { JavaService } from './server/dist/services/java-service.js';
PlayitService.prototype.getStatus = async () => ({ installed: false, isManaged: false,
  binaryPath: null, version: null, isRunning: false, secretExists: false, secretPath: null, claimUrl: null });
UpdateService.prototype.start = () => {};
BrowserDependencyService.prototype.install = async () => { throw new Error('Unexpected browser dependency download'); };
JavaService.prototype.findUsable = async () => { throw new Error('Unexpected Java lookup during a rejected setup'); };
await import('./server/dist/index.js');
process.on('message', message => { if (message === 'test-shutdown') process.emit('SIGTERM'); });
`,
  );

  const { openDatabase } = await import(
    pathToFileURL(path.join(root, "server/dist/db.js")).href
  );
  const { ServerRepository } = await import(
    pathToFileURL(
      path.join(root, "server/dist/repositories/server-repository.js"),
    ).href
  );
  const { BrowserAccountRepository } = await import(
    pathToFileURL(
      path.join(root, "server/dist/repositories/browser-account-repository.js"),
    ).href
  );
  database = openDatabase(path.join(dataDirectory, "nodepilot.sqlite"));
  const repository = new ServerRepository(database);
  const fixtures = [
    {
      id: serverId,
      directory: "paper-fixture",
      software: "paper",
      version: "1.21.4",
    },
    {
      id: otherId,
      directory: "purpur-fixture",
      software: "purpur",
      version: "1.20.1",
    },
    {
      id: bedrockId,
      directory: "bedrock-fixture",
      software: "bedrock",
      version: "1.21.100",
    },
    {
      id: modernId,
      directory: "future-fixture",
      software: "paper",
      version: "26.1",
    },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const folder = path.join(dataDirectory, "servers", fixture.directory);
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "server.properties"),
      `server-port=${25565 + index}\nlevel-name=world\n`,
    );
    await writeFile(
      path.join(folder, "ops.json"),
      JSON.stringify([
        { name: "np_admin", uuid: "aaaaaaaa-bbbb-4444-8888-111111111111" },
      ]),
    );
    await writeFile(path.join(folder, "whitelist.json"), "[]");
    await writeFile(path.join(folder, "usercache.json"), "[]");
    repository.create({
      ...fixture,
      machineId: "local",
      name: fixture.directory,
      port: 25565 + index,
      memoryMb: 1024,
      eulaAccepted: true,
    });
    repository.markReady(fixture.id);
  }
  database.close();
  database = undefined;

  const baseUrl = "http://127.0.0.1:" + port;
  async function request(
    target,
    {
      method = "GET",
      body,
      authenticated = true,
      wrongPin = false,
      origin,
    } = {},
  ) {
    const response = await fetch(baseUrl + "/api" + target, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(authenticated
          ? { "x-nodepilot-pin": wrongPin ? "incorrect-fixture-pin" : pin }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  async function startChild() {
    output = "";
    child = spawn(process.execPath, [path.join(root, "run.mjs")], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-24_000);
    });
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-24_000);
    });
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error("Isolated Browser Players backend exited: " + output);
      try {
        if ((await request("/health")).status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Waiting for the isolated listener. */
      }
      await delay(100);
    }
    assert.equal(
      ready,
      true,
      "Isolated Browser Players backend did not start: " + output,
    );
  }
  await startChild();

  assert.equal(
    (await request(route(serverId), { authenticated: false })).status,
    401,
  );
  assert.equal(
    (await request(route(serverId), { wrongPin: true })).status,
    401,
  );
  assert.equal(
    (await request(route(serverId), { origin: "https://untrusted.example" }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(route(serverId) + "/accounts", {
        method: "POST",
        authenticated: false,
        body: { name: "alex", password },
      })
    ).status,
    401,
  );
  let result = await request(route(serverId));
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, false);
  assert.equal(result.body.enabled, false);
  assert.equal(result.body.status, "disabled");
  assert.equal(result.body.publicAddress, null);
  assert.equal(result.body.localAddress, null);
  assert.equal(result.body.capabilities.available, true);
  assert.equal(result.body.capabilities.verified, false);
  assert.deepEqual(result.body.logs, []);
  privateFieldsAbsent(result.body);
  result = await request(route(bedrockId));
  assert.equal(result.status, 200);
  assert.equal(result.body.capabilities.available, false);
  assert.ok(
    result.body.capabilities.reasons.some((reason) =>
      /Paper|Purpur/.test(reason),
    ),
  );
  assert.equal(
    (await request(route(bedrockId) + "/inspect", { method: "POST" })).status,
    422,
  );
  result = await request(route(modernId));
  assert.equal(result.body.capabilities.available, false);
  assert.ok(
    result.body.capabilities.reasons.some((reason) => /1\.21\.11/.test(reason)),
  );
  assert.equal(
    (
      await request(route(serverId) + "/setup", {
        method: "POST",
        body: { confirm: false, revision: "0".repeat(64) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(route(serverId) + "/enable", {
        method: "POST",
        body: { confirm: false },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(route(serverId) + "/disable", {
        method: "POST",
        body: { confirm: false },
      })
    ).status,
    400,
  );
  console.log(
    "PASS compiled Browser Players API enforces PIN, default disabled state, explicit confirmation, and availability gates",
  );

  const accountsRoute = route(serverId) + "/accounts";
  assert.equal(
    (
      await request(accountsRoute, {
        method: "POST",
        body: { name: "alex", password: "short" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(accountsRoute, {
        method: "POST",
        body: { name: "../alex", password },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(accountsRoute, {
        method: "POST",
        body: { name: "admin", password },
      })
    ).status,
    409,
  );
  result = await request(accountsRoute, {
    method: "POST",
    body: { name: "alex", password },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const account = result.body.account;
  assert.equal(account.name, "np_alex");
  assert.match(account.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(account.serverId, serverId);
  privateFieldsAbsent(result.body);
  assert.equal(
    (
      await request(accountsRoute, {
        method: "POST",
        body: { name: "ALEX", password },
      })
    ).status,
    409,
  );
  result = await request(accountsRoute);
  assert.deepEqual(result.body.accounts, [account]);
  privateFieldsAbsent(result.body);
  assert.deepEqual(
    (await request(route(otherId) + "/accounts")).body.accounts,
    [],
  );
  assert.equal(
    (
      await request(route(otherId) + "/accounts/" + account.id + "/password", {
        method: "POST",
        body: { password: replacementPassword },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(route(otherId) + "/accounts/" + account.id, {
        method: "DELETE",
      })
    ).status,
    404,
  );

  database = openDatabase(path.join(dataDirectory, "nodepilot.sqlite"));
  const accountRepository = new BrowserAccountRepository(database);
  assert.deepEqual(
    await accountRepository.verify(serverId, account.name, password),
    { name: account.name, uuid: account.uuid },
  );
  assert.equal(
    await accountRepository.verify(otherId, account.name, password),
    null,
  );
  result = await request(accountsRoute + "/" + account.id + "/password", {
    method: "POST",
    body: { password: replacementPassword },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.account.uuid, account.uuid);
  privateFieldsAbsent(result.body);
  assert.equal(
    await accountRepository.verify(serverId, account.name, password),
    null,
  );
  assert.deepEqual(
    await accountRepository.verify(serverId, account.name, replacementPassword),
    { name: account.name, uuid: account.uuid },
  );
  assert.equal(
    (await request(accountsRoute + "/" + account.id, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(
    await accountRepository.verify(serverId, account.name, replacementPassword),
    null,
  );
  result = await request(accountsRoute);
  assert.ok(result.body.accounts[0].revokedAt);
  privateFieldsAbsent(result.body);
  console.log(
    "PASS real account APIs preserve stable identity, isolate servers, reject operator collisions, and apply password reset/revocation",
  );

  new ServerRepository(database).setStatus(serverId, "running");
  result = await request(route(serverId) + "/inspect", { method: "POST" });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, "server_active");
  result = await request(accountsRoute, { method: "POST", body: { name: "sleeping", password } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, "server_active");
  assert.equal(accountRepository.list(serverId).length, 1);
  new ServerRepository(database).setStatus(serverId, "offline");
  result = await request(route(serverId));
  assert.equal(result.body.status, "disabled");
  assert.deepEqual(result.body.logs, []);
  privateFieldsAbsent(result.body);
  assert.equal(
    (
      await readFile(
        path.join(
          dataDirectory,
          "servers",
          "paper-fixture",
          "server.properties",
        ),
        "utf8",
      )
    ).includes("server-port=25565"),
    true,
  );
  database.close();
  database = undefined;
  console.log(
    "PASS inspecting an active server is rejected before Java discovery or gateway downloads",
  );

  await stopChild();
  const environmentPath = path.join(root, ".env");
  const environment = await readFile(environmentPath, "utf8");
  await writeFile(
    environmentPath,
    environment.replace(/^NODEPILOT_PIN=.*$/m, "NODEPILOT_PIN="),
  );
  await startChild();
  assert.equal(
    (await request("/auth/status", { authenticated: false })).body.hasPin,
    false,
  );
  assert.equal(
    (await request(route(serverId), { authenticated: false })).status,
    200,
  );
  result = await request(route(serverId), {
    authenticated: false,
    origin: "https://untrusted.example",
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "untrusted_origin");
  assert.equal(
    (
      await request(accountsRoute, {
        method: "POST",
        body: { name: "remote", password },
        authenticated: false,
        origin: "https://untrusted.example",
      })
    ).status,
    403,
  );
  console.log(
    "PASS untrusted browser origins are rejected even when the local panel has no PIN",
  );
  await stopChild();
} catch (error) {
  if (output)
    console.error("Isolated Browser Players backend output:\n" + output);
  throw error;
} finally {
  if (database) database.close();
  await stopChild();
  assert.equal(path.dirname(await realpath(root)), temporaryDirectory);
  assert.ok(path.basename(root).startsWith("nodepilot-browser-api-"));
  await rm(root, { recursive: true, force: true });
}
