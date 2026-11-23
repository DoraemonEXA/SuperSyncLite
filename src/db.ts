import { settings } from './context';

export type Bind = string | number | null | ArrayBuffer;
export function statement(sql: string, ...values: Bind[]) {
  return settings()
    .DB.prepare(sql)
    .bind(...values);
}
function tagged(parts: TemplateStringsArray, args: unknown[]) {
  return statement(
    parts.join('?'),
    ...args.map((v) => (typeof v === 'bigint' ? Number(v) : (v as Bind))),
  );
}
export const sql = {
  async rows<T>(parts: TemplateStringsArray, ...args: unknown[]): Promise<T> {
    return (await tagged(parts, args).all()).results as T;
  },
  async write(parts: TemplateStringsArray, ...args: unknown[]) {
    const [, count] = await settings().DB.batch<{ changed: number }>([
      tagged(parts, args),
      statement('SELECT changes() AS changed'),
    ]);
    return count.results[0].changed;
  },
};
export class AccountTransaction {
  writes: D1PreparedStatement[] = [];
  rows = sql.rows;
  write(parts: TemplateStringsArray, ...args: unknown[]) {
    this.writes.push(tagged(parts, args));
  }
}
// Capture and pairing perform conditional reads before deciding which writes to commit.
// Triggers cover their tables and account revocation. D1 rolls the entire batch back
// if any observation was invalidated. Callers queue writes only after the needed reads.
export async function transaction<T>(work: (tx: AccountTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const revision = await statement('SELECT revision FROM account_revision').first<number>(
      'revision',
    );
    const tx = new AccountTransaction();
    const result = await work(tx);
    if (!tx.writes.length) {
      if (
        revision ===
        (await statement('SELECT revision FROM account_revision').first<number>('revision'))
      )
        return result;
      continue;
    }
    try {
      await settings().DB.batch([
        statement('INSERT INTO write_guard SELECT revision=? FROM account_revision', revision),
        ...tx.writes,
        statement('DELETE FROM write_guard'),
      ]);
      return result;
    } catch (err) {
      if (!String(err).includes('stale_revision')) throw err;
    }
  }
  throw new Error('Contention while committing account changes');
}
