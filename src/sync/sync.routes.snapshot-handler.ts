import { FastifyReply, FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { SuperSyncUploadSnapshotRequestSchema } from '../shared/supersync-http-contract';
import { lookupOperation } from './storage';
import { Logger } from '../logger';
import { getAuthUser } from '../middleware';
import { getSyncService } from './sync.service';
import { getWsConnectionService } from './services/websocket-connection.service';
import { Operation, SYNC_ERROR_CODES, UploadResult } from './sync.types';
import { isSameIncomingOperation } from './conflict';
import { isSingleTokenGzipEncoding, parseCompressedJsonBody } from './compressed-body-parser';
import type { SnapshotDedupResponse } from './services';
import {
  createValidationErrorResponse,
  errorMessage,
  MAX_COMPRESSED_SIZE_SNAPSHOT,
  MAX_DECOMPRESSED_SIZE_SNAPSHOT,
  sendCompressedBodyParseFailure,
  sendE2eeRequiredReply,
  violatesE2eeGate,
} from './sync.routes.payload';
import {
  computeJsonStorageBytes,
  enforceCleanSlateStorageQuota,
  enforceStorageQuota,
  findExistingSyncImport,
  isIdempotentSyncImportRetry,
  sendQuotaExceededReply,
  sendSyncImportExistsReply,
} from './sync.routes.quota';
import { createSnapshotRequestFingerprint } from './services/request-deduplication.service';

export const uploadSnapshotHandler = async (
  req: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> => {
  try {
    const userId = getAuthUser(req).userId;

    // Handle gzip-compressed request body.
    // B10: use the normalizing helper so RFC-valid mixed-case / padded
    // values match. Layered encodings are rejected by the parser.
    let body: unknown = req.body;

    if (isSingleTokenGzipEncoding(req.headers['content-encoding'])) {
      const contentTransferEncoding = req.headers['content-transfer-encoding'] as
        string | undefined;
      const compressedBodyResult = await parseCompressedJsonBody(
        req.body,
        contentTransferEncoding,
        {
          maxCompressedSize: MAX_COMPRESSED_SIZE_SNAPSHOT,
          maxDecompressedSize: MAX_DECOMPRESSED_SIZE_SNAPSHOT,
        },
      );

      if (!compressedBodyResult.ok) {
        return sendCompressedBodyParseFailure(reply, userId, compressedBodyResult, {
          payloadLabel: 'snapshot',
          decompressFailureLabel: 'snapshot',
          maxCompressedSize: MAX_COMPRESSED_SIZE_SNAPSHOT,
          maxDecompressedSize: MAX_DECOMPRESSED_SIZE_SNAPSHOT,
        });
      }

      body = compressedBodyResult.body;
      Logger.debug(
        `[user:${userId}] Snapshot decompressed: ${compressedBodyResult.compressedSize} -> ${compressedBodyResult.decompressedSize} bytes (base64: ${compressedBodyResult.isBase64})`,
      );
    }

    // Validate request body
    const parseResult = SuperSyncUploadSnapshotRequestSchema.safeParse(body);
    if (!parseResult.success) {
      Logger.warn(`[user:${userId}] Snapshot upload validation failed`, parseResult.error.issues);
      return reply.status(400).send(createValidationErrorResponse(parseResult.error.issues));
    }

    const snapshotRequest = parseResult.data as typeof parseResult.data & {
      requestId?: string;
      repairBaseServerSeq?: number;
    };
    const {
      state,
      clientId,
      reason,
      vectorClock,
      schemaVersion,
      isPayloadEncrypted,
      opId,
      isCleanSlate,
      snapshotOpType,
      syncImportReason,
      repairBaseServerSeq,
      requestId,
    } = snapshotRequest;
    const shouldCleanSlate = snapshotOpType === 'REPAIR' ? false : isCleanSlate;
    const isLegacyRepairUpload =
      snapshotOpType === 'REPAIR' && repairBaseServerSeq === undefined && isCleanSlate === true;

    // Encrypted-only ingress gate: applies to every snapshot op type,
    // including SYNC_IMPORT, BACKUP_IMPORT, and REPAIR — the legacy plaintext
    // repair upload is no longer externally reachable. Runs BEFORE
    // fingerprinting, dedup, quota work, and prepareSnapshotCache, so a
    // rejected upload leaves no server-side trace and burns no CPU on the
    // full-state hash or gzip.
    if (violatesE2eeGate({ isPayloadEncrypted, payload: state })) {
      return sendE2eeRequiredReply(reply, userId, {
        clientId,
        surface: 'snapshot',
        opsCount: 1,
      });
    }

    const syncService = getSyncService();
    // Lazy + memoized: fingerprinting stable-stringifies + SHA-256-hashes the
    // full (possibly multi-MB plaintext) snapshot state. It must not run
    // before the pre-quota gate below, and first-time requests never need it —
    // the dedup check only invokes it when an entry for this requestId exists
    // (a genuine retry).
    let memoizedFingerprint: string | undefined;
    const getRequestFingerprint = (): string =>
      (memoizedFingerprint ??= createSnapshotRequestFingerprint({
        state,
        clientId,
        reason,
        vectorClock,
        schemaVersion,
        isPayloadEncrypted,
        syncImportReason,
        opId,
        isCleanSlate: shouldCleanSlate,
        snapshotOpType,
        repairBaseServerSeq,
      }));

    if (requestId) {
      const cachedResponse = await syncService.checkSnapshotRequestDedup(
        userId,
        requestId,
        getRequestFingerprint,
      );
      if (cachedResponse) {
        Logger.info(`[user:${userId}] Returning cached snapshot result for request ${requestId}`);
        return reply.send(cachedResponse);
      }
    }

    // Defense in depth: the contract superRefine already requires opId for
    // clean-slate uploads, but the destructive wipe below must never depend on
    // a schema in another package staying strict. Keep the invariant local.
    if (isCleanSlate && !opId) {
      return reply.code(400).send({
        error: 'opId is required for clean-slate snapshot idempotency',
      });
    }

    if (!shouldCleanSlate && snapshotOpType !== 'REPAIR') {
      const info = await syncService.getStorageInfo(userId);
      if (info.storageUsedBytes >= info.storageQuotaBytes)
        return sendQuotaExceededReply(reply, {
          ...info,
          autoCleanupAttempted: false,
        });
    }

    // Pin the fingerprint BEFORE processing mutates anything, but AFTER the
    // pre-quota gate above so quota-exhausted clients cannot burn CPU on the
    // full-state hash.
    if (requestId) {
      getRequestFingerprint();
    }

    // Reject duplicate SYNC_IMPORT before we acquire the per-user lock — a
    // duplicate rejection is cheap (one indexed lookup) and skipping the
    // lock lets concurrent legitimate clients keep moving.
    // Exceptions that bypass this check:
    // - 'recovery': Explicit backup restore or repair (user action)
    // - 'migration': Legacy data migration (should be allowed to override)
    // - 'isCleanSlate': Password change or explicit clean slate request
    // Only 'initial' (first-time server migration) should be rejected if one exists.
    if (reason === 'initial' && !shouldCleanSlate) {
      const existingImport = await findExistingSyncImport(userId, opId);

      if (existingImport) {
        if (isIdempotentSyncImportRetry(existingImport, opId)) {
          Logger.info(
            `[user:${userId}] Idempotent SYNC_IMPORT retry from client ${clientId} ` +
              `for existing import seq=${existingImport.serverSeq}`,
          );
          return reply.send({
            accepted: true,
            serverSeq: existingImport.serverSeq,
          } satisfies SnapshotDedupResponse);
        }
        return sendSyncImportExistsReply(reply, userId, clientId, existingImport);
      }
    }

    // Create a SYNC_IMPORT operation
    // Use the correct NgRx action type so the operation can be replayed on other clients
    // FIX: Use client's opId if provided to prevent ID mismatch bugs
    // When client doesn't send opId (legacy clients), fall back to server-generated UUID
    const op = {
      id: opId ?? uuidv7(),
      clientId,
      actionType: '[SP_ALL] Load(import) all data',
      opType: (snapshotOpType ?? 'SYNC_IMPORT') as 'SYNC_IMPORT' | 'BACKUP_IMPORT' | 'REPAIR',
      entityType: 'ALL',
      payload: state,
      vectorClock,
      timestamp: Date.now(),
      schemaVersion: schemaVersion ?? 1,
      // Always true post-E2EE gate; the `?? false` fallback is dead and goes
      // with the rest of the plaintext handling in eradication plan Step 3.
      isPayloadEncrypted: isPayloadEncrypted ?? false,
      syncImportReason,
      repairBaseServerSeq,
    };

    const estimatedOpStorageBytes =
      Buffer.byteLength(JSON.stringify(state)) + computeJsonStorageBytes(op.vectorClock, {});

    const result = await (async (): Promise<UploadResult | null> => {
      // Short-lived request receipts expire. Destructive
      // clean-slate uploads need a durable check before deletion; REPAIR needs
      // the same check before its old base cursor can be rejected as stale
      // after a response-loss retry. The client-supplied opId is the durable
      // idempotency key.
      if ((shouldCleanSlate || snapshotOpType === 'REPAIR') && opId) {
        const existingFullStateOp = await lookupOperation(opId);
        if (existingFullStateOp) {
          const existingOperation: Operation = {
            id: existingFullStateOp.id,
            clientId: existingFullStateOp.clientId,
            actionType: existingFullStateOp.actionType,
            opType: existingFullStateOp.opType as Operation['opType'],
            entityType: existingFullStateOp.entityType,
            entityId: existingFullStateOp.entityId ?? undefined,
            entityIds: existingFullStateOp.entityIds,
            payload: existingFullStateOp.payload,
            vectorClock: existingFullStateOp.vectorClock as Operation['vectorClock'],
            timestamp: op.timestamp,
            schemaVersion: existingFullStateOp.schemaVersion,
            isPayloadEncrypted: existingFullStateOp.isPayloadEncrypted,
            syncImportReason: existingFullStateOp.syncImportReason ?? undefined,
            repairBaseServerSeq: existingFullStateOp.repairBaseServerSeq ?? undefined,
          };
          const isExactRetry =
            existingFullStateOp.userId === userId &&
            (existingFullStateOp.opType === 'SYNC_IMPORT' ||
              existingFullStateOp.opType === 'BACKUP_IMPORT' ||
              existingFullStateOp.opType === 'REPAIR') &&
            isSameIncomingOperation(existingOperation, op, 0, 0);
          if (isExactRetry) {
            Logger.info(
              `[user:${userId}] Idempotent full-state retry from client ${clientId} ` +
                `for existing op seq=${existingFullStateOp.serverSeq}`,
            );
            return {
              opId,
              accepted: true,
              serverSeq: existingFullStateOp.serverSeq,
            };
          }
          return {
            opId,
            accepted: false,
            error: 'Operation ID already belongs to a different operation',
            errorCode: SYNC_ERROR_CODES.INVALID_OP_ID,
          };
        }
      }

      // The quota gate may delete restore points and old operations to make
      // room. Reject stale or missing causal REPAIR bases before cleanup can
      // mutate storage. uploadOps repeats this check under the database row
      // lock, covering a concurrent writer between this check and the insert.
      if (snapshotOpType === 'REPAIR' && !isLegacyRepairUpload) {
        const currentServerSeq = await syncService.getLatestSeq(userId);
        if (repairBaseServerSeq === undefined || repairBaseServerSeq !== currentServerSeq) {
          reply.send({
            accepted: false,
            error: 'REPAIR snapshot does not include current server state',
            errorCode: SYNC_ERROR_CODES.REPAIR_STALE,
          });
          return null;
        }
      }

      if (reason === 'initial' && !shouldCleanSlate) {
        const existingImport = await findExistingSyncImport(userId, opId);

        if (existingImport) {
          if (isIdempotentSyncImportRetry(existingImport, opId)) {
            Logger.info(
              `[user:${userId}] Idempotent SYNC_IMPORT retry from client ${clientId} ` +
                `(in-lock) for existing import seq=${existingImport.serverSeq}`,
            );
            reply.send({
              accepted: true,
              serverSeq: existingImport.serverSeq,
            } satisfies SnapshotDedupResponse);
            return null;
          }
          sendSyncImportExistsReply(reply, userId, clientId, existingImport);
          return null;
        }
      }

      const fits = shouldCleanSlate
        ? await enforceCleanSlateStorageQuota(userId, estimatedOpStorageBytes, reply)
        : await enforceStorageQuota(userId, estimatedOpStorageBytes, reply);
      if (!fits) return null;

      const results = await syncService.uploadOps(
        userId,
        clientId,
        [op],
        shouldCleanSlate,
        undefined,
        repairBaseServerSeq,
        isLegacyRepairUpload,
      );
      const uploadResult = results[0];

      // Only encrypted uploads reach this point. The ciphertext is the restore point.
      return uploadResult;
    })();
    if (!result) return;

    // Idempotent retry: if uploadOps saw the same opId already on disk,
    // the previous attempt actually succeeded; the client just lost the
    // response. Surface the original serverSeq as success instead of a
    // confusing DUPLICATE_OPERATION rejection. (The SYNC_IMPORT_EXISTS
    // pre-check handles `reason='initial'`; this branch covers BACKUP_IMPORT
    // and REPAIR uploads, which bypass that pre-check.)
    let finalResult: UploadResult = result;
    if (!result.accepted && result.errorCode === SYNC_ERROR_CODES.DUPLICATE_OPERATION && opId) {
      // Defensive userId filter: `isSameDuplicateOperation` already enforces
      // ownership before processOperation returns DUPLICATE_OPERATION, so a
      // cross-tenant id collision can't reach this branch today. The guard
      // keeps the route's idempotency conversion correct even if that
      // upstream invariant ever changes.
      const existingOp = await lookupOperation(opId);
      if (existingOp?.userId === userId) {
        Logger.info(
          `[user:${userId}] Idempotent snapshot retry from client ${clientId} ` +
            `for existing opId=${opId} (serverSeq=${existingOp.serverSeq})`,
        );
        finalResult = {
          opId,
          accepted: true,
          serverSeq: existingOp.serverSeq,
        };
      }
    }

    Logger.info(`Snapshot uploaded for user ${userId}, reason: ${reason}`);

    // Notify other connected clients about snapshot upload (fire-and-forget)
    if (finalResult.accepted && finalResult.serverSeq !== undefined) {
      getWsConnectionService().notifyNewOps(userId, clientId, finalResult.serverSeq);
    }

    const responseBody: SnapshotDedupResponse = {
      accepted: finalResult.accepted,
      serverSeq: finalResult.serverSeq,
      error: finalResult.error,
      errorCode: finalResult.errorCode,
    };
    // Skip caching when the result is a residual DUPLICATE_OPERATION (the
    // existing-op lookup just above failed) so a concurrent retry that
    // lost the insert race cannot overwrite the winner's success entry.
    // Also skip transaction rollbacks (INTERNAL_ERROR): nothing was committed,
    // so the deterministic-requestId retry must re-process instead of being
    // served the cached transient failure for the dedup TTL (5 min). #8332
    if (
      requestId &&
      finalResult.errorCode !== SYNC_ERROR_CODES.DUPLICATE_OPERATION &&
      finalResult.errorCode !== SYNC_ERROR_CODES.INTERNAL_ERROR
    ) {
      await syncService.cacheSnapshotRequestResult(
        userId,
        requestId,
        responseBody,
        getRequestFingerprint(),
      );
    }

    return reply.send(responseBody);
  } catch (err) {
    Logger.error(`Upload snapshot error: ${errorMessage(err)}`);
    return reply.status(500).send({ error: 'Internal server error' });
  }
};
