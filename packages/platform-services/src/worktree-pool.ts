import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { git } from './publication';

export interface WorktreeSlot {
  status: 'idle' | 'active' | 'retained' | 'archiving' | 'vacant';
  sessionId?: string;
  archivePath?: string;
  reason?: string;
}
interface PoolState { version: 1; slots: Record<string, WorktreeSlot> }
export interface WorktreePoolOptions { brainDir: string; poolDir: string; size?: number }

export class WorktreeCapacityError extends Error {
  constructor(readonly blockingSessionIds: string[]) {
    super('No translator slot available; active or retained worktrees must be explicitly released');
    this.name = 'WorktreeCapacityError';
  }
}

/** Durable, local leases. Uncertain ownership never becomes an idle slot on restart. */
export class WorktreePool {
  private readonly brain: string;
  private readonly pool: string;
  private readonly size: number;
  constructor(options: WorktreePoolOptions) {
    this.brain = path.resolve(options.brainDir); this.pool = path.resolve(options.poolDir); this.size = options.size ?? 8;
    if (!Number.isSafeInteger(this.size) || this.size < 1) throw new Error('Invalid worktree pool size');
  }
  snapshot(): Record<string, WorktreeSlot> { return this.read().slots; }
  initialize(): boolean {
    return this.locked(() => {
      git(this.brain, ['rev-parse', '--git-dir']);
      const state = this.read(); let changed = !fs.existsSync(this.stateFile());
      for (let i = 1; i <= this.size; i++) {
        const name = `ws-${String(i).padStart(2, '0')}`;
        if (state.slots[name]) continue;
        const directory = this.slotPath(name);
        if (fs.existsSync(directory)) state.slots[name] = { status: 'retained', reason: 'Existing worktree has no durable owner; explicit claim or archival is required' };
        else { this.create(name); state.slots[name] = { status: 'idle' }; }
        changed = true;
      }
      if (changed) this.save(state);
      return changed;
    });
  }
  checkout(sessionId: string): string {
    this.validateSession(sessionId);
    this.initialize();
    return this.locked(() => {
      const state = this.read();
      if (Object.values(state.slots).some(slot => slot.sessionId === sessionId && slot.status === 'active')) throw new Error('Session already owns a worktree; restore its saved lease');
      for (const [name, slot] of Object.entries(state.slots)) {
        if (slot.status !== 'idle' && slot.status !== 'vacant') continue;
        const directory = this.slotPath(name);
        if (fs.existsSync(directory)) {
          this.assertRegistered(directory);
          const current = git(directory, ['rev-parse', 'HEAD']).trim();
          const target = git(this.brain, ['rev-parse', 'HEAD']).trim();
          if (current !== target || git(directory, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']).trim()) {
            this.archive(state, name, 'Idle workspace changed; contents preserved before reuse');
          }
        }
        if (!fs.existsSync(directory)) this.create(name);
        state.slots[name] = { status: 'active', sessionId };
        this.save(state); // Ownership is durable before exposing the directory.
        return directory;
      }
      throw new WorktreeCapacityError([...new Set(Object.values(state.slots).flatMap(slot => slot.sessionId ? [slot.sessionId] : []))]);
    });
  }
  assertOwner(directory: string, sessionId: string): void {
    const name = this.slotName(directory), slot = this.read().slots[name];
    if (slot?.status !== 'active' || slot.sessionId !== sessionId) throw new Error('Worktree lease does not belong to this session; restore or explicitly migrate ownership');
    this.assertRegistered(this.slotPath(name));
  }
  release(directory: string, sessionId: string): string {
    return this.locked(() => {
      this.assertOwner(directory, sessionId);
      const name = this.slotName(directory), state = this.read();
      return this.archive(state, name, 'Session released its workspace');
    });
  }
  /** Explicit migration after the application verifies the saved session's ownership. */
  claimRetained(directory: string, sessionId: string): void {
    this.validateSession(sessionId);
    this.locked(() => {
      const name = this.slotName(directory), state = this.read();
      if (state.slots[name]?.status !== 'retained') throw new Error('Only a retained workspace can be explicitly claimed');
      if (Object.values(state.slots).some(slot => slot.sessionId === sessionId && ['active', 'archiving'].includes(slot.status))) throw new Error('Session already has a lease');
      this.assertRegistered(directory);
      state.slots[name] = { status: 'active', sessionId }; this.save(state);
    });
  }
  /** Explicit operator archival of an unowned legacy workspace; no file is deleted. */
  archiveRetained(name: string): string {
    return this.locked(() => {
      const state = this.read();
      if (state.slots[name]?.status !== 'retained') throw new Error('Only retained workspaces may be archived without a session lease');
      return this.archive(state, name, 'Explicit archival of a retained legacy workspace');
    });
  }
  /** Resume only a recorded archival, never guess whether an active lease is abandoned. */
  recoverArchival(name: string): string {
    return this.locked(() => {
      const state = this.read(); const slot = state.slots[name];
      if (slot?.status !== 'archiving' || !slot.archivePath) throw new Error('No recorded archival to recover');
      return this.finishArchive(state, name);
    });
  }
  private archive(state: PoolState, name: string, reason: string): string {
    const destination = path.join(this.pool, 'archives', `${name}-${crypto.randomUUID()}`);
    state.slots[name] = { ...state.slots[name], status: 'archiving', archivePath: destination, reason };
    this.save(state);
    return this.finishArchive(state, name);
  }
  private finishArchive(state: PoolState, name: string): string {
    const source = this.slotPath(name), slot = state.slots[name];
    const destination = slot.archivePath!;
    if (path.dirname(destination) !== path.join(this.pool, 'archives') || !path.basename(destination).startsWith(`${name}-`)) throw new Error('Invalid archival path');
    const sourceExists = fs.existsSync(source), targetExists = fs.existsSync(destination);
    if (sourceExists === targetExists) throw new Error('Ambiguous archival state; files were preserved');
    if (sourceExists) {
      this.assertRegistered(source);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      git(this.brain, ['worktree', 'move', source, destination]);
    }
    this.assertRegistered(destination);
    fs.writeFileSync(destination + '.lease.json', JSON.stringify({ version: 1, ...slot, slot: name, archivedAt: new Date().toISOString() }, null, 2));
    state.slots[name] = { status: 'vacant' }; this.save(state);
    return destination;
  }
  private create(name: string): void { git(this.brain, ['worktree', 'add', '--detach', this.slotPath(name), 'HEAD']); }
  private assertRegistered(directory: string): void {
    if (!fs.existsSync(path.join(directory, '.git')) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Not a managed Git worktree');
    const common = (dir: string) => fs.realpathSync(path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']).trim()));
    if (common(directory) !== common(this.brain) || fs.realpathSync(git(directory, ['rev-parse', '--show-toplevel']).trim()) !== fs.realpathSync(directory)) throw new Error('Worktree belongs to a different repository');
  }
  private slotPath(name: string): string {
    if (!/^ws-\d+$/.test(name)) throw new Error('Invalid pool slot');
    return path.join(this.pool, name);
  }
  private slotName(directory: string): string {
    const normalized = path.resolve(directory), name = path.basename(normalized);
    if (normalized !== this.slotPath(name)) throw new Error('Workspace is outside this pool');
    return name;
  }
  private validateSession(sessionId: string): void { if (!sessionId.trim()) throw new Error('Session identity is required'); }
  private stateFile(): string { return path.join(this.pool, 'pool-state.json'); }
  private read(): PoolState {
    if (!fs.existsSync(this.stateFile())) return { version: 1, slots: {} };
    const raw = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid pool state; repair explicitly without discarding ownership');
    if (raw.version === 1 && raw.slots && typeof raw.slots === 'object' && !Array.isArray(raw.slots)) {
      for (const [name, value] of Object.entries(raw.slots)) {
        this.slotPath(name); const slot = value as WorktreeSlot;
        if (!slot || !['idle', 'active', 'retained', 'archiving', 'vacant'].includes(slot.status) || (slot.status === 'active' && (typeof slot.sessionId !== 'string' || !slot.sessionId.trim()))) throw new Error('Invalid pool lease');
      }
      return raw;
    }
    if ('version' in raw) throw new Error('Unsupported pool state version');
    const slots: Record<string, WorktreeSlot> = {};
    for (const [name, status] of Object.entries(raw)) {
      this.slotPath(name);
      if (typeof status !== 'string') throw new Error('Invalid legacy pool state');
      slots[name] = status.startsWith('active:') && status.slice(7) ? { status: 'active', sessionId: status.slice(7) }
        : { status: 'retained', reason: 'Legacy idle state did not prove ownership; explicit migration is required' };
    }
    return { version: 1, slots };
  }
  private save(state: PoolState): void {
    const temporary = this.stateFile() + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2)); fs.renameSync(temporary, this.stateFile());
  }
  private locked<T>(operation: () => T): T {
    fs.mkdirSync(this.pool, { recursive: true });
    const lock = path.join(this.pool, '.pool.lock');
    try { fs.mkdirSync(lock); } catch { throw new Error('Worktree pool is locked or has an interrupted operation; inspect its state before recovery'); }
    try { return operation(); } finally { fs.rmdirSync(lock); }
  }
}
