import {
  CONFLICT_DETECTION_ENTITY_BATCH_SIZE,
  ConflictResult,
  DuplicateOperationCandidate,
  LatestEntityOperationRow,
  Operation,
  VectorClock,
  compareVectorClocks,
  limitVectorClockSize,
} from './sync.types';

const TASK_TIME_DELTA_ACTION_TYPE = '[TimeTracking] Sync time spent';

export const resolveConflictForExistingOp = (
  op: Operation,
  entityId: string,
  existingOp: { actionType?: string; clientId: string; vectorClock: unknown },
): ConflictResult => {
  // Stored JSON/vector_clock values arrive as unknown from both Prisma model
  // reads and raw SQL rows; cast only at the vector-clock comparison boundary.
  const existingClock = existingOp.vectorClock as unknown as VectorClock;

  // Compare vector clocks
  const comparison = compareVectorClocks(op.vectorClock, existingClock);

  // Timer batches are additive and uniquely identified operations. Concurrent
  // deltas commute, so entity-level LWW must not discard either contribution.
  // Keep the causal checks below for EQUAL/LESS_THAN clocks: those operations
  // may already be represented by the stored state and replaying them could
  // double-count time.
  if (
    comparison === 'CONCURRENT' &&
    op.actionType === TASK_TIME_DELTA_ACTION_TYPE &&
    existingOp.actionType === TASK_TIME_DELTA_ACTION_TYPE
  ) {
    return { hasConflict: false };
  }

  // If the incoming op's clock is GREATER_THAN existing, it's a valid successor
  if (comparison === 'GREATER_THAN') {
    return { hasConflict: false };
  }

  // If clocks are EQUAL, this might be a retry of the same operation - check if from same client
  if (comparison === 'EQUAL' && op.clientId === existingOp.clientId) {
    return { hasConflict: false };
  }

  // EQUAL clocks from different clients is suspicious - treat as conflict
  // This could happen if client IDs rotate or clocks are somehow reused
  if (comparison === 'EQUAL') {
    return {
      hasConflict: true,
      conflictType: 'equal_different_client',
      reason: `Equal vector clocks from different clients for ${op.entityType}:${entityId} (client ${op.clientId} vs ${existingOp.clientId})`,
      existingClock,
    };
  }

  // CONCURRENT means both clocks have entries the other doesn't
  if (comparison === 'CONCURRENT') {
    return {
      hasConflict: true,
      conflictType: 'concurrent',
      reason: `Concurrent modification detected for ${op.entityType}:${entityId}`,
      existingClock,
    };
  }

  // LESS_THAN means the incoming op is older than what we have
  if (comparison === 'LESS_THAN') {
    return {
      hasConflict: true,
      conflictType: 'superseded',
      reason: `Superseded operation: server has newer version of ${op.entityType}:${entityId}`,
      existingClock,
    };
  }

  // Should never reach here - all comparison cases handled above
  // But if we do, default to conflict for safety
  return {
    hasConflict: true,
    conflictType: 'unknown',
    reason: `Unknown vector clock comparison result for ${op.entityType}:${entityId}`,
    existingClock,
  };
};

export const isSameDuplicateOperation = (
  existingOp: DuplicateOperationCandidate,
  userId: number,
  op: Operation,
  maxClockDriftMs: number,
  originalTimestamp: number = op.timestamp,
): boolean => {
  // Reproduce the normalization of the already-stored row. Storage may protect
  // a low-counter causal full-state author in addition to the uploader, so use
  // the stored clock's IDs as the authoritative protected set. Otherwise a
  // genuine retry of an oversized post-import op compares as an ID collision.
  //
  // Tradeoff, deliberate: for an oversized incoming clock this projects onto the
  // stored key set, so an id collision that ALSO differs only by an extra clock
  // entry now reads as a duplicate instead of being caught. Accepted because
  // every other structural field below (clientId, payload, entity, timestamp)
  // must still match — and when they all do, acking beats rejecting a retry
  // whose only sin is having learned about one more client.
  const storedClockClientIds =
    existingOp.vectorClock !== null &&
    typeof existingOp.vectorClock === 'object' &&
    !Array.isArray(existingOp.vectorClock)
      ? Object.keys(existingOp.vectorClock)
      : [];
  const storedVectorClock = limitVectorClockSize(op.vectorClock, [
    op.clientId,
    ...storedClockClientIds,
  ]);
  const incomingEncrypted = op.isPayloadEncrypted ?? false;

  // encrypt() uses a fresh random IV per call, so retried ciphertext differs
  // from the stored bytes. Skip byte-equality when both sides are encrypted;
  // the structural fields below still guard against id collisions.
  const payloadsMatch =
    (existingOp.isPayloadEncrypted && incomingEncrypted) ||
    areJsonValuesEqual(existingOp.payload, op.payload);

  return (
    existingOp.userId === userId &&
    existingOp.clientId === op.clientId &&
    existingOp.actionType === op.actionType &&
    existingOp.opType === op.opType &&
    existingOp.entityType === op.entityType &&
    existingOp.entityId === (op.entityId ?? null) &&
    // Compare against the same normalization the row was persisted with
    // (getStoredEntityIds: single-entity sets collapse to []), so a genuine
    // retry matches while a batch op differing only in entityIds does not.
    areJsonValuesEqual(existingOp.entityIds, getStoredEntityIds(op)) &&
    payloadsMatch &&
    areJsonValuesEqual(existingOp.vectorClock, storedVectorClock) &&
    existingOp.schemaVersion === op.schemaVersion &&
    isSameDuplicateTimestamp(
      existingOp.clientTimestamp,
      existingOp.receivedAt,
      op.timestamp,
      originalTimestamp,
      maxClockDriftMs,
    ) &&
    existingOp.isPayloadEncrypted === incomingEncrypted &&
    existingOp.syncImportReason === (op.syncImportReason ?? null) &&
    existingOp.repairBaseServerSeq === (op.repairBaseServerSeq ?? null)
  );
};

/** Complete identity comparison for two validated operations in one request. */
export const isSameIncomingOperation = (
  first: Operation,
  second: Operation,
  firstOriginalTimestamp: number = first.timestamp,
  secondOriginalTimestamp: number = second.timestamp,
): boolean => {
  const bothEncrypted = (first.isPayloadEncrypted ?? false) && (second.isPayloadEncrypted ?? false);
  return (
    first.clientId === second.clientId &&
    first.actionType === second.actionType &&
    first.opType === second.opType &&
    first.entityType === second.entityType &&
    first.entityId === second.entityId &&
    areJsonValuesEqual(getStoredEntityIds(first), getStoredEntityIds(second)) &&
    (bothEncrypted || areJsonValuesEqual(first.payload, second.payload)) &&
    areJsonValuesEqual(
      limitVectorClockSize(first.vectorClock, [first.clientId]),
      limitVectorClockSize(second.vectorClock, [second.clientId]),
    ) &&
    first.schemaVersion === second.schemaVersion &&
    firstOriginalTimestamp === secondOriginalTimestamp &&
    (first.isPayloadEncrypted ?? false) === (second.isPayloadEncrypted ?? false) &&
    (first.syncImportReason ?? null) === (second.syncImportReason ?? null) &&
    (first.repairBaseServerSeq ?? null) === (second.repairBaseServerSeq ?? null)
  );
};

export const isSameDuplicateTimestamp = (
  existingTimestamp: bigint | number | string,
  existingReceivedAt: bigint | number | string,
  incomingStoredTimestamp: number,
  incomingOriginalTimestamp: number,
  maxClockDriftMs: number,
): boolean => {
  if (existingTimestamp.toString() === incomingStoredTimestamp.toString()) {
    return true;
  }

  // A retry can arrive after server time advances enough that the original
  // timestamp no longer needs clamping, so original===stored does not rule
  // out a duplicate.
  // Future timestamps are clamped at receive time. A retry of the same op may
  // be clamped to a later value, or stop clamping once server time reaches the
  // original timestamp's allowed drift window. Allow exact-content duplicates
  // whose stored timestamp came from an earlier clamp of that same original
  // client timestamp.
  const existingTimestampValue = BigInt(existingTimestamp);
  const existingReceivedAtValue = BigInt(existingReceivedAt);
  return (
    existingTimestampValue === existingReceivedAtValue + BigInt(maxClockDriftMs) &&
    existingTimestampValue <= BigInt(incomingOriginalTimestamp)
  );
};

export const areJsonValuesEqual = (a: unknown, b: unknown): boolean => {
  return stableJsonStringify(a) === stableJsonStringify(b);
};

export const stableJsonStringify = (value: unknown): string => {
  return JSON.stringify(toStableJsonValue(value)) ?? 'undefined';
};

export const toStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, toStableJsonValue((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
};

/**
 * All entities an op touches (full set, including single-entity ops). Use for the
 * incoming-op conflict check and the in-memory in-batch map — NOT for the persisted
 * `entity_ids` column, which uses {@link getStoredEntityIds} (multi-entity only).
 */
export const getConflictEntityIds = (op: Operation): string[] => {
  const rawEntityIds = [
    ...(op.entityId ? [op.entityId] : []),
    ...(op.entityIds?.length ? op.entityIds : []),
  ];
  if (isLegacyMiscConfigOperation(op)) {
    rawEntityIds.push('tasks');
  }
  return Array.from(new Set(rawEntityIds));
};

/**
 * The misc→tasks settings split happened in the v1→v2 migration
 * (`MiscToTasksSettingsMigration_v1v2`), so ONLY pre-v2 `GLOBAL_CONFIG:misc`
 * writes also touched what is now `GLOBAL_CONFIG:tasks`. Gate on that fixed
 * boundary, not the moving `CURRENT_SCHEMA_VERSION`: otherwise every schema bump
 * (e.g. v3→v4) newly aliases already-split misc writes to tasks and fabricates
 * conflicts between disjoint settings during rollout.
 */
const MISC_TASKS_SPLIT_SCHEMA_VERSION = 2;

const isLegacyMiscConfigOperation = (op: Operation): boolean =>
  op.schemaVersion < MISC_TASKS_SPLIT_SCHEMA_VERSION &&
  op.entityType === 'GLOBAL_CONFIG' &&
  op.entityId === 'misc';

/**
 * The entity_ids array to persist with an op. Ops whose touched-entity set is
 * already covered by the scalar entity_id store an empty array; any other set is
 * stored in full.
 *
 * This makes the entity_ids GIN index CHEAP, not absent. Postgres indexes an empty
 * array as one degenerate GIN_CAT_EMPTY_ITEM key, so single-entity ops DO have index
 * entries, the index grows with row count (measured on an all-empty column: 10k rows
 * → 5 pages, 30k → 7, 60k → 11) and every insert still touches it. The win is one
 * key per single-entity op instead of one key per member, which keeps
 * `entity_ids @> ARRAY[id]` probes bounded by genuine multi-entity matches.
 *
 * The gate is "is the set exactly [entity_id]?", NOT "length > 1": a batch op
 * whose ids dedup to a single value that differs from entity_id (the server does
 * not enforce entity_id === entityIds[0]) must still be stored, or that entity
 * would be invisible to conflict lookups (#8334).
 */
export const getStoredEntityIds = (op: Operation): string[] => {
  // Preserve the historical storage normalization: the scalar is persisted in
  // entity_id and only the declared multi-entity set belongs in entity_ids.
  // Conflict detection unions both fields via getConflictEntityIds above.
  const ids = Array.from(
    new Set(op.entityIds?.length ? op.entityIds : op.entityId ? [op.entityId] : []),
  );
  if (ids.length <= 1 && ids[0] === op.entityId) {
    return [];
  }
  return ids;
};
