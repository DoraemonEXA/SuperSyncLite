import { FastifyReply } from 'fastify';
import { occupiedIds, lookupOperation, latestImport } from './storage';
import { Logger } from '../logger';
import { getSyncService } from './sync.service';
import { computeOpStorageBytes } from './sync.const';
import { Operation, SYNC_ERROR_CODES } from './sync.types';
import { errorMessage, MAX_OPS_PER_BATCH } from './sync.routes.payload';

/** Size new candidates before a quota cleanup. Store the same estimate on accepted rows. */
export const computeOpsStorageBytes = (
  ops: Array<{ id?: string; payload: unknown; vectorClock: unknown }>,
): { bytes: number; fallback: number } => {
  let bytes = 0;
  let fallback = 0;
  for (const op of ops) {
    const sized = computeOpStorageBytes(op);
    bytes += sized.bytes;
    if (sized.fallback) fallback += 1;
  }
  return { bytes, fallback };
};

export const computeOpsStorageBytesExcludingUnstorableIds = async (
  ops: Operation[],
  getCachedPayloadBytes?: (op: Operation) => number | undefined,
): Promise<{
  bytes: number;
  fallback: number;
  requestStartOccupiedIds: ReadonlySet<string>;
}> => {
  if (ops.length === 0) {
    return { bytes: 0, fallback: 0, requestStartOccupiedIds: new Set() };
  }

  const requestStartOccupiedIds = await occupiedIds(ops.map((op) => op.id));

  let bytes = 0;
  let fallback = 0;
  const seenIncomingIds = new Set<string>();
  for (const op of ops) {
    // uploadOps stores at most the first new operation for an ID. Any occupied
    // ID (exact retry or collision) and every repeated incoming ID is terminally
    // rejected, so charging it here can only poison the pre-write quota gate.
    if (requestStartOccupiedIds.has(op.id) || seenIncomingIds.has(op.id)) {
      continue;
    }
    seenIncomingIds.add(op.id);

    const sized = computeOpStorageBytes(op, getCachedPayloadBytes?.(op));
    bytes += sized.bytes;
    if (sized.fallback) fallback += 1;
  }
  return { bytes, fallback, requestStartOccupiedIds };
};

export const computeJsonStorageBytes = (value: unknown, fallback: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? fallback), 'utf8');
  } catch {
    return 0;
  }
};

export const getRawOpsCount = (body: unknown): number | null => {
  if (typeof body !== 'object' || body === null) return null;
  const ops = (body as { ops?: unknown }).ops;
  return Array.isArray(ops) ? ops.length : null;
};

export const sendOpsBatchTooLargeReply = (
  reply: FastifyReply,
  userId: number,
  opsCount: number,
): FastifyReply => {
  Logger.warn(
    `[user:${userId}] Upload rejected: ${opsCount} ops exceeds max batch size ${MAX_OPS_PER_BATCH}`,
  );
  return reply.status(413).send({
    error: `Too many operations in upload batch. Maximum is ${MAX_OPS_PER_BATCH}.`,
    errorCode: SYNC_ERROR_CODES.PAYLOAD_TOO_LARGE,
    maxOpsPerBatch: MAX_OPS_PER_BATCH,
  });
};

export const sendQuotaExceededReply = (
  reply: FastifyReply,
  body: {
    storageUsedBytes: number;
    storageQuotaBytes: number;
    autoCleanupAttempted: boolean;
    cleanupStats?: {
      freedBytes: number;
      deletedRestorePoints: number;
      deletedOps: number;
    };
  },
): FastifyReply =>
  reply.status(413).send({
    error: 'Storage quota exceeded',
    errorCode: SYNC_ERROR_CODES.STORAGE_QUOTA_EXCEEDED,
    ...body,
  });

type ExistingSyncImport = {
  id: string;
  clientId: string;
  serverSeq: number;
};

/**
 * Look up an existing full-state op for the user.
 *
 * When `incomingOpId` is provided, try an exact id match first so an
 * idempotent retry (`existing.id === incomingOpId`) is detected deterministically
 * even when multiple full-state ops exist for the user (e.g. an old SYNC_IMPORT
 * plus a later BACKUP_IMPORT). The fallback orders by `serverSeq DESC` so the
 * 409 path consistently reports the most recent restore point instead of
 * whatever Postgres happens to return.
 */
export const findExistingSyncImport = async (
  userId: number,
  incomingOpId?: string,
): Promise<ExistingSyncImport | null> => {
  if (incomingOpId) {
    const exact = await lookupOperation(incomingOpId);
    if (
      exact &&
      exact.userId === userId &&
      (exact.opType === 'SYNC_IMPORT' ||
        exact.opType === 'BACKUP_IMPORT' ||
        exact.opType === 'REPAIR')
    ) {
      return { id: exact.id, clientId: exact.clientId, serverSeq: exact.serverSeq };
    }
  }
  return latestImport(userId);
};

/**
 * True when an incoming snapshot upload is a retry of the existing import —
 * the client has reused the same `opId`, so the previous attempt was already
 * persisted server-side and we should respond with idempotent success
 * instead of a 409 SYNC_IMPORT_EXISTS. Returning failure here would force a
 * client whose response was dropped by the network into the "download and
 * merge" path that the 409 normally triggers.
 */
export const isIdempotentSyncImportRetry = (
  existingImport: ExistingSyncImport,
  incomingOpId: string | undefined,
): boolean => Boolean(incomingOpId) && existingImport.id === incomingOpId;

export const sendSyncImportExistsReply = (
  reply: FastifyReply,
  userId: number,
  clientId: string,
  existingImport: ExistingSyncImport,
): FastifyReply => {
  Logger.warn(
    `[user:${userId}] Rejecting duplicate SYNC_IMPORT from client ${clientId}. ` +
      `Existing import from client ${existingImport.clientId} (id: ${existingImport.id}). ` +
      `Client should download and merge instead.`,
  );
  return reply.status(409).send({
    error: 'SYNC_IMPORT_EXISTS',
    errorCode: 'SYNC_IMPORT_EXISTS',
    message:
      'A SYNC_IMPORT already exists. Download existing data and upload your changes as regular operations.',
    existingImportId: existingImport.id,
  });
};

/**
 * Check storage quota, recalculate if stale, and auto-cleanup if needed.
 * @returns `true` if quota is OK (caller can proceed), `false` if reply was sent with 413 error.
 */
export async function enforceStorageQuota(
  userId: number,
  storageDeltaBytes: number,
  reply: FastifyReply,
): Promise<boolean> {
  const syncService = getSyncService();
  let quotaCheck = await syncService.checkStorageQuota(userId, storageDeltaBytes);
  if (quotaCheck.allowed) return true;

  const cleanupResult = await syncService.freeStorageForUpload(userId, storageDeltaBytes);

  if (cleanupResult.success) {
    Logger.info(
      `[user:${userId}] Auto-cleanup freed ${Math.round(cleanupResult.freedBytes / 1024)}KB ` +
        `(${cleanupResult.deletedRestorePoints} restore points, ${cleanupResult.deletedOps} ops)`,
    );
    return true;
  }

  // Truly out of space - return error
  const finalQuota = await syncService.checkStorageQuota(userId, storageDeltaBytes);
  Logger.warn(
    `[user:${userId}] Storage quota still exceeded after cleanup: ${finalQuota.currentUsage}/${finalQuota.quota} bytes`,
  );
  sendQuotaExceededReply(reply, {
    storageUsedBytes: finalQuota.currentUsage,
    storageQuotaBytes: finalQuota.quota,
    autoCleanupAttempted: true,
    cleanupStats: {
      freedBytes: cleanupResult.freedBytes,
      deletedRestorePoints: cleanupResult.deletedRestorePoints,
      deletedOps: cleanupResult.deletedOps,
    },
  });
  return false;
}

export async function enforceCleanSlateStorageQuota(
  userId: number,
  finalStorageBytes: number,
  reply: FastifyReply,
): Promise<boolean> {
  const syncService = getSyncService();
  const storageInfo = await syncService.getStorageInfo(userId);
  if (finalStorageBytes <= storageInfo.storageQuotaBytes) return true;

  Logger.warn(
    `[user:${userId}] Clean-slate snapshot exceeds quota: ` +
      `${finalStorageBytes}/${storageInfo.storageQuotaBytes} bytes`,
  );
  sendQuotaExceededReply(reply, {
    storageUsedBytes: 0,
    storageQuotaBytes: storageInfo.storageQuotaBytes,
    autoCleanupAttempted: false,
  });
  return false;
}
