// Non-token usage is account-owned; every successful standalone service call contributes one row update.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { ServiceKind } from '@gense/protocol'

export const initializeServiceUsage = (db: SqliteDatabase) => db.run('CREATE TABLE IF NOT EXISTS service_usage (userId TEXT NOT NULL, day TEXT NOT NULL, service TEXT NOT NULL, calls INTEGER NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(userId, day, service))')

export async function recordServiceUsage(db: SqliteDatabase, userId: string, service: ServiceKind, units: number) {
  if (!Number.isSafeInteger(units) || units < 0) throw new Error('服务用量无效')
  const day = new Date().toISOString().slice(0, 10)
  await db.run('INSERT INTO service_usage VALUES (?, ?, ?, 1, ?) ON CONFLICT(userId, day, service) DO UPDATE SET calls = calls + 1, units = units + excluded.units', userId, day, service, units)
}
