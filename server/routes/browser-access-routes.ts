import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BrowserAccessService } from "../services/browser-access-service.js";

const serverParams = z.object({ id: z.uuid() });
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
}
