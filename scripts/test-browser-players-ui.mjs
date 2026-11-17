// Run after npm run build. API fixtures exercise panel behavior without
// downloading gateways, starting Minecraft, or changing real player accounts.
import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.NODEPILOT_PLAYWRIGHT_MODULE ?? "playwright",
);
const dist = fileURLToPath(new URL("../client/dist/", import.meta.url));
const fixture = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const target =
    pathname.startsWith("/assets/") || pathname === "/update-recovery.js"
      ? path.resolve(dist, "." + pathname)
      : path.join(dist, "index.html");
  if (!target.startsWith(dist) || !existsSync(target))
    return response.writeHead(404).end();
  response.setHeader(
    "Content-Type",
    {
      ".js": "application/javascript",
      ".css": "text/css",
      ".html": "text/html",
    }[path.extname(target)] ?? "application/octet-stream",
  );
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const serverId = "22222222-3333-4444-5555-666666666666";
const apiBase = `/api/servers/${serverId}/browser-access`;
const accountId = "aaaaaaaa-bbbb-4444-8888-111111111111";
const preview = {
  revision: "fixture-revision",
  changes: [
    "Move the Minecraft backend to a private listener.",
    "Delegate normal Java authentication to the managed proxy.",
  ],
  warnings: ["Browser players use separate local identities."],
};
const initial = {
  serverId,
  configured: false,
  enabled: false,
  status: "disabled",
  phase: null,
  progressPercent: null,
  publicAddress: null,
  localAddress: null,
  capabilities: {
    available: true,
    reasons: [],
    targetClients: ["Eaglercraft 1.8", "Eaglercraft 1.12.2"],
    verified: false,
  },
  versions: {},
  logs: [],
  error: null,
};
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NODEPILOT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.NODEPILOT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const scenario of ["workflow", "unsupported", "running"]) {
    const context = await browser.newContext({
      viewport:
        scenario === "workflow"
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
    });
    try {
      await context.addInitScript(() => {
        window.__copiedBrowserAddress = null;
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (value) => {
              window.__copiedBrowserAddress = value;
            },
          },
        });
      });
      let status = structuredClone(initial);
      let accounts = [];
      let inspectRequests = 0;
      let setupRequests = 0;
      let resetRequests = 0;
      let revokeRequests = 0;
      let enableRequests = 0;
      let failedInspect = true;
      if (scenario === "unsupported")
        status.capabilities = {
          available: false,
          reasons: [
            "Bedrock uses UDP. This browser gateway requires Paper or Purpur.",
          ],
          targetClients: [],
          verified: false,
        };
      const errors = [];
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        let body = {};
        if (url.pathname === "/api/auth/status")
          body = { hasPin: false, authenticated: true };
        else if (url.pathname === "/api/network")
          body = {
            host: "127.0.0.1",
            port: 7420,
            isNetworkVisible: false,
            addresses: [],
            accessUrls: [],
            hasPin: false,
          };
        else if (url.pathname === "/api/host/updates")
          body = { update: { status: "idle", currentVersion: "test" } };
        else if (url.pathname === "/api/servers") body = { servers: [] };
        else if (url.pathname === `/api/servers/${serverId}`)
          body = {
            server: {
              id: serverId,
              name: "Browser test",
              software: scenario === "unsupported" ? "bedrock" : "paper",
              version: "1.21.4",
              port: 25565,
              status: scenario === "running" ? "running" : "offline",
              installState: "ready",
            },
          };
        else if (url.pathname === apiBase) {
          if (status.status === "preparing")
            status = {
              ...status,
              status: "ready",
              phase: "Review configuration changes",
              progressPercent: 100,
              preview,
              versions: { velocity: "fixture" },
            };
          body = status;
        } else if (url.pathname === `${apiBase}/inspect`) {
          assert.equal(method, "POST");
          inspectRequests += 1;
          if (failedInspect) {
            failedInspect = false;
            await route.fulfill({
              status: 502,
              contentType: "application/json",
              body: JSON.stringify({
                error: "download_failed",
                message:
                  "The component download failed. Check your connection and retry.",
              }),
            });
            return;
          }
          status = {
            ...status,
            status: "preparing",
            phase: "Downloading gateway components",
            progressPercent: 20,
          };
          body = status;
        } else if (url.pathname === `${apiBase}/setup`) {
          assert.equal(method, "POST");
          assert.deepEqual(request.postDataJSON(), {
            confirm: true,
            revision: preview.revision,
          });
          setupRequests += 1;
          status = {
            ...status,
            configured: true,
            status: "ready",
            preview: undefined,
            phase: null,
            progressPercent: null,
          };
          body = status;
        } else if (url.pathname === `${apiBase}/enable`) {
          assert.equal(method, "POST");
          assert.deepEqual(request.postDataJSON(), { confirm: true });
          enableRequests += 1;
          if (enableRequests === 1) {
            status = {
              ...status,
              enabled: true,
              status: "error",
              error: "The public tunnel could not start. Retry the gateway.",
            };
            await route.fulfill({
              status: 202,
              contentType: "application/json",
              body: JSON.stringify(status),
            });
            return;
          }
          status = {
            ...status,
            enabled: true,
            status: "running",
            error: null,
            publicAddress: "wss://nodepilot-fixture.trycloudflare.com",
            logs: [
              {
                timestamp: new Date().toISOString(),
                message: "Gateway listening.",
              },
            ],
          };
          body = status;
        } else if (url.pathname === `${apiBase}/disable`) {
          assert.equal(method, "POST");
          assert.deepEqual(request.postDataJSON(), { confirm: true });
          status = {
            ...status,
            enabled: false,
            configured: false,
            status: "disabled",
            publicAddress: null,
          };
          body = status;
        } else if (url.pathname === `${apiBase}/settings`) {
          assert.equal(method, "POST");
          const input = request.postDataJSON();
          assert.equal(input.confirm, true);
          assert.equal(typeof input.requirePassword, "boolean");
          status = { ...status, requirePassword: input.requirePassword };
          body = status;
        } else if (url.pathname === `${apiBase}/accounts`) {
          if (method === "POST") {
            assert.deepEqual(request.postDataJSON(), {
              name: "alex",
              password: "1234",
            });
            accounts = [
              {
                id: accountId,
                name: "np_alex",
                uuid: "bbbbbbbb-cccc-4444-9999-111111111111",
                createdAt: new Date().toISOString(),
                revokedAt: null,
              },
            ];
            body = { account: accounts[0] };
          } else body = { accounts };
        } else if (
          url.pathname === `${apiBase}/accounts/${accountId}/password`
        ) {
          assert.equal(method, "POST");
          assert.deepEqual(request.postDataJSON(), {
            password: "abcd",
          });
          resetRequests += 1;
          body = { account: accounts[0] };
        } else if (url.pathname === `${apiBase}/accounts/${accountId}`) {
          assert.equal(method, "DELETE");
          revokeRequests += 1;
          accounts = [{ ...accounts[0], revokedAt: new Date().toISOString() }];
          body = { ok: true };
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(`${origin}/servers/${serverId}/browser-access`);
      await page
        .getByRole("heading", { name: "Browser Players", exact: true })
        .waitFor();
      const setup = page.getByRole("button", { name: "Set Up", exact: true });
      if (scenario === "unsupported") {
        await page.getByText("Bedrock uses UDP.", { exact: false }).waitFor();
        assert.equal(await setup.isDisabled(), true);
        assert.equal(
          await page
            .getByRole("button", { name: "Create Account", exact: true })
            .count(),
          0,
        );
      } else if (scenario === "running") {
        await page
          .getByText("Stop Minecraft before setting up, enabling, or disabling browser access.", { exact: true })
          .waitFor();
        assert.equal(await setup.isDisabled(), true);
        assert.equal(setupRequests, 0);
        assert.equal(
          await page
            .getByRole("button", { name: "Create Account", exact: true })
            .isDisabled(),
          true,
        );
        await page
          .getByText("Stop Minecraft before creating a browser account", {
            exact: false,
          })
          .waitFor();
      } else {
        await page
          .getByText("Experimental browser compatibility", { exact: true })
          .waitFor();
        await setup.click();
        const failed = page
          .getByRole("alert")
          .filter({ hasText: "The component download failed." });
        await failed.waitFor();
        await page.waitForResponse(
          (response) => new URL(response.url()).pathname === apiBase,
        );
        assert.equal(
          await failed.isVisible(),
          true,
          "Status polling must preserve action errors",
        );
        await setup.click();
        await page
          .getByRole("heading", {
            name: "Server configuration changes",
            exact: true,
          })
          .waitFor();
        const approve = page.getByRole("button", {
          name: "Approve & Apply Setup",
          exact: true,
        });
        assert.equal(await approve.isDisabled(), true);
        assert.equal(setupRequests, 0);
        await page.getByRole("checkbox").check();
        await approve.click();
        await page
          .getByRole("button", { name: "Enable", exact: true })
          .waitFor();
        assert.equal(setupRequests, 1);
        assert.equal(inspectRequests, 2);
        const passwords = page.getByRole("checkbox", { name: "Require NodePilot browser passwords", exact: true });
        assert.equal(await passwords.isChecked(), true);
        page.once("dialog", dialog => dialog.accept());
        await passwords.click();
        await page.getByText("Open access: players join without a NodePilot password.", { exact: false }).waitFor();
        assert.equal(await passwords.isChecked(), false);
        page.once("dialog", dialog => dialog.accept());
        await passwords.click();
        await page.getByText("Players use their NodePilot browser account and password.", { exact: false }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Review Setup", exact: true })
            .count(),
          0,
        );
        await page
          .getByRole("textbox", { name: "Browser username", exact: true })
          .fill("alex");
        await page
          .getByLabel("Account password", { exact: true })
          .fill("1234");
        await page
          .getByRole("button", { name: "Create Account", exact: true })
          .click();
        await page.getByText("np_alex", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByLabel("Account password", { exact: true })
            .inputValue(),
          "",
        );
        await page
          .getByRole("button", { name: "Reset Password", exact: true })
          .click();
        await page
          .getByLabel("New password for np_alex", { exact: true })
          .fill("abcd");
        await page
          .getByRole("button", { name: "Save Password", exact: true })
          .click();
        await page
          .getByText("Browser password reset.", { exact: false })
          .waitFor();
        assert.equal(resetRequests, 1);
        await page.getByRole("button", { name: "Enable", exact: true }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "The public tunnel could not start." })
          .waitFor();
        await page
          .getByRole("button", { name: "Retry Gateway", exact: true })
          .click();
        const address = page.getByLabel("Eaglercraft server address", {
          exact: true,
        });
        await address.waitFor();
        assert.equal(enableRequests, 2);
        assert.equal(
          await address.inputValue(),
          "wss://nodepilot-fixture.trycloudflare.com",
        );
        await page
          .getByRole("button", { name: "Copy Address", exact: true })
          .click();
        assert.equal(
          await page.evaluate(() => window.__copiedBrowserAddress),
          "wss://nodepilot-fixture.trycloudflare.com",
        );
        await page.getByText("Gateway listening.", { exact: true }).waitFor();
        if (process.env.NODEPILOT_BROWSER_UI_SCREENSHOT)
          await page.screenshot({
            path: process.env.NODEPILOT_BROWSER_UI_SCREENSHOT,
            fullPage: true,
          });
        page.once("dialog", (dialog) => dialog.dismiss());
        await page.getByRole("button", { name: "Revoke", exact: true }).click();
        assert.equal(revokeRequests, 0);
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByRole("button", { name: "Revoke", exact: true }).click();
        await page
          .getByText("np_alex can no longer log in.", { exact: true })
          .waitFor();
        assert.equal(revokeRequests, 1);
        page.once("dialog", (dialog) => dialog.accept());
        await page
          .getByRole("button", { name: "Disable", exact: true })
          .click();
        await address.waitFor({ state: "hidden" });
        assert.equal(status.status, "disabled");
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
          "Panel must fit a mobile viewport",
        );
      }
      assert.deepEqual(errors, []);
      console.log(`PASS browser players ${scenario}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => fixture.close(resolve));
}
