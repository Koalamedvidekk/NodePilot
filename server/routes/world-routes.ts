import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../lib/errors.js';
import type { WorldService } from '../services/world-service.js';
import type { WorldOperation } from '../world-types.js';

const id = z.string().uuid();
const serverParams = z.object({ id });
const worldParams = z.object({ id, worldId: id });
const operationParams = z.object({ id, operationId: id });
const backupParams = z.object({ id, worldId: id, backupId: id });
const packParams = z.object({ id, worldId: id, packId: z.string().min(1).max(256) });
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const revisionBody = z.object({ revision });
const name = z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/);
const packs = z.array(z.string().min(1).max(256)).max(128);
const difficulty = z.enum(['peaceful', 'easy', 'normal', 'hard']);
const prepareBody = z.object({
  revision, name, seed: z.string().max(256).regex(/^[^\r\n\0]*$/),
  preset: z.string().min(1).max(128), generatorSettings: z.string().max(16_384),
  structures: z.boolean(), hardcore: z.boolean(), difficulty,
  enabledPacks: packs, disabledPacks: packs,
});
const settingsBody = z.object({ revision, name: name.optional(), difficulty: difficulty.optional(), hardcore: z.boolean().optional() })
  .refine((value) => value.name !== undefined || value.difficulty !== undefined || value.hardcore !== undefined, 'Supply a setting to change.');
const activateBody = z.object({ revision, confirmCompatibility: z.boolean().optional().default(false) });
const importBody = activateBody.extend({ inspectionId: z.string().uuid(), candidateId: z.string().uuid(), name });
const rulesBody = z.object({ revision, rules: z.record(z.string().min(1).max(256), z.union([z.boolean(), z.number().int().safe()])) });
const selectionBody = z.object({ revision, enabled: packs, disabled: packs });
const MAX_WORLD_UPLOAD = 4 * 1024 ** 3;
const MAX_PACK_UPLOAD = 256 * 1024 ** 2;

type UploadedZip = { file: string; filename: string; revision?: string };

/** Filenames are identifiers only. The upload destination always uses a generated UUID. */
async function receiveZip(request: FastifyRequest, directory: string, limit: number, needsRevision: boolean): Promise<UploadedZip> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, randomUUID() + '.zip');
  let filename: string | undefined;
  let suppliedRevision: string | undefined;
  let bytes = 0;
  try {
    for await (const part of request.parts({ limits: { files: 1, fields: needsRevision ? 1 : 0, parts: needsRevision ? 2 : 1, fileSize: limit, fieldSize: 256 } })) {
      if (part.type === 'field') {
        if (part.fieldname !== 'revision' || suppliedRevision !== undefined || typeof part.value !== 'string') throw new AppError(400, 'invalid_world_upload', 'Unexpected or duplicate upload field.');
        suppliedRevision = revision.parse(part.value);
        continue;
      }
      if (part.fieldname !== 'file' || filename !== undefined || !part.filename || part.filename.length > 240 || !/\.zip$/i.test(part.filename)
        || /[\\/\x00-\x1f\x7f<>:"|?*]/.test(part.filename) || /[. ]$/.test(part.filename)) {
        part.file.resume();
        throw new AppError(400, 'invalid_world_upload', 'Choose one ZIP file with a plain filename.');
      }
      filename = part.filename;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) callback(new AppError(413, 'world_upload_too_large', 'The ZIP exceeds the supported upload size.'));
        else callback(null, chunk);
      } });
      await pipeline(part.file, limiter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) throw new AppError(413, 'world_upload_too_large', 'The ZIP exceeds the supported upload size.');
    }
    if (!filename || bytes === 0) throw new AppError(400, 'world_archive_required', 'Choose a nonempty ZIP archive.');
    if (needsRevision && !suppliedRevision) throw new AppError(400, 'world_revision_required', 'Refresh the world before uploading a datapack.');
    return { file, filename, revision: suppliedRevision };
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** These routes inherit the panel authentication and origin checks registered by index.ts. */
export async function registerWorldRoutes(app: FastifyInstance, worlds: WorldService, config: { dataDirectory: string }): Promise<void> {
  const root = '/api/servers/:id/worlds';
  const uploads = path.join(config.dataDirectory, 'worlds', 'uploads');
  let closing = false;
  app.addHook('onClose', async () => {
    closing = true;
    // Retain in-flight source files during shutdown; service recovery may still need them.
  });
  const cleanupAfter = (serverId: string, operation: WorldOperation, file: string) => {
    void (async () => {
      try {
        while (!closing && worlds.operation(serverId, operation.id).state === 'running') await delay(250, undefined, { ref: false });
        if (!closing) await rm(file, { force: true });
      } catch { /* Failed temporary-file cleanup does not hide the operation result. */ }
    })();
  };
  const uploadAllowed = async (serverId: string) => {
    const listing = await worlds.list(serverId);
    if (!listing.supported || !listing.capabilities.canMutate) throw new AppError(409, 'world_changes_unavailable', listing.unsupportedReason ?? listing.capabilities.reason ?? 'World changes are unavailable.');
  };
  app.get(root, async (request) => worlds.list(serverParams.parse(request.params).id));
  app.get(root + '/:worldId', async (request) => {
    const { id, worldId } = worldParams.parse(request.params);
    return worlds.details(id, worldId);
  });
  app.post(root, async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    const operation = await worlds.prepare(id, prepareBody.parse(request.body));
    return reply.code(202).send({ operation });
  });
  app.patch(root + '/:worldId', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.update(id, worldId, settingsBody.parse(request.body)) });
  });
  app.post(root + '/:worldId/activate', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.activate(id, worldId, activateBody.parse(request.body)) });
  });
  app.put(root + '/:worldId/gamerules', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.saveRules(id, worldId, rulesBody.parse(request.body)) });
  });
  app.delete(root + '/:worldId', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    const input = revisionBody.extend({ confirmName: name }).parse(request.body);
    return reply.code(202).send({ operation: await worlds.delete(id, worldId, input) });
  });
  app.post(root + '/:worldId/backups', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.backup(id, worldId, revisionBody.parse(request.body).revision) });
  });
  app.post(root + '/:worldId/backups/:backupId/restore', async (request, reply) => {
    const { id, worldId, backupId } = backupParams.parse(request.params);
    const input = revisionBody.extend({ confirm: z.literal(true) }).parse(request.body);
    return reply.code(202).send({ operation: await worlds.restore(id, worldId, backupId, input) });
  });
  app.post(root + '/:worldId/export', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.export(id, worldId, revisionBody.parse(request.body).revision) });
  });
  app.post(root + '/import/inspect', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    await uploadAllowed(id);
    const upload = await receiveZip(request, uploads, MAX_WORLD_UPLOAD, false);
    try {
      const operation = await worlds.inspectImport(id, upload.file);
      cleanupAfter(id, operation, upload.file);
      return reply.code(202).send({ operation });
    } catch (error) { await rm(upload.file, { force: true }).catch(() => undefined); throw error; }
  });
  app.post(root + '/import', async (request, reply) => {
    const { id } = serverParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.import(id, importBody.parse(request.body)) });
  });
  app.post(root + '/:worldId/datapacks', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    await uploadAllowed(id);
    const upload = await receiveZip(request, uploads, MAX_PACK_UPLOAD, true);
    try {
      const operation = await worlds.uploadPack(id, worldId, upload.file, upload.filename, upload.revision!);
      cleanupAfter(id, operation, upload.file);
      return reply.code(202).send({ operation });
    } catch (error) { await rm(upload.file, { force: true }).catch(() => undefined); throw error; }
  });
  app.patch(root + '/:worldId/datapacks', async (request, reply) => {
    const { id, worldId } = worldParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.selectPacks(id, worldId, selectionBody.parse(request.body)) });
  });
  app.delete(root + '/:worldId/datapacks/:packId', async (request, reply) => {
    const { id, worldId, packId } = packParams.parse(request.params);
    return reply.code(202).send({ operation: await worlds.removePack(id, worldId, packId, revisionBody.parse(request.body).revision) });
  });
  app.get(root + '/operations/:operationId', async (request) => {
    const { id, operationId } = operationParams.parse(request.params);
    return worlds.operation(id, operationId);
  });
  app.get(root + '/operations/:operationId/download', async (request, reply) => {
    const { id, operationId } = operationParams.parse(request.params);
    const file = await worlds.artifact(id, operationId);
    const info = await stat(file);
    return reply.type('application/zip').header('content-disposition', `attachment; filename="nodepilot-world-${operationId}.zip"`)
      .header('content-length', String(info.size)).header('cache-control', 'no-store').send(createReadStream(file));
  });
}
