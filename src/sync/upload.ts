import { settings } from '../context';
import { statement } from '../db';
import { candidate, touchStatement, type StoredRow } from './storage';
import {
  DEFAULT_SYNC_CONFIG,
  createStateReplacementRequiredResults,
  isCausalFullStateOperation,
  isFullStateOpType,
  limitVectorClockSize,
  type Operation,
  type UploadResult,
  type VectorClock,
} from './sync.types';
import {
  resolveConflictForExistingOp,
  getConflictEntityIds,
  getStoredEntityIds,
  isSameDuplicateOperation,
  isSameIncomingOperation,
} from './conflict';
import { ValidationService } from './services/validation.service';
import { computeOpStorageBytes } from './sync.const';
export const validator = new ValidationService(DEFAULT_SYNC_CONFIG);
const keyOf = (type: string, id: string) => JSON.stringify([type, id]);
// Group small operations so a full 100-operation client batch takes a few D1
// statements. The three tables use only JSON-compatible scalar columns.
function insertRows(
  table: 'operations' | 'chunks' | 'entities',
  rows: (number | string | null)[][],
) {
  const writes: D1PreparedStatement[] = [];
  if (!rows.length) return writes;
  const fields = rows[0].map((_, i) => "json_extract(value,'$[" + i + "]')").join(',');
  const sql = 'INSERT INTO ' + table + ' SELECT ' + fields + ' FROM json_each(?)';
  let page: string[] = [],
    bytes = 2;
  function flush() {
    if (page.length) writes.push(statement(sql, '[' + page.join(',') + ']'));
    page = [];
    bytes = 2;
  }
  for (const row of rows) {
    const data = JSON.stringify(row),
      length = Buffer.byteLength(data) + 1;
    if (bytes + length > 500000) flush();
    page.push(data);
    bytes += length;
  }
  flush();
  return writes;
}
export async function upload(
  id: number,
  client: string,
  ops: Operation[],
  clean = false,
  occupied?: ReadonlySet<string>,
  repairBase?: number,
  legacy = false,
  cursor?: number,
  attempt = 0,
): Promise<UploadResult[]> {
  // Each user's HTTP operations are serialized in its AccountHub. D1 also guards
  // the allocation counter and operation IDs, including collisions across users.
  const allocated = await statement('SELECT last_seq FROM users WHERE id=?', id).first<number>(
    'last_seq',
  );
  if (allocated === null) throw new Error('Unknown account');
  if (
    cursor !== undefined &&
    (await statement('SELECT 1 FROM users WHERE id=? AND replacement_seq>?', id, cursor).first())
  )
    return createStateReplacementRequiredResults(ops);
  if (ops.some((op) => op.opType === 'REPAIR') && !legacy && repairBase !== allocated) {
    return ops.map((op) =>
      op.opType === 'REPAIR'
        ? {
            opId: op.id,
            accepted: false,
            error: 'REPAIR snapshot does not include current server state',
            errorCode: 'REPAIR_STALE',
          }
        : {
            opId: op.id,
            accepted: false,
            error: 'Batch deferred because its REPAIR snapshot is stale',
            errorCode: 'INTERNAL_ERROR',
          },
    );
  }
  const collisions = (
    await statement(
      'SELECT * FROM operations WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(ops.map((o) => o.id)),
    ).all<StoredRow>()
  ).results;
  const saved = new Map(collisions.map((r) => [r.id, candidate(r)]));
  const valid = ops.map((op) => validator.validateOp(op, client));
  const pairs = ops.flatMap((op, i) =>
    valid[i].valid ? getConflictEntityIds(op).map((e) => [op.entityType, e]) : [],
  );
  const entities = new Map<string, Operation>();
  // Bound D1 parameters and return each matching operation's metadata once per page.
  for (let start = 0; !clean && start < pairs.length; start += 256) {
    const { results } = await statement(
      `WITH wanted AS (
          SELECT DISTINCT json_extract(value,'$[0]') AS t,json_extract(value,'$[1]') AS e FROM json_each(?)
        ), latest AS (
          SELECT t,e,max(seq) AS seq FROM wanted JOIN entities
          ON user_id=? AND entity_type=t AND entity_id=e GROUP BY t,e
        )
        SELECT o.meta,json_group_array(json_array(t,e)) AS keys FROM latest
        JOIN operations o ON o.user_id=? AND o.seq=latest.seq GROUP BY o.seq`,
      JSON.stringify(pairs.slice(start, start + 256)),
      id,
      id,
    ).all<{ meta: string; keys: string }>();
    for (const row of results) {
      const op: Operation = JSON.parse(row.meta);
      for (const [type, id] of JSON.parse(row.keys)) entities.set(keyOf(type, id), op);
    }
  }
  const fullClock: VectorClock = Object.create(null);
  let author = clean
    ? undefined
    : await statement(
        "SELECT json_extract(meta,'$.clientId') AS author FROM operations WHERE user_id=? AND causal=1 ORDER BY seq DESC LIMIT 1",
        id,
      ).first<string>('author');
  if (!clean && ops.some(isCausalFullStateOperation)) {
    const { results } = await statement(
      "SELECT k.key AS client,max(k.value) AS n FROM operations o,json_each(o.meta,'$.vectorClock') k WHERE o.user_id=? GROUP BY k.key",
      id,
    ).all<{ client: string; n: number }>();
    for (const r of results) fullClock[r.client] = r.n;
  }
  const operationRows: (number | string | null)[][] = [],
    chunkRows: (number | string)[][] = [],
    entityRows: (number | string)[][] = [];
  const results: UploadResult[] = [];
  const observed = new Map<string, Operation>();
  let seq = allocated;
  let replacement = 0;
  for (const [i, incoming] of ops.entries()) {
    const op = { ...incoming };
    const result: UploadResult = { opId: op.id, accepted: false };
    results.push(result);
    const old = saved.get(op.id);
    const seen = observed.get(op.id);
    if (!seen) observed.set(op.id, incoming);
    if (!seen && !valid[i].valid) {
      Object.assign(result, { error: valid[i].error, errorCode: valid[i].errorCode });
      continue;
    }
    if (old || seen || occupied?.has(op.id)) {
      const match = seen
        ? isSameIncomingOperation(seen, op)
        : old && isSameDuplicateOperation(old, id, op, DEFAULT_SYNC_CONFIG.maxClockDriftMs);
      result.errorCode = match ? 'DUPLICATE_OPERATION' : 'INVALID_OP_ID';
      result.error = match
        ? 'Duplicate operation ID'
        : old || seen
          ? 'Operation ID already belongs to a different operation'
          : 'Operation ID was already occupied before quota enforcement';
      continue;
    }
    if (op.opType === 'REPAIR' && !legacy && (repairBase ?? op.repairBaseServerSeq) !== seq) {
      result.error = 'REPAIR snapshot does not include current server state';
      result.errorCode = 'REPAIR_STALE';
      continue;
    }
    const ids = getConflictEntityIds(op);
    if (!isFullStateOpType(op.opType)) {
      for (const entity of ids) {
        const previous = entities.get(keyOf(op.entityType, entity));
        if (!previous) continue;
        const conflict = resolveConflictForExistingOp(op, entity, previous);
        if (conflict.hasConflict) {
          result.error = conflict.reason;
          result.errorCode =
            conflict.conflictType === 'concurrent' ||
            conflict.conflictType === 'equal_different_client'
              ? 'CONFLICT_CONCURRENT'
              : 'CONFLICT_SUPERSEDED';
          result.existingClock = conflict.existingClock;
          break;
        }
      }
      if (result.errorCode) continue;
    }
    const now = Date.now();
    const causal = isCausalFullStateOperation(op);
    if (causal) author = client;
    for (const [k, v] of Object.entries(op.vectorClock))
      fullClock[k] = Math.max(fullClock[k] ?? 0, v);
    op.vectorClock = limitVectorClockSize(op.vectorClock, author ? [client, author] : [client]);
    op.timestamp = Math.min(op.timestamp, now + DEFAULT_SYNC_CONFIG.maxClockDriftMs);
    const entityIds = getStoredEntityIds(op);
    op.entityIds = entityIds.length ? entityIds : undefined;
    const { payload, ...meta } = op;
    seq++;
    if (op.opType === 'SYNC_IMPORT' || op.opType === 'BACKUP_IMPORT') replacement = seq;
    operationRows.push([
      op.id,
      id,
      seq,
      JSON.stringify(meta),
      now,
      computeOpStorageBytes(op).bytes,
      op.opType,
      Number(causal),
      causal ? JSON.stringify(fullClock) : null,
    ]);
    const serialized = JSON.stringify(payload);
    for (let pos = 0; pos < serialized.length; pos += 400000)
      chunkRows.push([op.id, pos, serialized.slice(pos, pos + 400000)]);
    for (const entity of ids) entityRows.push([id, op.entityType, entity, seq]);
    for (const entity of ids) entities.set(keyOf(op.entityType, entity), op);
    Object.assign(result, { accepted: true, serverSeq: seq });
  }
  if (clean && !results.every((r) => r.accepted)) return results;
  const guard = statement(
    'INSERT INTO write_guard SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND last_seq=?)',
    id,
    allocated,
  );
  try {
    await settings().DB.batch([
      guard,
      ...(clean
        ? [
            statement('DELETE FROM sync_receipts WHERE user_id=?', id),
            statement('DELETE FROM operations WHERE user_id=?', id),
            statement('DELETE FROM devices WHERE user_id=?', id),
          ]
        : []),
      ...insertRows('operations', operationRows),
      ...insertRows('chunks', chunkRows),
      ...insertRows('entities', entityRows),
      statement(
        'UPDATE users SET last_seq=?, replacement_seq=CASE WHEN ?>0 OR ? THEN ? ELSE replacement_seq END WHERE id=?',
        seq,
        replacement,
        Number(clean),
        replacement,
        id,
      ),
      touchStatement(id, client),
      statement('DELETE FROM write_guard'),
    ]);
  } catch (e) {
    if (
      attempt < 4 &&
      (String(e).includes('UNIQUE constraint failed: operations.id') ||
        String(e).includes('stale_revision'))
    )
      return upload(id, client, ops, clean, occupied, repairBase, legacy, cursor, attempt + 1);
    throw e;
  }
  return results;
}
