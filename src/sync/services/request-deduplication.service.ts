import type { UploadResult } from '../sync.types';
import type { Operation } from '../sync.types';
import { createHash } from 'node:crypto';
import { stableJsonStringify } from '../conflict';

import { statement } from '../../db';
const RECEIPT_TTL = 5 * 60 * 1000;
export interface SnapshotDedupResponse {
  accepted: boolean;
  serverSeq?: number;
  error?: string;
  errorCode?: string;
}

type Receipt = { ops: UploadResult[]; snapshot: SnapshotDedupResponse };

export async function readReceipt<N extends keyof Receipt>(
  id: number,
  kind: N,
  request: string,
  fingerprint: () => string,
): Promise<Receipt[N] | null> {
  const row = await statement(
    'SELECT fingerprint,result FROM sync_receipts WHERE user_id=? AND kind=? AND request=? AND expires>?',
    id,
    kind,
    request,
    Date.now(),
  ).first<{ fingerprint: string; result: string }>();
  return row && row.fingerprint === fingerprint() ? JSON.parse(row.result) : null;
}
export async function saveReceipt<N extends keyof Receipt>(
  id: number,
  kind: N,
  request: string,
  result: Receipt[N],
  fingerprint: string,
) {
  await statement(
    'INSERT INTO sync_receipts VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,kind,request) DO UPDATE SET fingerprint=excluded.fingerprint,result=excluded.result,expires=excluded.expires',
    id,
    kind,
    request,
    fingerprint,
    JSON.stringify(result),
    Date.now() + RECEIPT_TTL,
  ).run();
}
export const createOpsRequestFingerprint = (clientId: string, ops: Operation[]): string => {
  const logicalOps = ops.map((op) => ({
    ...op,
    payload: op.isPayloadEncrypted ? '[encrypted-payload]' : op.payload,
  }));
  return createHash('sha256')
    .update(stableJsonStringify({ clientId, ops: logicalOps }))
    .digest('base64url');
};

export interface SnapshotRequestFingerprintInput {
  state: unknown;
  clientId: string;
  reason: string;
  vectorClock: Record<string, number>;
  schemaVersion?: number;
  isPayloadEncrypted?: boolean;
  syncImportReason?: string;
  opId?: string;
  isCleanSlate?: boolean;
  snapshotOpType?: string;
  repairBaseServerSeq?: number;
}

export const createSnapshotRequestFingerprint = (
  request: SnapshotRequestFingerprintInput,
): string => {
  const logicalRequest = {
    ...request,
    state: request.isPayloadEncrypted ? '[encrypted-state]' : request.state,
  };
  return createHash('sha256').update(stableJsonStringify(logicalRequest)).digest('base64url');
};
