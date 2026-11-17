import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BrowserAccessService } from "../services/browser-access-service.js";

const serverParams = z.object({ id: z.uuid() });
const accountParams = serverParams.extend({ accountId: z.uuid() });
const confirmation = z.object({ confirm: z.literal(true) });

export async function registerBrowserAccessRoutes(
  app: FastifyInstance,
  browser: BrowserAccessService,
  reconcile: () => Promise<void>,
): Promise<void> {
  const prefix = "/api/servers/:id/browser-access";
  app.get(prefix, (request) =>
    browser.status(serverParams.parse(request.params).id),
  );
  app.post(prefix + "/inspect", async (request, reply) =>
    reply
      .code(202)
      .send(await browser.inspect(serverParams.parse(request.params).id)),
  );
  app.post(prefix + "/setup", async (request) => {
    const { id } = serverParams.parse(request.params);
    const { revision } = confirmation
      .extend({ revision: z.string().regex(/^[0-9a-f]{64}$/) })
      .parse(request.body);
    return browser.setup(id, revision);
  });
  app.post(prefix + "/enable", async (request, reply) => {
    confirmation.parse(request.body);
    const status = await browser.enable(serverParams.parse(request.params).id);
    await reconcile();
    return reply.code(202).send(status);
  });
  app.post(prefix + "/disable", async (request) => {
    confirmation.parse(request.body);
    const status = await browser.disable(serverParams.parse(request.params).id);
    await reconcile();
    return status;
  });
  app.post(prefix + "/settings", async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const { requirePassword } = confirmation.extend({ requirePassword: z.boolean() }).parse(request.body);
    return reply.code(202).send(await browser.updateSettings(id, requirePassword));
  });
  app.get(prefix + "/accounts", async (request) => {
    const { id } = serverParams.parse(request.params);
    await browser.status(id);
    return { accounts: browser.accounts.list(id) };
  });
  app.post(prefix + "/accounts", async (request) => {
    const { id } = serverParams.parse(request.params);
    const input = z
      .object({
        name: z.string().min(1).max(13),
        password: z.string().min(4).max(127),
      })
      .parse(request.body);
    return {
      account: await browser.createAccount(id, input),
    };
  });
  app.post(prefix + "/accounts/:accountId/password", async (request) => {
    const { id, accountId } = accountParams.parse(request.params);
    await browser.status(id);
    const { password } = z
      .object({ password: z.string().min(4).max(127) })
      .parse(request.body);
    return {
      account: await browser.accounts.resetPassword(id, accountId, password),
    };
  });
  app.delete(prefix + "/accounts/:accountId", async (request) => {
    const { id, accountId } = accountParams.parse(request.params);
    await browser.status(id);
    browser.accounts.revoke(id, accountId);
    return { ok: true };
  });
}
