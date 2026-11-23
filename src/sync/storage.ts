import { statement } from '../db';
import { settings } from '../context';
import {
  type DuplicateOperationCandidate,
  type Operation,
  type ServerOperation,
  limitVectorClockSize,
  DEVICE_TOUCH_THROTTLE_MS,
  type VectorClock,
} from './sync.types';

export interface StoredRow {
  id: string;
  user_id: number;
  seq: number;
  received: number;
  meta: string;
  full_clock: string | null;
}
export async function occupiedIds(ids: string[]) {
  const { results } = await statement(
    'SELECT id FROM operations WHERE id IN (SELECT value FROM json_each(?))',
    JSON.stringify(ids),
  ).all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}
export function candidate(row: StoredRow): DuplicateOperationCandidate & { serverSeq: number } {
  const op: Operation = JSON.parse(row.meta);
  return {
    ...op,
    serverSeq: row.seq,
    userId: row.user_id,
    receivedAt: row.received,
    clientTimestamp: op.timestamp,
    entityId: op.entityId ?? null,
    entityIds: op.entityIds ?? [],
    isPayloadEncrypted: !!op.isPayloadEncrypted,
    syncImportReason: op.syncImportReason ?? null,
    repairBaseServerSeq: op.repairBaseServerSeq ?? null,
  };
}
export async function lookupOperation(id: string) {
  const row = await statement('SELECT * FROM operations WHERE id=?', id).first<StoredRow>();
  return row ? candidate(row) : null;
}
export function latestImport(id: number) {
  return statement(
    "SELECT id, json_extract(meta,'$.clientId') AS clientId, seq AS serverSeq FROM operations WHERE user_id=? AND op_type IN ('SYNC_IMPORT','BACKUP_IMPORT','REPAIR') ORDER BY seq DESC LIMIT 1",
    id,
  ).first<{ id: string; clientId: string; serverSeq: number }>();
}
export async function readPage(
  id: number,
  since: number,
  exclude: string | undefined,
  limit: number,
  metadata = true,
) {
  const bounds = await statement(
    'SELECT min(seq) AS lo,max(seq) AS hi FROM operations WHERE user_id=?',
    id,
  ).first<{ lo: number | null; hi: number | null }>();
  const latestSeq = bounds?.hi ?? 0;
  const boundary = await statement(
    'SELECT * FROM operations WHERE user_id=? AND causal=1 ORDER BY seq DESC LIMIT 1',
    id,
  ).first<StoredRow>();
  let cursor = since;
  let snapshotVectorClock: VectorClock | undefined;
  if (boundary && since < boundary.seq) {
    const op: Operation = JSON.parse(boundary.meta);
    const keep =
      op.opType === 'REPAIR' &&
      since > 0 &&
      boundary.seq - since <= 10000 &&
      (bounds?.lo ?? Infinity) <= since + 1 &&
      !(await statement(
        "SELECT 1 FROM operations WHERE user_id=? AND seq>? AND seq<? AND op_type IN ('REPAIR','SYNC_IMPORT','BACKUP_IMPORT') LIMIT 1",
        id,
        since,
        boundary.seq,
      ).first());
    if (!keep) {
      cursor = boundary.seq - 1;
      if (metadata)
        snapshotVectorClock = limitVectorClockSize(JSON.parse(boundary.full_clock!), [
          op.clientId,
          ...(exclude ? [exclude] : []),
        ]);
    }
  }
  const { results: rows } = await statement(
    "SELECT * FROM operations WHERE user_id=? AND seq>? AND seq<=? AND (? IS NULL OR json_extract(meta,'$.clientId')<>?) ORDER BY seq LIMIT ?",
    id,
    cursor,
    latestSeq,
    exclude ?? null,
    exclude ?? null,
    limit,
  ).all<StoredRow>();
  const payloads = new Map<string, string>();
  if (rows.length) {
    const ids = JSON.stringify(rows.map((r) => r.id));
    // Keep each D1 result below its byte limit even for a multi-megabyte snapshot.
    for (let offset = 0; ; offset += 32) {
      const { results } = await statement(
        'SELECT op,payload FROM chunks WHERE op IN (SELECT value FROM json_each(?)) ORDER BY op,part LIMIT 32 OFFSET ?',
        ids,
        offset,
      ).all<{ op: string; payload: string }>();
      for (const chunk of results)
        payloads.set(chunk.op, (payloads.get(chunk.op) ?? '') + chunk.payload);
      if (results.length < 32) break;
    }
  }
  const ops: ServerOperation[] = rows.map((row) => ({
    serverSeq: row.seq,
    receivedAt: row.received,
    op: { ...JSON.parse(row.meta), payload: JSON.parse(payloads.get(row.id)!) },
  }));
  const gapDetected =
    since > latestSeq ||
    (since > 0 &&
      (cursor < (bounds?.lo ?? 0) - 1 ||
        (!exclude && rows.length > 0 && rows[0].seq > cursor + 1)));
  return { ops, latestSeq, gapDetected, latestSnapshotSeq: boundary?.seq, snapshotVectorClock };
}
export function touchStatement(id: number, client: string, version?: string | null) {
  return statement(
    'INSERT INTO devices(user_id,client,seen,version) VALUES(?,?,?,?) ON CONFLICT(user_id,client) DO UPDATE SET seen=excluded.seen,version=CASE WHEN ? THEN excluded.version ELSE devices.version END WHERE devices.seen<? OR (? AND devices.version IS NOT excluded.version)',
    id,
    client,
    Date.now(),
    version ?? null,
    Number(version !== undefined),
    Date.now() - DEVICE_TOUCH_THROTTLE_MS,
    Number(version !== undefined),
  );
}
export async function wipeDataset(id: number) {
  await settings().DB.batch([
    statement('DELETE FROM sync_receipts WHERE user_id=?', id),
    statement('DELETE FROM operations WHERE user_id=?', id),
    statement('DELETE FROM devices WHERE user_id=?', id),
    statement('UPDATE users SET replacement_seq=0 WHERE id=?', id),
  ]);
}
