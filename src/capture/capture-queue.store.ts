import { createHmac } from 'node:crypto';
import { settings } from '../context';
import { uuidv7 } from 'uuidv7';
import { sql, transaction, type AccountTransaction } from '../db';
import {
  CAPTURE_APP_SHARE_GRANT_ID,
  CAPTURE_RETRY_WINDOW_MS,
  CAPTURE_MAX_CREATES_PER_GRANT_PER_DAY,
  CAPTURE_CLAIM_BATCH_SIZE,
  CAPTURE_LEASE_MS,
  CAPTURE_MAX_PENDING_PER_GRANT,
  CAPTURE_MAX_PENDING_PER_USER,
} from './capture.const';
import { parseCapturePublicKey, sealCapture } from './capture-seal';

/**
 * The sealed capture queue: enqueue from /mcp, claim and ack from the app.
 *
 * `taskId` rule: an item starts with taskId = itemId. A device taking over
 * another device's lease gets a fresh taskId; a device gets back the taskId
 * it was given for as long as it holds the lease. Two devices therefore never
 * create the same task id, and an ack from an old lease can't delete a newer
 * one. The app uses taskId as its capture id, so its receipts follow the
 * lease; a device that comes back after a takeover may duplicate the task
 * (accepted in the plan's failure modes), but never diverges on one id.
 */

export const CAPTURE_REPEAT_CYCLES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export const CAPTURE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface CaptureRepeat {
  cycle: (typeof CAPTURE_REPEAT_CYCLES)[number];
  /** 2 to 99; absent means every cycle. */
  every?: number;
  /** Weekly only; in Monday-first order, no duplicates. */
  weekdays?: (typeof CAPTURE_WEEKDAYS)[number][];
}

export interface CapturePayload {
  v: 1;
  title: string;
  notes?: string;
  /** `YYYY-MM-DD`; optional within v1, ignored by apps that predate it. */
  dueDate?: string;
  /** `HH:MM`, local to the importing device; only with `dueDate`. */
  dueTime?: string;
  /** Optional within v1; apps that predate it add a one-off task. */
  repeat?: CaptureRepeat;
  /** `YYYY-MM-DD`; optional within v1, ignored by apps that predate it. */
  deadlineDate?: string;
  /** `HH:MM`, local to the importing device; only with `deadlineDate`. */
  deadlineTime?: string;
  /** Whole minutes; optional within v1, ignored by apps that predate it. */
  estimateMinutes?: number;
  createdAt: number;
  client: string;
}

export type EnqueueResult = 'daily_limit' | 'queued' | 'switched_off' | 'revoked' | 'queue_full';

export interface ClaimedCapture {
  itemId: string;
  taskId: string;
  ciphertext: string;
  createdAt: number;
}

export type ClaimResult =
  { status: 'ok'; items: ClaimedCapture[] } | { status: 'no_key' } | { status: 'key_mismatch' };

export const enqueueCapture = async (
  userId: number,
  grantId: string,
  payload: CapturePayload,
): Promise<EnqueueResult> =>
  transaction(async (tx) => {
    // The key row lock serializes enqueue against key replacement and
    // switch-off, so no item is ever sealed to a key that is being dropped,
    // and makes the per-user cap exact.
    const keys = await tx.rows<Array<{ public_key: string }>>`
      SELECT public_key FROM capture_keys
      WHERE user_id = ${userId} AND disabled_at IS NULL`;
    if (keys.length === 0) return 'switched_off';
    // Auth ran before this transaction. The revision check orders a concurrent
    // revoke against the insert, so its discard sees the item.
    const grants = await tx.rows<unknown[]>`
      SELECT 1 FROM capture_grants
      WHERE id = ${grantId} AND user_id = ${userId} AND revoked_at IS NULL`;
    if (grants.length === 0) return 'revoked';

    const now = payload.createdAt;
    const digest = createHmac('sha256', settings().AUTH_SECRET)
      .update('capture-receipt\0')
      .update(
        JSON.stringify([
          payload.title,
          payload.notes,
          payload.dueDate,
          payload.dueTime,
          payload.repeat,
          payload.deadlineDate,
          payload.deadlineTime,
          payload.estimateMinutes,
        ]),
      )
      .digest('hex');
    if (
      (
        await tx.rows<
          object[]
        >`SELECT 1 FROM capture_receipts WHERE grant_id=${grantId} AND fingerprint=${digest} AND expires>${now}`
      ).length
    )
      return 'queued';
    if (
      (
        await tx.rows<
          object[]
        >`SELECT 1 FROM capture_daily WHERE grant_id=${grantId} AND until_ms>${now} AND count>=${CAPTURE_MAX_CREATES_PER_GRANT_PER_DAY}`
      ).length
    )
      return 'daily_limit';
    const counts = await tx.rows<Array<{ for_grant: bigint; for_user: bigint }>>`
      SELECT count(*) FILTER (WHERE grant_id = ${grantId}) AS for_grant,
        count(*) AS for_user
      FROM capture_items WHERE user_id = ${userId}`;
    if (
      Number(counts[0].for_grant) >= CAPTURE_MAX_PENDING_PER_GRANT ||
      Number(counts[0].for_user) >= CAPTURE_MAX_PENDING_PER_USER
    ) {
      return 'queue_full';
    }

    const itemId = uuidv7();
    const ciphertext = sealCapture(
      parseCapturePublicKey(keys[0].public_key),
      itemId,
      payload as unknown as Record<string, unknown>,
    );
    tx.write`
      INSERT INTO capture_items (id, user_id, grant_id, ciphertext, task_id, created_at)
      VALUES (${itemId}, ${userId}, ${grantId}, ${ciphertext}, ${itemId},
        ${BigInt(payload.createdAt)})`;
    tx.write`INSERT INTO capture_receipts VALUES(${grantId},${digest},${now + CAPTURE_RETRY_WINDOW_MS})
      ON CONFLICT(grant_id,fingerprint) DO UPDATE SET expires=excluded.expires`;
    tx.write`INSERT INTO capture_daily VALUES(${grantId},1,${now + 86400000})
      ON CONFLICT(grant_id) DO UPDATE SET count=CASE WHEN until_ms<=${now} THEN 1 ELSE count+1 END,
      until_ms=CASE WHEN until_ms<=${now} THEN excluded.until_ms ELSE until_ms END`;
    return 'queued';
  });

export type EnqueueSealedResult =
  'queued' | 'switched_off' | 'key_mismatch' | 'id_conflict' | 'queue_full';

/**
 * Stores an item a device sealed itself (Android share). The client's id is
 * the item id, so the seal's AAD binds to it and a retry is idempotent; the
 * task id is always server-issued, never the client id. A re-send after
 * another device acked (and deleted) the item therefore queues a new task id:
 * at worst a duplicate task, never one task id created on two devices.
 */
export const enqueueSealedCapture = async (
  userId: number,
  itemId: string,
  fingerprint: string,
  ciphertext: string,
  now: number = Date.now(),
): Promise<EnqueueSealedResult> =>
  transaction(async (tx) => {
    // Same lock order as enqueueCapture: the key row first.
    const keys = await tx.rows<Array<{ fingerprint: string }>>`
      SELECT fingerprint FROM capture_keys
      WHERE user_id = ${userId} AND disabled_at IS NULL`;
    if (keys.length === 0) return 'switched_off';
    if (keys[0].fingerprint !== fingerprint) return 'key_mismatch';

    // Before the cap, so a retry of a stored item never reads as full.
    const existing = await tx.rows<Array<{ user_id: number }>>`
      SELECT user_id FROM capture_items WHERE id = ${itemId}`;
    if (existing.length > 0) {
      return existing[0].user_id === userId ? 'queued' : 'id_conflict';
    }

    const counts = await tx.rows<Array<{ for_grant: bigint; for_user: bigint }>>`
      SELECT count(*) FILTER (WHERE grant_id = ${CAPTURE_APP_SHARE_GRANT_ID}) AS for_grant,
        count(*) AS for_user
      FROM capture_items WHERE user_id = ${userId}`;
    if (
      Number(counts[0].for_grant) >= CAPTURE_MAX_PENDING_PER_GRANT ||
      Number(counts[0].for_user) >= CAPTURE_MAX_PENDING_PER_USER
    ) {
      return 'queue_full';
    }

    // ON CONFLICT: a concurrent retry of the same id inserted first.
    tx.write`
      INSERT INTO capture_items (id, user_id, grant_id, ciphertext, task_id, created_at)
      VALUES (${itemId}, ${userId}, ${CAPTURE_APP_SHARE_GRANT_ID}, ${ciphertext},
        ${crypto.randomUUID()}, ${BigInt(now)})
      ON CONFLICT (id) DO NOTHING`;
    return 'queued';
  });

/** All of the user's pending items, whichever grant (if any) added them. */
export const countPendingCaptures = async (userId: number): Promise<number> => {
  const rows = await sql.rows<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM capture_items WHERE user_id = ${userId}`;
  return Number(rows[0].count);
};

/**
 * Leases up to one batch: every item already leased to this device first (so
 * the importer keeps its receipts), then unleased and expired ones, oldest
 * first. SKIP LOCKED keeps two devices claiming at once from sharing an item.
 */
export const claimCaptures = async (
  userId: number,
  deviceId: string,
  fingerprint: string,
  now: number = Date.now(),
): Promise<ClaimResult> => {
  const keys = await sql.rows<Array<{ fingerprint: string }>>`
    SELECT fingerprint FROM capture_keys
    WHERE user_id = ${userId} AND disabled_at IS NULL`;
  if (keys.length === 0) return { status: 'no_key' };
  if (keys[0].fingerprint !== fingerprint) return { status: 'key_mismatch' };

  const rows = await sql.rows<
    Array<{ id: string; task_id: string; ciphertext: string; created_at: bigint }>
  >`
    WITH picked AS MATERIALIZED (
      SELECT id FROM capture_items
      WHERE user_id = ${userId}
        -- Re-checked here: a key replaced since the check above means the
        -- items now belong to the new key.
        AND EXISTS (SELECT 1 FROM capture_keys k WHERE k.user_id = ${userId}
          AND k.fingerprint = ${fingerprint} AND k.disabled_at IS NULL)
        AND (lease_device_id IS NULL OR lease_device_id = ${deviceId}
          OR lease_until < ${BigInt(now)})
      ORDER BY (lease_device_id IS NOT DISTINCT FROM ${deviceId}) DESC, created_at, id
      LIMIT ${CAPTURE_CLAIM_BATCH_SIZE}
      
    )
    UPDATE capture_items AS c SET
      task_id = CASE
        WHEN c.lease_device_id IS NOT NULL AND c.lease_device_id <> ${deviceId}
          THEN lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))
        ELSE c.task_id
      END,
      lease_device_id = ${deviceId},
      lease_until = ${BigInt(now + CAPTURE_LEASE_MS)}
    FROM picked WHERE c.id = picked.id
    RETURNING id, task_id, ciphertext, created_at`;

  const items = rows
    .map((row) => ({
      itemId: row.id,
      taskId: row.task_id,
      ciphertext: row.ciphertext,
      createdAt: Number(row.created_at),
    }))
    .sort((a, b) => a.createdAt - b.createdAt || a.itemId.localeCompare(b.itemId));
  return { status: 'ok', items };
};

/** Deletes only rows still leased to this device under the given task id. */
export const ackCaptures = async (
  userId: number,
  deviceId: string,
  acks: ReadonlyArray<{ itemId: string; taskId: string }>,
): Promise<number> => {
  if (acks.length === 0) return 0;
  return sql.write`DELETE FROM capture_items WHERE user_id = ${userId} AND lease_device_id = ${deviceId}
    AND EXISTS (SELECT 1 FROM json_each(${JSON.stringify(acks)}) WHERE json_extract(value,'$.itemId') = capture_items.id AND json_extract(value,'$.taskId') = capture_items.task_id)`;
};

/** Items no device claimed within the retention period. */
export const deleteExpiredCaptures = async (cutoff: number): Promise<number> =>
  sql.write`DELETE FROM capture_items WHERE created_at < ${BigInt(cutoff)}`;
