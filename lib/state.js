import fs from 'node:fs';
import path from 'node:path';

/** The on-disk schema contains only bridge metadata, never credentials or message text. */
export function emptyState() {
  return {
    version: 1, initialized: false, selfUsername: '', selfDisplayName: '', paused: false,
    chats: Object.create(null), stats: { triggers: 0, replies: 0, errors: 0, skipped: 0 },
    runtime: { ready: false, lastPollAt: 0, lastPollError: '', mcpSessionOk: false,
      writeBlocked: false, tokenMissing: false, lastReplyAt: 0, replies: 0, triggers: 0, skipped: 0 },
  };
}

/** Atomic, throttled state storage; invalid files are preserved for inspection. */
export class StateStore {
  constructor(filename, logger) {
    this.filename = filename;
    this.logger = logger;
    this.timer = null;
    this.lastWrite = 0;
    this.closed = false;
    this.data = this.load();
  }

  load() {
    const state = emptyState();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (raw?.version !== 1 || !raw.chats || typeof raw.chats !== 'object' || Array.isArray(raw.chats)) {
        throw new Error('Invalid bridge state schema');
      }
      state.initialized = raw.initialized === true;
      state.paused = raw.paused === true;
      for (const key of ['selfUsername', 'selfDisplayName']) if (typeof raw[key] === 'string') state[key] = raw[key];
      for (const [key, chat] of Object.entries(raw.chats)) {
        if (!chat || typeof chat !== 'object') throw new Error('Invalid chat state');
        state.chats[key] = {
          displayName: typeof chat.displayName === 'string' ? chat.displayName : key,
          isChatroom: chat.isChatroom === true,
          lastTime: Number.isFinite(chat.lastTime) && chat.lastTime >= 0 ? chat.lastTime : 0,
          sessionId: typeof chat.sessionId === 'string' ? chat.sessionId : '',
          lastReplyAt: Number.isFinite(chat.lastReplyAt) ? chat.lastReplyAt : 0,
          roomSelfName: typeof chat.roomSelfName === 'string' ? chat.roomSelfName : '',
          roomMembersFetchedAt: Number.isFinite(chat.roomMembersFetchedAt) ? chat.roomMembersFetchedAt : 0,
        };
      }
      for (const key of Object.keys(state.stats)) {
        if (Number.isFinite(raw.stats?.[key]) && raw.stats[key] >= 0) state.stats[key] = raw.stats[key];
      }
      // Runtime health must be established anew, not inherited from a prior process.
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try { fs.renameSync(this.filename, `${this.filename}.bad-${Date.now()}`); }
        catch (backupError) { this.logger.rate('state-backup', backupError); }
        this.logger.rate('state-load', error);
      }
      return emptyState();
    }
  }

  save(force = false) {
    if (this.closed && !force) return;
    if (!force && Date.now() - this.lastWrite < 2000) {
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.save(true); }, 2000 - (Date.now() - this.lastWrite));
        this.timer.unref?.();
      }
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
      fs.writeFileSync(`${this.filename}.tmp`, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(`${this.filename}.tmp`, this.filename);
      this.lastWrite = Date.now();
    } catch (error) { this.logger.rate('state-save', error); }
  }

  close() { this.closed = true; this.save(true); }
}
