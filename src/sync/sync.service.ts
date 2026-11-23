import { statement } from '../db';
import { DEFAULT_SYNC_CONFIG, RETENTION_MS, type Operation, type UploadResult } from './sync.types';
import { readPage, touchStatement, wipeDataset } from './storage';
import { upload, validator } from './upload';
import {
  readReceipt,
  saveReceipt,
  type SnapshotDedupResponse,
} from './services/request-deduplication.service';
import { limited } from '../web';
import { EncryptedOpsNotSupportedError } from './services/snapshot.service';
const usage = async (id: number) =>
  Number(
    await statement(
      'SELECT coalesce(sum(size),0) AS bytes FROM operations WHERE user_id=?',
      id,
    ).first('bytes'),
  );
const quota = 100 * 1024 * 1024;
const descriptions: Record<string, string> = {
  SYNC_IMPORT: 'Full sync import',
  BACKUP_IMPORT: 'Backup restore',
  REPAIR: 'Auto-repair',
};
export async function prune(id: number) {
  // A prefix may be pruned only if every removed row is old and the first
  // surviving row is a causal full-state boundary.
  const boundary = await statement(
    'SELECT max(seq) AS n FROM operations WHERE user_id=? AND causal=1 AND seq<=coalesce((SELECT min(seq) FROM operations WHERE user_id=? AND received>=?),9223372036854775807)',
    id,
    id,
    Date.now() - RETENTION_MS,
  ).first<number>('n');
  if (boundary)
    await statement('DELETE FROM operations WHERE user_id=? AND seq<?', id, boundary).run();
}
async function freeStorageForUpload(id: number, additional: number) {
  const original = await usage(id);
  let used = original,
    deletedOps = 0,
    deletedRestorePoints = 0;
  while (used + additional > quota && deletedRestorePoints < 50) {
    const points = (
      await statement(
        'SELECT seq FROM operations WHERE user_id=? AND causal=1 ORDER BY seq LIMIT 2',
        id,
      ).all<{ seq: number }>()
    ).results;
    if (points.length < 2) break;
    const seq = points[0].seq;
    const count = await statement(
      'SELECT count(*) AS n FROM operations WHERE user_id=? AND seq<=?',
      id,
      seq,
    ).first<number>('n');
    await statement('DELETE FROM operations WHERE user_id=? AND seq<=?', id, seq).run();
    deletedOps += count ?? 0;
    deletedRestorePoints++;
    used = await usage(id);
  }
  return {
    success: used + additional <= quota,
    freedBytes: original - used,
    deletedOps,
    deletedRestorePoints,
  };
}
const service = {
  isRateLimited: (id: number) =>
    limited(
      'sync-upload:' + id,
      DEFAULT_SYNC_CONFIG.uploadRateLimit.max,
      DEFAULT_SYNC_CONFIG.uploadRateLimit.windowMs,
    ),
  getLatestSeq: (id: number) =>
    statement('SELECT last_seq FROM users WHERE id=?', id)
      .first<number>('last_seq')
      .then((n) => n ?? 0),
  getLatestStateReplacementSeq: (id: number) =>
    statement('SELECT nullif(replacement_seq,0) AS seq FROM users WHERE id=?', id).first<number>(
      'seq',
    ),
  getOpsSinceWithSeq: readPage,
  getStorageInfo: async (id: number) => ({
    storageUsedBytes: await usage(id),
    storageQuotaBytes: quota,
  }),
  checkStorageQuota: async (id: number, amount: number) => {
    const currentUsage = await usage(id);
    return { currentUsage, quota, allowed: currentUsage + amount <= quota };
  },
  freeStorageForUpload,
  touchDevice: async (id: number, client: string, v: string | null) => {
    await touchStatement(id, client, v).run();
  },
  getOnlineDeviceCount: (id: number) =>
    statement(
      'SELECT count(*) AS n FROM devices WHERE user_id=? AND seen>?',
      id,
      Date.now() - 300000,
    )
      .first<number>('n')
      .then((x) => x ?? 0),
  listDevices: async (id: number) =>
    (
      await statement(
        'SELECT client AS clientId,seen AS lastSeenAt FROM devices WHERE user_id=? AND seen>? ORDER BY seen DESC LIMIT 100',
        id,
        Date.now() - RETENTION_MS,
      ).all<{ clientId: string; lastSeenAt: number }>()
    ).results,
  getRestorePoints: async (id: number, n: number) =>
    (
      await statement(
        "SELECT seq AS serverSeq,json_extract(meta,'$.timestamp') AS timestamp,json_extract(meta,'$.clientId') AS clientId,op_type AS type FROM operations WHERE user_id=? AND causal=1 ORDER BY seq DESC LIMIT ?",
        id,
        n,
      ).all<{ type: string }>()
    ).results.map((r) => ({ ...r, description: descriptions[r.type] })),
  async generateSnapshotAtSeq(id: number, seq: number): Promise<never> {
    const latest = await this.getLatestSeq(id);
    if (seq > latest)
      throw new Error('Target sequence ' + seq + ' exceeds latest sequence ' + latest);
    const count = await statement(
      'SELECT count(*) AS n FROM operations WHERE user_id=? AND seq<=?',
      id,
      seq,
    ).first<number>('n');
    if (!count) throw new Error('Target sequence ' + seq + ' is no longer available');
    if (seq > 100000) throw new Error('Too many operations to process (' + seq + '). Max: 100000.');
    throw new EncryptedOpsNotSupportedError(count);
  },
  deleteAllUserData: wipeDataset,
  uploadOps: upload,
  filterValidOpsForQuota: (ops: Operation[], client: string) =>
    ops.filter((o) => validator.validateOp(o, client).valid),
  checkOpsRequestDedup: (id: number, r: string, f: () => string) => readReceipt(id, 'ops', r, f),
  checkSnapshotRequestDedup: (id: number, r: string, f: () => string) =>
    readReceipt(id, 'snapshot', r, f),
  cacheOpsRequestResults: (id: number, r: string, v: UploadResult[], f: string) =>
    saveReceipt(id, 'ops', r, v, f),
  cacheSnapshotRequestResult: (id: number, r: string, v: SnapshotDedupResponse, f: string) =>
    saveReceipt(id, 'snapshot', r, v, f),
};
export const getSyncService = () => service;
