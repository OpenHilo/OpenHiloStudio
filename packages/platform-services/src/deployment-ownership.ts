import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// A failed drain must retain ownership even if callers discard the deployment.
// Keep native connections alive until explicit release or process termination.
const activeOwnership = new Set<Database.Database>();

/** Single-host ownership on a local filesystem. Never unlink the lock file:
 * SQLite releases its OS lock when this connection closes or the process dies. */
export function acquireDeploymentOwnership(home: string): { close(): void } {
  if (!path.isAbsolute(home)) throw new Error('Deployment ownership requires an absolute home');
  const file = path.join(fs.realpathSync(home), '.studio-owner.sqlite');
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Deployment ownership file must be a regular file');
  let database: Database.Database | undefined;
  try {
    database = new Database(file, { timeout: 0 });
    // This separate database has no application data. Keep its exclusive
    // transaction open for the whole deployment, including shutdown draining.
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database?.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new Error('This deployment home is already in use by another owner. Stop that server before starting another; do not remove .studio-owner.sqlite.');
    }
    throw error;
  }
  const owned = database;
  activeOwnership.add(owned);
  return { close() {
    if (owned.open) owned.close();
    activeOwnership.delete(owned);
  } };
}
