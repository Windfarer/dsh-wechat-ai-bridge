import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Semaphore, withTimeout, seconds, isChatroom, isTextMessage, isImageMessage, isFileMessage, isQuoteMessage, isVoiceRequest, escapeRegExp, resolveToken, jsonValue, chatWorkspaceSegment } from './util.js';
import { sendSucceeded } from './wechat-api.js';
import { registerWorkspaceTools, resolveWorkspacePath } from './workspace-tools.js';

const REPLY_INSTRUCTIONS = `请直接输出要发送到该微信会话的回复正文。要求：
- 只输出回复正文，不要输出“回复：”“以下是回复”等前缀，不要输出思考过程；
- 使用与对方相同的语言；闲聊场景保持简短自然（1-3 句）；
- 不要使用 Markdown 标题、粗体、代码块（微信不渲染）；条目可用中文标点；
- 若消息只是表情/无意义内容，简短回应即可；
- 你的输出会被自动发送，不要说“我会发送”之类的话。`;

/**
 * Read-only WeChat context tools kept by the chat preset. Work mode configures
 * an explicit allowlist instead; either way these are the only global tools
 * (registered by this plugin) that a bridge Agent may see.
 */
const BRIDGE_CHAT_TOOLS = [
  'wechat_recent_messages',
];

const SENDER_PROFILE_TTL_MS = 30 * 60 * 1000;
const MAX_SENDER_PROFILES = 1000;

/** Build one chronological user message for an entire debounced batch. */
export function formatPrompt(contact, batch, roomSelfName, maxChars, personaText = '') {
  const group = isChatroom(contact);
  const persona = String(personaText ?? '').trim();
  const roleHeader = persona ? `［角色设定］\n请始终遵循以下人设：\n${persona}\n\n` : '';
  const header = roleHeader + `［微信新消息］\n会话：${contact.display_name || contact.username}（${group ? '群聊' : '私聊'}）\n`
    + (group ? `群内昵称：${roomSelfName || '未知'}\n` : '');
  const messages = [...batch].sort((a, b) => a.message.create_time - b.message.create_time).map(({ message: m, mentioned }) => {
    const time = m.time || new Date(m.create_time * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const body = isImageMessage(m)
      ? '【图片】（桥接会尝试把原图作为附件提供，成功与否见末尾说明）'
      : (isFileMessage(m) ? '【文件】（桥接会尝试保存到工作区，成功与否见末尾说明）' : m.text);
    const nickname = m.sender_nick_name || '未知';
    return `发送者微信昵称：${nickname}\n发送者ID：${m.sender_username || '未知'}\n`
      + (group ? `发送者群昵称：${m.sender_display || '未知'}\n`
        : (m.sender_remark && m.sender_remark !== nickname ? `发送者备注：${m.sender_remark}\n` : ''))
      + `时间：${time}\n`
      + (group && mentioned ? '本条消息 @ 了你。\n' : '') + `\n内容：\n${body}`;
  }).join('\n\n——\n\n');
  // Reserve space for the output contract when truncating normal-sized prompts.
  const suffix = `\n\n${REPLY_INSTRUCTIONS}`;
  if (maxChars <= suffix.length) return (header + messages + suffix).slice(0, maxChars);
  return (header + messages).slice(0, maxChars - suffix.length) + suffix;
}

/** Polling and agent orchestration live here; all DSH operations use the Host context. */
export class Bridge {
  constructor(ctx, config, store, api, logger) {
    this.ctx = ctx;
    this.config = config;
    this.store = store;
    this.state = store.data;
    this.api = api;
    this.logger = logger;
    this.agents = new Map();
    this.chats = new Map();
    // Contact metadata stays in memory, outside the persisted bridge state.
    this.senderProfiles = new Map();
    this.knownSessions = new Set(Object.values(this.state.chats).map(chat => chat.sessionId).filter(Boolean));
    this.lastAssistantText = new Map();
    this.turnReasons = new Map();
    this.replyTimes = new Map();
    // Sessions where a successful wechat_send_voice call replaced the final text reply.
    this.voiceSentSessions = new Set();
    // Sessions where the Agent has declared this turn will answer by voice.
    // The declaration cancels the delayed "working" notice before audio exists.
    this.voiceIntentSessions = new Set();
    // Delayed "working" notices, keyed by session, so a voice send can cancel
    // the notice before it becomes a stray text bubble after the voice.
    this.workingNoticeTimers = new Map();
    // Avoid sending the same variant of the "working" notice twice in a row.
    this.lastWorkingNotice = new Map();
    // Recent image messages per chat, used as visual context for a following
    // text trigger (group images alone never trigger a reply).
    this.imageContext = new Map();
    // Recent file messages (path/file_name/file_size) for the same context.
    this.fileContext = new Map();
    // Optional Codex CLI subagent, staged into the workspace jail.
    this.codex = { enabled: false, binary: '', timeoutMs: 0 };
    this.codexAuthSource = '';
    this.codexWorkspaces = new Set();
    // sha256 → time of images the model already saw, so a normal follow-up does
    // not re-attach the same pixels over and over.
    this.sentImageHashes = new Map();
    this.modelImageSupport = undefined;
    this.identityNames = new Set();
    this.identityResolved = false;
    this.identityContactsFetched = false;
    this.semaphore = new Semaphore(config.maxConcurrentChats);
    this.stopSignal = new AbortController();
    this.tasks = new Set();
    this.stopped = false;
    this.ticking = false;
    this.pauseGeneration = 0;
    this.resumeBaselinePending = false;
    this.workspaces = new Map();
    this.workspaceRoot = '';
  }

  /** Register this synchronously in apply, before any turn can emit an event. */
  onSessionEvent(session, event) {
    if (this.stopped || !this.knownSessions.has(session?.id)) return;
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return;
      const text = content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
      if (text.trim()) this.lastAssistantText.set(session.id, text);
    } else if (event?.type === 'turn/end') {
      const reason = event.data?.reason?.kind || 'unknown';
      this.turnReasons.set(session.id, reason);
      if (reason !== 'completed') this.logger.rate('turn-end', `Session ${session.id}: ${reason}`);
    }
  }

  track(promise) {
    this.tasks.add(promise);
    promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
    return promise;
  }

  start() {
    this.logger.info('Starting WeChat bridge');
    this.interval = setInterval(() => this.track(this.tick()), this.config.pollIntervalMs);
    this.interval.unref?.();
    // Agent creation waits for migration checks; apply() stays synchronous.
    this.preparation = this.track(this.prepareWorkspace());
    this.track(this.tick());
  }

  /** Check stored sessions without eagerly creating per-chat directories. */
  async prepareWorkspace() {
    try {
      if (this.config.workspaceMode === 'shared') await this.ensureWorkspace();
      await this.rehomeStoredSessions();
      await this.resolveImageSupport();
    } catch (error) {
      if (!this.stopped) this.logger.rate('workspace', error);
    }
  }

  /**
   * Stage the standalone Codex CLI for the workspace jail.
   *
   * The binary stays on the host and is bind-mounted read-only per run. Auth is
   * copied into <workspace>/.codex so Codex can authenticate; that token is
   * readable by anything inside the workspace, so this is a deliberate
   * trade-off (prefer a dedicated account for this sandbox).
   */
  async prepareCodex(workspace) {
    if (!this.config.codex.enabled) return;
    try {
      if (!this.codex.enabled) {
        const candidates = [
          this.config.codex.binary,
          path.join(os.homedir(), '.local/bin/codex'),
          '/usr/local/bin/codex',
          '/usr/bin/codex',
        ].filter(Boolean);
        const binary = candidates.find(candidate => {
          try { return fs.statSync(candidate).isFile(); } catch { return false; }
        });
        if (!binary) throw new Error('Codex binary not found; set codex.binary');
        this.codexBinary = fs.realpathSync(binary);
        const hostBinary = path.join(path.dirname(this.codexBinary), 'codex-code-mode-host');
        this.codexHostBinary = fs.existsSync(hostBinary) ? hostBinary : '';
        const authSource = this.config.codex.authSource || path.join(os.homedir(), '.codex');
        if (!fs.existsSync(path.join(authSource, 'auth.json'))) {
          throw new Error(`Codex auth not found under ${authSource}`);
        }
        this.codexAuthSource = authSource;
        this.codex = {
          enabled: true, binary: this.codexBinary, hostBinary: this.codexHostBinary,
          timeoutMs: this.config.codex.timeoutMs,
        };
        this.logger.warn('Codex auth.json is readable inside each workspace sandbox; use a dedicated account if this matters');
      }
      const codexHome = this.codexDirectory(workspace.dir);
      this.syncCodexAuth(workspace.dir);
      const configTarget = resolveWorkspacePath(workspace.dir, '.codex/config.toml');
      if (!fs.existsSync(configTarget)) {
        let base = '';
        try { base = fs.readFileSync(path.join(this.codexAuthSource, 'config.toml'), 'utf8'); } catch { /* minimal config */ }
        if (!base.includes('[projects."/workspace"]')) {
          base += `${base && !base.endsWith('\n') ? '\n' : ''}[projects."/workspace"]\ntrust_level = "trusted"\n`;
        }
        fs.writeFileSync(configTarget, base, { mode: 0o600, flag: 'wx' });
      }
      workspace.codex = { ...this.codex };
      workspace.codexHome = codexHome;
      this.codexWorkspaces.add(workspace.dir);
    } catch (error) {
      workspace.codex = { enabled: false, binary: '', timeoutMs: 0 };
      this.logger.rate('codex', error);
    }
  }

  codexDirectory(dir) {
    const home = resolveWorkspacePath(dir, '.codex');
    try {
      if (fs.lstatSync(home).isSymbolicLink()) throw new Error('Codex home must not be a symlink');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  }

  /** Refresh the staged auth token before a Codex run (host may have refreshed it). */
  syncCodexAuth(dir) {
    if (!this.codexAuthSource) return;
    let temporary;
    try {
      const home = this.codexDirectory(dir);
      temporary = path.join(home, `.auth-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, fs.readFileSync(path.join(this.codexAuthSource, 'auth.json')), { mode: 0o600, flag: 'wx' });
      // Replace the directory entry rather than following an existing auth symlink.
      fs.renameSync(temporary, path.join(home, 'auth.json'));
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
    }
  }

  /** Resolve once whether the configured/default route accepts image input. */
  async resolveImageSupport() {
    if (this.modelImageSupport !== undefined) return;
    let selected;
    try {
      selected = this.config.model.provider && this.config.model.model
        ? this.config.model : this.ctx.agentDefaultModel.currentSelection();
    } catch { return; }
    if (!selected?.provider || !selected?.model) return;
    try {
      const info = await this.ctx.llm.resolveModelInfo(selected.provider, selected.model);
      this.modelImageSupport = info?.inputModalities?.includes('image') === true;
    } catch (error) {
      this.modelImageSupport = false;
      this.logger.rate('image-support', error);
    }
  }

  /** Derive a chat path without creating directories or registry entries. */
  workspacePathForChat(username) {
    let root = this.workspaceRoot || this.config.workspacePath;
    try { root = fs.realpathSync(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.config.workspaceMode === 'shared') return root;
    const dir = path.join(root, chatWorkspaceSegment(username));
    // Reject aliases even when they point at a sibling chat inside the root.
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Chat workspace must not be a symlink');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return dir;
  }

  /** Cache creation promises so simultaneous requests share one registry entity. */
  async ensureWorkspace(contact) {
    const key = this.config.workspaceMode === 'shared' ? 'shared' : contact?.username;
    if (this.config.workspaceMode !== 'shared') chatWorkspaceSegment(key);
    let pending = this.workspaces.get(key);
    if (!pending) {
      pending = (async () => {
        fs.mkdirSync(this.config.workspacePath, { recursive: true });
        this.workspaceRoot = fs.realpathSync(this.config.workspacePath);
        const expectedDir = this.workspacePathForChat(key);
        fs.mkdirSync(expectedDir, { recursive: true });
        const dir = fs.realpathSync(expectedDir);
        if (dir !== expectedDir) throw new Error('Chat workspace path changed during creation');
        const displayName = String(contact?.display_name || key).replace(/[\r\n\t]/g, ' ').slice(0, 80);
        const title = this.config.workspaceMode === 'shared' ? this.config.workspaceTitle
          : `${this.config.workspaceTitle} · ${isChatroom(contact) ? '微信群' : '微信'} · ${displayName}`;
        const registry = this.ctx.workspaceRegistry;
        const workspace = await registry.resolveByPath?.(dir) || await registry.create(dir, title);
        const result = { dir, workspace, codex: { enabled: false, binary: '', timeoutMs: 0 } };
        await this.prepareCodex(result);
        return result;
      })();
      this.workspaces.set(key, pending);
    }
    try {
      const result = await pending;
      if (fs.realpathSync(this.workspacePathForChat(key)) !== result.dir) {
        throw new Error('Chat workspace path changed');
      }
      return result;
    } catch (error) {
      if (this.workspaces.get(key) === pending) this.workspaces.delete(key);
      throw error;
    }
  }

  /** Whether one live session's header cwd is the configured workspace directory. */
  sessionMatchesWorkspace(session, expectedDir) {
    const cwd = session?.header?.cwd;
    if (!expectedDir || typeof cwd !== 'string') return false;
    try { return fs.realpathSync(cwd) === fs.realpathSync(expectedDir); } catch { return false; }
  }

  /** Resolve global tool calls to the calling Agent's active bridge chat. */
  async currentChatScope() {
    const agent = await this.ctx.agents.currentInitiator?.();
    const sessionId = typeof agent === 'string' ? agent : agent?.id ?? agent?.sessionId;
    if (!sessionId) return undefined;
    for (const [username, entry] of this.agents) {
      if (entry.sessionId === sessionId) {
        return { username, displayName: this.state.chats[username]?.displayName || username };
      }
    }
    return undefined;
  }

  /** Media tools must fail closed when there is no active bridge chat. */
  async mediaWorkspaceRoot(toolName) {
    if (this.config.workspaceMode === 'shared') return (await this.ensureWorkspace()).dir;
    const initiator = await this.ctx.agents.currentInitiator?.();
    const sessionId = typeof initiator === 'string' ? initiator : initiator?.id ?? initiator?.sessionId;
    if (sessionId) {
      for (const [username, entry] of this.agents) {
        if (entry.sessionId !== sessionId) continue;
        const expected = this.workspacePathForChat(username);
        if (entry.workspaceDir === expected && this.sessionMatchesWorkspace(entry.handle.agent.session, expected)) {
          return expected;
        }
      }
    }
    throw new Error(`${toolName} requires an active WeChat bridge chat in per-chat workspace mode`);
  }

  /** Global image tools must fail closed when there is no active bridge chat. */
  async imageWorkspaceRoot() { return this.mediaWorkspaceRoot('wechat_send_image'); }

  /** Voice clips are staged from the same chat-scoped workspace as images. */
  async voiceWorkspaceRoot() { return this.mediaWorkspaceRoot('wechat_send_voice'); }

  /** Cancel a delayed "working" notice that has not fired yet. */
  clearWorkingNotice(sessionId) {
    const timer = this.workingNoticeTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.workingNoticeTimers.delete(sessionId);
  }

  /**
   * The Agent declares that this turn will answer with voice. Called before
   * audio is generated/sent, so the "working" text notice never appears when
   * the user asked for a voice reply (or the Agent chose one).
   */
  noteVoiceIntent(scope) {
    const entry = this.agents.get(scope?.username);
    if (!entry) return false;
    this.voiceIntentSessions.add(entry.sessionId);
    this.clearWorkingNotice(entry.sessionId);
    return true;
  }

  /** Mark the current chat's session so runBatch suppresses its duplicate text reply. */
  noteVoiceSent(scope) {
    const entry = this.agents.get(scope?.username);
    if (!entry) return;
    this.voiceSentSessions.add(entry.sessionId);
    // A voice bubble is already a reply; a pending "working" notice would show
    // up after it as a stray text message.
    this.clearWorkingNotice(entry.sessionId);
  }

  /**
   * Forget chat → session mappings that live in another workspace. DSH decides
   * workspace membership from the immutable SessionHeader.cwd, so an existing
   * session can never be re-attached elsewhere; the next message for that chat
   * creates a fresh session inside the dedicated workspace while the old
   * session keeps its history in the old workspace.
   */
  async rehomeStoredSessions() {
    const persistence = this.ctx.get('sessionPersistence');
    if (!persistence) return;
    let changed = false;
    for (const [chatKey, chat] of Object.entries(this.state.chats)) {
      if (!chat.sessionId) continue;
      try {
        const snapshot = await persistence.stat(chat.sessionId);
        if (!snapshot) {
          this.logger.info(`Dropping missing bridge session ${chat.sessionId} for ${chatKey}`);
          chat.sessionId = '';
          changed = true;
          continue;
        }
        if (!this.sessionMatchesWorkspace(snapshot, this.workspacePathForChat(chatKey))) {
          this.logger.info('Clearing a bridge session mapping outside its configured chat workspace');
          chat.sessionId = '';
          changed = true;
          continue;
        }
        // A preset switch (chat → work) needs a fresh session too: the new
        // composition supplies a different tool set to the same conversation.
        const recordedPreset = snapshot.header.agentPreset;
        if (recordedPreset && recordedPreset !== this.config.agentPreset) {
          this.logger.info(`Chat ${chatKey} switches preset ${recordedPreset} → ${this.config.agentPreset}`);
          chat.sessionId = '';
          changed = true;
        }
      } catch (error) {
        this.logger.rate('workspace-rehome', error);
      }
    }
    if (changed) this.store.save(true);
  }

  syncRuntime() {
    Object.assign(this.state.runtime, {
      mcpSessionOk: this.api.client.sessionOk,
      replies: this.state.stats.replies, triggers: this.state.stats.triggers, skipped: this.state.stats.skipped,
    });
  }

  noteSkipped(count = 1) { this.state.stats.skipped += count; }

  chatState(contact) {
    const key = contact.username;
    if (!Object.hasOwn(this.state.chats, key)) {
      this.state.chats[key] = { displayName: contact.display_name || key, isChatroom: isChatroom(contact),
        lastTime: 0, sessionId: '', lastReplyAt: 0, roomSelfName: '', roomMembersFetchedAt: 0 };
    }
    const state = this.state.chats[key];
    state.displayName = contact.display_name || state.displayName || key;
    state.isChatroom = isChatroom(contact);
    return state;
  }

  /** Pick a working-notice variant, avoiding an immediate repeat per chat. */
  pickWorkingNotice(contact) {
    const variants = this.config.reply.workingNoticeTexts.length
      ? this.config.reply.workingNoticeTexts
      : (this.config.reply.workingNoticeText ? [this.config.reply.workingNoticeText] : []);
    if (!variants.length) return '';
    const previous = this.lastWorkingNotice.get(contact.username);
    const pool = variants.length > 1 ? variants.filter(text => text !== previous) : variants;
    const text = pool[Math.floor(Math.random() * pool.length)];
    this.lastWorkingNotice.set(contact.username, text);
    return text;
  }

  async resolveIdentity(status) {
    const directory = status.database?.data_dir;
    if (typeof directory === 'string' && directory) this.wechatDataDir = directory;
    const match = typeof directory === 'string' ? path.basename(directory).match(/^(.*)_[0-9a-f]{4}$/i) : null;
    const username = match?.[1] || this.config.selfUsername.trim();
    if (!username) {
      this.identityResolved = false;
      this.state.selfUsername = '';
      this.logger.rate('identity', 'Cannot resolve selfUsername from database.data_dir; all automatic processing is suspended');
      return false;
    }
    if (username !== this.state.selfUsername) {
      this.identityNames.clear();
      this.senderProfiles.clear();
      this.identityContactsFetched = false;
      this.state.selfDisplayName = '';
      for (const chat of Object.values(this.state.chats)) { chat.roomSelfName = ''; chat.roomMembersFetchedAt = 0; }
    }
    this.state.selfUsername = username;
    this.identityResolved = true;
    if (!this.identityContactsFetched) {
      try {
        const result = await this.api.searchContacts(username, 5);
        const self = result.contacts.find(contact => contact.username === username);
        if (self) {
          for (const field of ['display_name', 'remark', 'nick_name', 'alias']) {
            if (typeof self[field] === 'string' && self[field].trim()) this.identityNames.add(self[field].trim());
          }
          this.state.selfDisplayName = self.display_name || self.nick_name || self.remark || username;
          this.identityContactsFetched = true;
        } else this.logger.rate('identity-contact', 'Self contact not found; using configured/room mention names');
      } catch (error) { this.logger.rate('identity-contact', error); }
    }
    this.logger.reset('identity');
    return true;
  }

  allowedChat(contact) {
    const names = [contact.username, contact.display_name];
    const reply = this.config.reply;
    if (reply.denyContacts.some(name => names.includes(name))) return false;
    if (reply.allowContacts.length && !reply.allowContacts.some(name => names.includes(name))) return false;
    return isChatroom(contact) ? reply.groupAll || reply.groupMention : reply.private;
  }

  async ensureRoomIdentity(contact) {
    const state = this.chatState(contact);
    if (seconds() - state.roomMembersFetchedAt < 600) return;
    try {
      const result = await this.api.roomMembers(contact.username);
      for (const member of result.members) this.rememberSenderProfile(member);
      const self = result.members.find(member => member.username === this.state.selfUsername);
      state.roomSelfName = self?.display_name || self?.nick_name || '';
      state.roomMembersFetchedAt = seconds();
    } catch (error) { this.logger.rate('room-members', error); }
  }

  rememberSenderProfile(contact) {
    if (typeof contact.username !== 'string' || !contact.username.trim()) return;
    const profile = {
      // Room display_name is a group nickname, never a global nickname fallback.
      nick_name: typeof contact.nick_name === 'string' ? contact.nick_name : '',
      remark: typeof contact.remark === 'string' ? contact.remark : '',
      fetchedAt: Date.now(),
    };
    this.senderProfiles.delete(contact.username);
    this.senderProfiles.set(contact.username, profile);
    while (this.senderProfiles.size > MAX_SENDER_PROFILES) {
      this.senderProfiles.delete(this.senderProfiles.keys().next().value);
    }
    return profile;
  }

  /** Enrich this batch without retaining message state or failing the reply. */
  async resolveSenderNicknames(batch) {
    const senders = new Map();
    for (const { message } of batch) {
      message.sender_nick_name = '';
      message.sender_remark = '';
      const username = message.sender_username;
      if (typeof username !== 'string' || !username.trim() || username === this.state.selfUsername) continue;
      if (!senders.has(username)) senders.set(username, []);
      senders.get(username).push(message);
    }
    for (const [username, messages] of senders) {
      let profile = this.senderProfiles.get(username);
      if (!profile || Date.now() - profile.fetchedAt >= SENDER_PROFILE_TTL_MS) {
        this.senderProfiles.delete(username);
        profile = undefined;
        try {
          const result = await this.api.searchContacts(username, 5);
          const contact = result.contacts.find(contact => contact.username === username);
          if (contact) profile = this.rememberSenderProfile(contact);
        } catch (error) { this.logger.rate('sender-profile', error); }
      }
      for (const message of messages) {
        message.sender_nick_name = profile?.nick_name || '';
        message.sender_remark = profile?.remark || '';
      }
    }
  }

  mentioned(contact, message) {
    const names = new Set([...this.identityNames, ...this.config.mentionNames,
      this.chatState(contact).roomSelfName, this.state.selfDisplayName].filter(Boolean).map(name => name.trim()).filter(Boolean));
    if (!names.size) {
      this.logger.rate('mention-names', 'No self mention names are available; group mention matching is disabled');
      return false;
    }
    const norm = String(message.text).replace(/[\u2005\u00a0\u200b\u200c\u200d]/g, ' ').replace(/＠/g, '@');
    for (const name of names) {
      if (name === '所有人') continue;
      if (norm.includes('@' + name) || new RegExp(`@[\\s]*${escapeRegExp(name)}(?![A-Za-z0-9_])`).test(norm)) return true;
    }
    return this.config.reply.mentionPrefixFallback && /^@(?!\s*所有人)/.test(norm.trimStart());
  }

  /** Remember one image message so a following text trigger can include its pixels. */
  rememberImage(contact, message) {
    if (!this.config.reply.images) return;
    const key = contact.username;
    const cutoff = seconds() - Math.floor(this.config.reply.imageContextAgeMs / 1000);
    const list = (this.imageContext.get(key) ?? []).filter(item => item.createTime >= cutoff);
    if (!list.some(item => item.localId === message.local_id)) {
      list.push({ localId: String(message.local_id), createTime: Number(message.create_time) });
    }
    this.imageContext.set(key, list.slice(-10));
  }

  /** Resolve a fresh file message's path/name/size through parse_media=true. */
  async rememberFile(contact, message) {
    if (!this.config.reply.files) return;
    const key = contact.username;
    const cutoff = seconds() - Math.floor(this.config.reply.fileContextAgeMs / 1000);
    const list = (this.fileContext.get(key) ?? []).filter(item => item.createTime >= cutoff);
    const localId = String(message.local_id);
    if (list.some(item => item.localId === localId)) { this.fileContext.set(key, list); return; }
    try {
      const result = await this.api.recentMessagesWithMedia(contact.username, 30);
      const meta = result.messages.find(item => String(item.local_id) === localId && isFileMessage(item));
      if (meta) {
        list.push({
          localId,
          createTime: Number(meta.create_time),
          name: String(meta.file_name || meta.path || 'file'),
          filePath: String(meta.path || ''),
          size: Number(meta.file_size || 0),
          fileType: String(meta.file_type || ''),
        });
      }
    } catch (error) {
      this.logger.rate('file-meta', error);
    }
    this.fileContext.set(key, list.slice(-10));
  }

  /** File messages that precede this batch inside the configured window. */
  filesForBatch(contact, batch) {
    if (!this.config.reply.files || !batch.length) return [];
    const starts = batch.map(({ message }) => Number(message.create_time)).filter(Number.isFinite);
    const batchEnd = starts.length ? Math.max(...starts) : seconds();
    const ageCutoff = batchEnd - Math.floor(this.config.reply.fileContextAgeMs / 1000);
    const cutoff = Math.max(ageCutoff, Number(this.chatState(contact).lastReplyAt) || 0);
    return (this.fileContext.get(contact.username) ?? [])
      .filter(item => item.createTime > cutoff && item.createTime <= batchEnd)
      .slice(-4);
  }

  /** Copy incoming WeChat files from the host-side config mount into the workspace. */
  async importFilesForBatch(files, workspaceDir) {
    if (!files.length) return [];
    const saved = [];
    // tokenFile lives at <wechat-ai>/.env, whose config/ directory is mounted at /config.
    const hostConfigRoot = this.config.tokenFile ? path.join(path.dirname(this.config.tokenFile), 'config') : '';
    const dataDir = String(this.wechatDataDir || '');
    let hostDataDir = '';
    if (!hostConfigRoot) return saved;
    if (dataDir === '/config' || dataDir.startsWith('/config/')) {
      hostDataDir = path.join(hostConfigRoot, dataDir.slice('/config'.length));
    } else if (dataDir) {
      hostDataDir = path.resolve(hostConfigRoot, dataDir);
    }
    if (!hostDataDir || !fs.existsSync(hostDataDir)) {
      this.logger.rate('file-import', `Cannot map WeChat data dir: ${dataDir || '(unknown)'}`);
      return saved;
    }
    const incoming = resolveWorkspacePath(workspaceDir, 'incoming');
    fs.mkdirSync(incoming, { recursive: true });
    const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
    for (const file of files) {
      if (!file.filePath) continue;
      const absolute = path.resolve(hostDataDir, file.filePath);
      if (!absolute.startsWith(hostDataDir + path.sep)) continue;
      // WeChat writes the message row before the downloaded file appears on
      // disk, so poll briefly instead of replying "no file content" at once.
      let stat = null;
      for (let attempt = 0; attempt < this.config.reply.fileFetchAttempts; attempt += 1) {
        try {
          const probe = fs.statSync(absolute);
          if (probe.isFile()) { stat = probe; break; }
        } catch { /* file not written yet */ }
        if (attempt < this.config.reply.fileFetchAttempts - 1) {
          await sleep(this.config.reply.fileFetchDelayMs);
        }
      }
      if (!stat) {
        this.logger.rate('file-import', `File not available after retries: ${file.name} (${file.filePath})`);
        continue;
      }
      try {
        if (stat.size > this.config.reply.maxFileBytes) {
          this.logger.rate('file-size', `Skipping ${file.name}: ${stat.size} bytes`);
          continue;
        }
        const base = path.basename(file.name || path.basename(absolute))
          .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80) || 'file';
        const localId = String(file.localId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
        const target = resolveWorkspacePath(workspaceDir, `incoming/${localId}-${base}`);
        if (!fs.existsSync(target)) fs.copyFileSync(absolute, target);
        saved.push({
          name: file.name || base,
          path: path.relative(workspaceDir, target).split(path.sep).join('/'),
          size: stat.size,
        });
      } catch (error) {
        this.logger.rate('file-import', error);
      }
    }
    return saved;
  }

  /** Image messages that precede this batch inside the configured context window. */
  imagesForBatch(contact, batch) {
    if (!this.config.reply.images || !batch.length) return [];
    const starts = batch.map(({ message }) => Number(message.create_time)).filter(Number.isFinite);
    // Anchor at the newest message in the batch: a batch containing several
    // image messages must include all of them, while a later @ text still sees
    // the images that preceded it. Images already answered in a previous reply
    // are not re-attached automatically; an explicit "图片里有什么" question
    // still falls back to the media window in decodeImages().
    const batchEnd = starts.length ? Math.max(...starts) : seconds();
    const ageCutoff = batchEnd - Math.floor(this.config.reply.imageContextAgeMs / 1000);
    const cutoff = Math.max(ageCutoff, Number(this.chatState(contact).lastReplyAt) || 0);
    return (this.imageContext.get(contact.username) ?? [])
      .filter(item => item.createTime > cutoff && item.createTime <= batchEnd)
      .slice(-this.config.reply.maxImagesPerMessage);
  }

  /** Stable content hash so identical pictures count once. */
  imageHash(data) {
    return createHash('sha256').update(data).digest('hex');
  }

  /** Whether this chat already saw these exact pixels inside the dedupe window. */
  wasImageSent(contact, hash) {
    if (!this.config.reply.imageDedupe) return false;
    const seen = this.sentImageHashes.get(contact.username);
    if (!seen) return false;
    const at = seen.get(hash);
    if (at === undefined) return false;
    if (Date.now() - at > this.config.reply.imageDedupeWindowMs) {
      seen.delete(hash);
      return false;
    }
    return true;
  }

  /** Remember images delivered to the model; prunes expired hashes. */
  rememberSentImages(contact, images) {
    if (!this.config.reply.imageDedupe) return;
    const seen = this.sentImageHashes.get(contact.username) ?? new Map();
    const now = Date.now();
    for (const image of images) seen.set(image.hash, now);
    for (const [hash, at] of seen) if (now - at > this.config.reply.imageDedupeWindowMs) seen.delete(hash);
    this.sentImageHashes.set(contact.username, seen);
  }

  /**
   * Fetch and decode image pixels for this batch. Known context ids are used
   * first; when a message asks about an image (or is one) and the in-memory
   * context is empty (for example right after a plugin reload), the media tool
   * supplies the recent images within the context window.
   */
  async decodeImages(contact, candidates, batch) {
    // WeChat writes the message row before the picture file is fully
    // materialized: the first media query can return the message with no
    // image block. Retry briefly before answering without pixels.
    const attempts = this.config.reply.imageFetchAttempts;
    const delay = this.config.reply.imageFetchDelayMs;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const images = await this.decodeImagesOnce(contact, candidates, batch);
        if (images.length > 0 || attempt === attempts - 1) return images;
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1) throw error;
        this.logger.rate('image-fetch', error);
      }
      await new Promise(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
    }
    if (lastError) throw lastError;
    return [];
  }

  async decodeImagesOnce(contact, candidates, batch) {
    const media = await this.api.recentMedia(contact.username, 5);
    const starts = batch.map(({ message }) => Number(message.create_time)).filter(Number.isFinite);
    const batchEnd = starts.length ? Math.max(...starts) : seconds();
    const cutoff = batchEnd - Math.floor(this.config.reply.imageContextAgeMs / 1000);
    const mimeOf = message => message.image_block?.mimeType || message.base64_mime_type || message.media_mime_type || '';
    const payloadOf = message => message.image_block?.data || message.base64 || '';
    const usable = media.messages.filter(message => (
      payloadOf(message)
      && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeOf(message))
      && message.sender_username !== this.state.selfUsername
      && Number(message.create_time) >= cutoff
      && Number(message.create_time) <= batchEnd
    ));
    const byId = new Map(usable.map(message => [String(message.local_id), message]));
    const selected = candidates.length
      ? candidates
      : usable.slice(-this.config.reply.maxImagesPerMessage)
        .map(message => ({ localId: String(message.local_id), createTime: Number(message.create_time) }));
    const images = [];
    for (const candidate of selected) {
      const payload = byId.get(candidate.localId);
      if (!payload) continue;
      let data;
      try { data = Buffer.from(payloadOf(payload), 'base64'); } catch { continue; }
      if (!data.byteLength || data.byteLength > this.config.reply.maxImageBytes) {
        this.logger.rate('image-size', `Skipping image ${candidate.localId}: ${data.byteLength} bytes`);
        continue;
      }
      images.push({ localId: candidate.localId, data, mediaType: mimeOf(payload) });
    }
    return images;
  }

  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    this.state.runtime.lastPollAt = seconds();
    const generation = this.pauseGeneration;
    try {
      if (!this.api.client.token) {
        try {
          this.api.client.token = resolveToken(this.config);
          this.logger.addSecret(this.api.client.token);
          this.state.runtime.tokenMissing = false;
        } catch (error) {
          this.state.runtime.tokenMissing = true;
          if (!this.tokenWarning) { this.tokenWarning = true; this.logger.warn(error); }
          this.state.runtime.ready = false;
          return;
        }
      }
      const status = await this.api.runtimeStatus();
      if (this.stopped) return;
      const healthy = status.database?.available === true && status.services?.message?.is_running === true;
      if (!healthy) {
        this.state.runtime.ready = false;
        this.state.runtime.lastPollError = 'wechat-ai database or message service unavailable';
        this.logger.rate('health', this.state.runtime.lastPollError);
        return;
      }
      if (!await this.resolveIdentity(status) || this.stopped) { this.state.runtime.ready = false; return; }
      this.state.runtime.ready = true;
      this.logger.reset('health');
      const { chats } = await this.api.recentChats(50);
      const firstTick = !this.state.initialized;
      const resumeBaseline = this.resumeBaselinePending;
      for (const chat of chats) {
        if (this.stopped) return;
        try {
          const contact = chat.contact;
          const latest = Number(chat.last_message?.create_time);
          if (!contact?.username || !Number.isFinite(latest) || latest <= 0) continue;
          const state = this.chatState(contact);
          if (firstTick && !this.config.reply.history) { state.lastTime = Math.max(state.lastTime, latest); continue; }
          if (latest <= state.lastTime) continue;
          let messages;
          try {
            ({ messages } = await this.api.recentMessages(contact.username, 50));
          } catch (error) {
            // Newly joined chats can appear in recent chats before the contact DB.
            // Only explicit missing-data errors may use the recent-chat snapshot.
            const missing = /missing messages|\bnot_found\b|未找到/i.test(String(error?.message || error));
            const last = chat.last_message;
            if (!missing || typeof last?.text !== 'string' || !last.text.trim()) throw error;
            const { sender_username, sender_display, type, create_time, time, text, local_id } = last;
            messages = [{ sender_username, sender_display, type, create_time, time, text, local_id }];
            this.logger.rate('chat-message-fallback', 'Recent messages missing; using one recent-chat last_message');
          }
          if (this.stopped) return;
          const ordered = messages.filter(m => Number.isFinite(Number(m.create_time)) && Number(m.create_time) > 0)
            .sort((a, b) => Number(a.create_time) - Number(b.create_time) || Number(a.sort_seq || 0) - Number(b.sort_seq || 0));
          const fresh = ordered.filter(m => Number(m.create_time) > state.lastTime);
          // Advance even for self, non-text, paused, denied, and loop-guarded messages.
          state.lastTime = Math.max(state.lastTime, latest, ...fresh.map(m => Number(m.create_time)));
          const loop = ordered.length >= 6 && ordered.slice(-6).every(m => m.sender_username === this.state.selfUsername);
          if (loop) this.logger.rate('loop-guard', `Skipping self-only message tail in ${contact.username}`);
          if (loop || this.state.paused || resumeBaseline || generation !== this.pauseGeneration || !this.allowedChat(contact)) {
            this.noteSkipped(fresh.length);
            this.store.save();
            continue;
          }
          if (isChatroom(contact)) await this.ensureRoomIdentity(contact);
          for (const message of fresh) {
            if (this.stopped) return;
            if (message.sender_username === this.state.selfUsername) { this.noteSkipped(); continue; }
            const image = isImageMessage(message);
            const file = isFileMessage(message) && this.config.reply.files;
            if (image) this.rememberImage(contact, message);
            else if (file) await this.rememberFile(contact, message);
            // Quote/reply messages (引用消息) only expose their text through
            // parse_media=true, so enrich them before mention detection.
            if (isQuoteMessage(message) && !isTextMessage(message)) {
              try {
                const rich = await this.api.recentMessagesWithMedia(contact.username, 3);
                const meta = rich.messages.find(item => String(item.local_id) === String(message.local_id));
                if (meta?.text) message.text = meta.text;
                if (meta?.quote) message.quote = meta.quote;
                if (meta?.quote_image_block) message.quoteImageBlock = meta.quote_image_block;
              } catch (error) {
                this.logger.rate('quote-text', error);
              }
            }
            if (this.state.paused || generation !== this.pauseGeneration || !this.identityResolved) {
              this.noteSkipped(); continue;
            }
            const text = isTextMessage(message)
              || (isQuoteMessage(message) && typeof message.text === 'string' && !!message.text.trim());
            if (!text && !image && !file) { this.noteSkipped(); continue; }
            if (isChatroom(contact)) {
              // Group images/files are only context for a later @ mention.
              if (image || file) { this.noteSkipped(); continue; }
              const mentioned = this.mentioned(contact, message);
              if (!this.config.reply.groupAll && !mentioned) { this.noteSkipped(); continue; }
              this.enqueue(contact, message, mentioned);
            } else {
              this.enqueue(contact, message, false);
            }
          }
          this.store.save();
        } catch (error) {
          if (!this.stopped) this.logger.rate('chat-poll', error);
        }
      }
      this.state.initialized = true;
      if (generation === this.pauseGeneration) this.resumeBaselinePending = false;
      this.state.runtime.lastPollError = '';
      this.logger.reset('poll');
    } catch (error) {
      if (!this.stopped) {
        this.state.runtime.ready = false;
        this.state.runtime.lastPollError = this.logger.clean(error);
        this.state.stats.errors++;
        this.logger.rate('poll', error);
      }
    } finally {
      this.syncRuntime();
      this.store.save();
      this.ticking = false;
    }
  }

  enqueue(contact, message, mentioned) {
    const key = contact.username;
    let chat = this.chats.get(key);
    if (!chat) { chat = { pending: [], timer: null, queue: Promise.resolve() }; this.chats.set(key, chat); }
    chat.pending.push({ message, mentioned });
    this.state.stats.triggers++;
    clearTimeout(chat.timer);
    const generation = this.pauseGeneration;
    chat.timer = setTimeout(() => {
      chat.timer = null;
      const batch = chat.pending.splice(0);
      chat.queue = chat.queue.then(() => this.runBatch(contact, batch, generation)).catch(error => {
        if (!this.stopped) this.logger.rate('chat-queue', error);
      });
      this.track(chat.queue);
    }, this.config.reply.debounceMs);
    chat.timer.unref?.();
  }

  canReply(key) {
    const times = (this.replyTimes.get(key) || []).filter(time => Date.now() - time < this.config.reply.rateLimitWindowMs);
    this.replyTimes.set(key, times);
    if (times.length < this.config.reply.maxRepliesPerMinute) return true;
    this.logger.rate('reply-rate-limit', `Automatic reply limit reached for ${key}`);
    return false;
  }

  batchAllowed(generation) {
    return !this.stopped && !this.state.paused && generation === this.pauseGeneration && this.identityResolved;
  }

  async runBatch(contact, batch, generation) {
    if (!batch.length || !this.batchAllowed(generation)) { this.noteSkipped(batch.length); return; }
    let acquired = false;
    let entry;
    let attempted = false;
    let noticeTimer = null;
    try {
      await this.semaphore.acquire();
      acquired = true;
      if (!this.batchAllowed(generation) || !this.canReply(contact.username)) { this.noteSkipped(batch.length); return; }
      attempted = true;
      entry = await this.ensureAgent(contact);
      if (!this.batchAllowed(generation)) return;
      entry.busy = true;
      const sessionId = entry.sessionId;
      this.lastAssistantText.delete(sessionId);
      this.turnReasons.delete(sessionId);
      this.voiceIntentSessions.delete(sessionId);
      this.voiceSentSessions.delete(sessionId);
      await this.resolveSenderNicknames(batch);
      if (!this.batchAllowed(generation)) return;
      let prompt = formatPrompt(contact, batch, this.chatState(contact).roomSelfName, this.config.reply.maxPromptChars, this.config.persona);
      // Attach wechat-ai's decoded image pixels as DSH image blocks. The media
      // tool returns base64 only when the WeChat image DAT key is configured.
      const imageCandidates = this.imagesForBatch(contact, batch);
      const batchHasImage = batch.some(({ message }) => isImageMessage(message));
      const batchText = batch.map(({ message }) => String(message.text || '')).join('\n');
      // A deictic reference or visual follow-up with recent candidates re-reads;
      // a generic "图片里有什么" only adds pictures this chat has not seen yet.
      const imageReference = /(这张|那张|这两张|那两张|这几张|那几张|倒数第|第一张|第二张|第三张|最后一张|刚才|刚刚|上面|上次|之前|最近).{0,8}(图|照片|截图)/.test(batchText);
      const imageQuestion = /(图|照片|截图).{0,8}(是啥|是什么|有什么|里有啥|里有什么|内容|写了什么|写了啥|说了什么|认得|识别|描述|看一下|看看|读一下)/.test(batchText);
      const imageFollowUp = imageCandidates.length > 0
        && /(看看|看一下|再看|看下|瞅瞅|瞧瞧|这个|这张|那个|那张|上面|刚才)/.test(batchText);
      const asksAboutImage = imageReference || imageQuestion || imageFollowUp;
      const wantsImageContext = this.config.reply.images && (batchHasImage || asksAboutImage);
      const imageBlocks = [];
      const deliveredImages = [];
      if (wantsImageContext) {
        if (entry.acceptsImages === false) {
          prompt += '\n\n（对方提到了图片，但当前模型不支持图片输入，无法查看。）';
        } else {
          try {
            const images = await this.decodeImages(contact, imageCandidates, batch);
            // Identical pixels count once. On a generic image question, skip
            // pictures already delivered inside the dedupe window so a normal
            // follow-up does not keep re-sending the last two images.
            const unique = [];
            const seen = new Set();
            for (const image of images) {
              const hash = this.imageHash(image.data);
              if (seen.has(hash)) continue;
              seen.add(hash);
              if (!batchHasImage && !imageReference && !imageFollowUp && this.wasImageSent(contact, hash)) continue;
              unique.push({ ...image, hash });
            }
            if (unique.length) {
              const refs = await this.ctx.attachments.saveImages(unique.map(image => ({
                data: new Uint8Array(image.data),
                mediaType: image.mediaType,
                name: `wechat-${image.localId}.${image.mediaType.split('/')[1]}`,
              })));
              for (const ref of refs) imageBlocks.push({ type: 'image', attachment: ref });
              deliveredImages.push(...unique);
              prompt += `\n\n（随本条消息附带了 ${refs.length} 张图片，已作为图片附件提供，请直接查看图片内容后回答。）`;
            } else if (images.length) {
              prompt += '\n\n（相关图片此前的回复里已经提供过，可以直接沿用前面的图片内容；如需重新查看请明确说明。）';
            } else {
              prompt += '\n\n（对方提到了图片，但 wechat-ai 没有返回可解码的图片数据。）';
            }
          } catch (error) {
            this.logger.rate('image-attach', error);
            prompt += '\n\n（对方提到了图片，但读取图片失败。）';
          }
        }
      }
      // Quoted/replied image messages: wechat-ai resolves the referenced
      // message and returns its pixels as a separate quote image block.
      const quoteImages = [];
      if (this.config.reply.images) {
        const seenQuoteHashes = new Set(deliveredImages.map(image => image.hash));
        for (const { message } of batch) {
          if (quoteImages.length >= this.config.reply.maxImagesPerMessage) break;
          const block = message.quoteImageBlock;
          if (!block?.data) continue;
          try {
            const data = Buffer.from(block.data, 'base64');
            if (!data.byteLength || data.byteLength > this.config.reply.maxImageBytes) continue;
            const hash = this.imageHash(data);
            if (seenQuoteHashes.has(hash)) continue;
            seenQuoteHashes.add(hash);
            quoteImages.push({ data, mediaType: block.mimeType || 'image/png', hash });
          } catch { /* ignore malformed block */ }
        }
      }
      if (quoteImages.length) {
        if (entry.acceptsImages === false) {
          prompt += '\n\n（对方引用的图片无法查看：当前模型不支持图片输入。）';
        } else {
          try {
            const refs = await this.ctx.attachments.saveImages(quoteImages.map(image => ({
              data: new Uint8Array(image.data),
              mediaType: image.mediaType,
              name: `wechat-quoted.${image.mediaType.split('/')[1]}`,
            })));
            for (const ref of refs) imageBlocks.push({ type: 'image', attachment: ref });
            prompt += `\n\n（引用消息中的 ${refs.length} 张图片也已作为附件提供，请结合引用内容查看。）`;
          } catch (error) {
            this.logger.rate('quote-image', error);
            prompt += '\n\n（对方引用了图片，但读取引用图片失败。）';
          }
        }
      }
      const fileCandidates = this.filesForBatch(contact, batch);
      const batchHasFile = batch.some(({ message }) => isFileMessage(message));
      if (this.config.reply.files && (batchHasFile || fileCandidates.length)) {
        try {
          const savedFiles = await this.importFilesForBatch(fileCandidates, entry.workspaceDir);
          if (savedFiles.length) {
            const listing = savedFiles.map(file => `${file.path}（${file.name}，${file.size} 字节）`).join('、');
            prompt += `\n\n（对方发来文件，已保存到工作区：${listing}。可用 workspace_read 读取文本，或 workspace_run 运行命令处理。）`;
          } else {
            prompt += '\n\n（对方发来了文件，但桥接未能读取到文件内容或文件为空。）';
          }
        } catch (error) {
          this.logger.rate('file-import', error);
          prompt += '\n\n（对方发来了文件，但保存文件失败。）';
        }
      }
      const content = [{ type: 'text', text: prompt }, ...imageBlocks];
      entry.handle.agent.followup({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } });
      // Long tool-driven turns stay silent otherwise; a delayed one-shot notice
      // tells the chat that work is in progress without affecting the final send.
      // Explicit voice requests and declared voice replies skip it entirely.
      const voiceRequested = batch.some(({ message }) => isVoiceRequest(message.text));
      if (this.config.reply.workingNoticeMs > 0 && !voiceRequested && !this.voiceIntentSessions.has(sessionId)) {
        noticeTimer = setTimeout(() => {
          noticeTimer = null;
          this.workingNoticeTimers.delete(sessionId);
          // The Agent already declared/answered with voice; a notice now would
          // be a redundant text bubble around the voice reply.
          if (this.voiceIntentSessions.has(sessionId) || this.voiceSentSessions.has(sessionId)) return;
          if (!this.batchAllowed(generation)) return;
          const noticeText = this.pickWorkingNotice(contact);
          if (!noticeText) return;
          this.track(this.api.sendText({
            recipient_name: contact.username,
            message: noticeText,
            wait_seconds: 0,
          }).then(result => {
            this.state.runtime.writeBlocked = result.status === 'blocked';
          }).catch(error => this.logger.rate('working-notice', error)));
        }, this.config.reply.workingNoticeMs);
        this.workingNoticeTimers.set(sessionId, noticeTimer);
        noticeTimer.unref?.();
      }
      try {
        await withTimeout(entry.handle.agent.whenIdle(), this.config.turnTimeoutMs, this.stopSignal.signal);
      } catch (error) {
        if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
        if (entry) this.workingNoticeTimers.delete(entry.sessionId);
        // Retire timed-out handles so late output cannot leak into a subsequent batch.
        try { entry.handle.agent.cancel({ kind: 'hook', reason: this.stopped ? 'wechat bridge stopped' : 'wechat bridge reply timeout' }); }
        catch (cancelError) { this.logger.rate('agent-cancel', cancelError); }
        await this.disposeEntry(contact.username, entry);
        throw error;
      }
      if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
      this.workingNoticeTimers.delete(sessionId);
      if (!this.batchAllowed(generation)) return;
      const reason = this.turnReasons.get(sessionId);
      if (reason && reason !== 'completed') throw new Error(`Agent turn ended: ${reason}`);
      const voiceSent = this.voiceSentSessions.has(sessionId);
      let text = (this.lastAssistantText.get(sessionId) || '').trim();
      text = text.replace(/^(回复[:：]?|以下是回复[:：]?)\s*/, '').trim().slice(0, this.config.reply.maxReplyChars).trim();
      if (!voiceSent && !text) throw new Error('empty reply');
      if (voiceSent) {
        // The Agent already sent a native voice bubble in this turn. Do not
        // follow it with the usual text reply, which would be a duplicate.
        this.replyTimes.get(contact.username).push(Date.now());
        this.state.stats.replies++;
        this.state.runtime.autoReplyError = '';
        this.rememberSentImages(contact, deliveredImages);
        this.logger.info(`Voice reply completed for ${contact.username}`);
      } else {
        // Check again at send time: slow turns must not bunch more than six sends into a minute.
        if (!this.canReply(contact.username)) { this.noteSkipped(batch.length); return; }
        this.replyTimes.get(contact.username).push(Date.now());
        const last = batch[batch.length - 1];
        const sender = last.message.sender_display?.trim();
        const selfNames = new Set([...this.identityNames, this.state.selfDisplayName, this.chatState(contact).roomSelfName]);
        const at = isChatroom(contact) && this.config.reply.attachAtInGroup && last.mentioned
          && sender && !selfNames.has(sender) ? sender : undefined;
        const result = await this.api.sendText({ recipient_name: contact.username, message: text, at_user_name: at, wait_seconds: 20 });
        this.state.runtime.writeBlocked = result.status === 'blocked';
        if (!sendSucceeded(result)) throw new Error(`Automatic send ${result.status}${result.completed === true ? '' : ' (not completed)'}`);
        this.state.stats.replies++;
        this.state.runtime.autoReplyError = '';
        this.rememberSentImages(contact, deliveredImages);
        this.logger.info(`Automatic reply completed for ${contact.username} (${text.length} chars)`);
      }
    } catch (error) {
      if (!this.stopped) {
        this.state.stats.errors++;
        this.state.runtime.autoReplyError = this.logger.clean(error);
        this.logger.rate(this.state.runtime.writeBlocked ? 'write-blocked' : 'auto-reply', error);
      }
    } finally {
      if (noticeTimer) clearTimeout(noticeTimer);
      if (entry) {
        entry.busy = false;
        entry.lastUsed = Date.now();
        this.lastAssistantText.delete(entry.sessionId);
        this.turnReasons.delete(entry.sessionId);
        this.voiceIntentSessions.delete(entry.sessionId);
        this.voiceSentSessions.delete(entry.sessionId);
        this.workingNoticeTimers.delete(entry.sessionId);
      }
      if (attempted) {
        this.chatState(contact).lastReplyAt = seconds();
        this.state.runtime.lastReplyAt = seconds();
      }
      this.syncRuntime();
      this.store.save();
      if (acquired) this.semaphore.release();
    }
  }

  async disposeEntry(key, entry) {
    if (this.agents.get(key) === entry) this.agents.delete(key);
    this.knownSessions.delete(entry.sessionId);
    this.lastAssistantText.delete(entry.sessionId);
    this.turnReasons.delete(entry.sessionId);
    this.voiceIntentSessions.delete(entry.sessionId);
    this.voiceSentSessions.delete(entry.sessionId);
    const noticeTimer = this.workingNoticeTimers.get(entry.sessionId);
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      this.workingNoticeTimers.delete(entry.sessionId);
    }
    try { await entry.handle.dispose(); }
    catch (error) { this.logger.rate('agent-dispose', error); }
  }

  async ensureAgent(contact) {
    await this.preparation;
    const key = contact.username;
    const cached = this.agents.get(key);
    if (cached && this.ctx.agents.get(cached.sessionId)) { cached.lastUsed = Date.now(); cached.busy = true; return cached; }
    if (cached) await this.disposeEntry(key, cached);
    // Reserve capacity before asynchronous creation; simultaneous chats cannot exceed maxSessions.
    this.creating = (this.creating || 0) + 1;
    try {
      while (this.agents.size + this.creating > this.config.maxSessions) {
        const oldest = [...this.agents.entries()].filter(([, entry]) => !entry.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldest) throw new Error('All bridge agent sessions are busy');
        await this.disposeEntry(...oldest);
      }
      const state = this.chatState(contact);
      // The workspace directory must exist before create/resume validates its cwd.
      const workspaceInfo = await this.ensureWorkspace(contact);
      const { dir: workspaceDir, workspace } = workspaceInfo;
      const selected = this.config.model.provider && this.config.model.model
        ? this.config.model : this.ctx.agentDefaultModel.currentSelection();
      if (!selected?.provider || !selected?.model) throw new Error('No DSH model selected; configure model.provider and model.model');
      const agentOptions = { provider: selected.provider, model: selected.model };
      if (selected.reasoningEffort) agentOptions.reasoningEffort = selected.reasoningEffort;
      // Resolve once whether this exact route accepts image input; DeepSeek's
      // listing declares it per model (deepseek-flash: text+image).
      await this.resolveImageSupport();
      const setup = async agentCtx => {
        await this.ctx.agentPresets.mount(agentCtx, this.config.agentPreset || 'wechat');
        // Work mode has no host bash/fs tools in its preset. These scoped tools
        // replace them with workspace-only file access plus a bwrap jail for
        // commands, so the Agent cannot read host directories outside the
        // workspace.
        if (this.config.workspaceTools !== false && this.config.agentPreset !== 'wechat') {
          registerWorkspaceTools(agentCtx, {
            root: workspaceDir,
            execTimeoutMs: this.config.execTimeoutMs,
            logger: this.logger,
            codex: {
              ...workspaceInfo.codex,
              beforeRun: () => this.syncCodexAuth(workspaceDir),
            },
          });
        }
        // A guard is the only per-Agent mask that also covers scoped
        // registrations. Chat mode narrows everything to WeChat read tools; work
        // mode allows exactly the workspace tools, web tools, todo, and WeChat
        // context tools. Host globals (terminal, team, subagents, worktree,
        // session search, working directory, …) stay denied.
        const allowlist = this.config.toolAllowlist
          ?? (this.config.agentPreset === 'wechat' ? BRIDGE_CHAT_TOOLS : null);
        if (allowlist) {
          const allowed = new Set(allowlist);
          // `restrict` masks inherited tools for this Agent, so host globals
          // (terminal/team/session/…) no longer appear in its schema list. Keep
          // the preset's own web/todo tools in the allow set, and skip the
          // agent-scope workspace_* names (those are registered on this scope
          // and are never masked).
          const maskTargets = allowlist.filter(name => !name.startsWith('workspace_'));
          agentCtx.tools.restrict(maskTargets.length
            ? { allow: maskTargets }
            : { deny: ['wechat_send_message'] });
          agentCtx.tools.guard(execution => (
            allowed.has(execution?.name)
              ? undefined
              : `This WeChat assistant is restricted to its workspace tools; ${String(execution?.name || 'that tool')} is disabled.`
          ));
        } else {
          // Custom composition: keep the preset tools but never expose the
          // bridge's own send (the bridge sends the final reply itself).
          agentCtx.tools.restrict({ deny: ['wechat_send_message'] });
        }
      };
      let handle;
      let sessionId = state.sessionId;
      if (sessionId && this.ctx.get('sessionPersistence')) {
        try { handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup }); }
        catch (error) { this.logger.rate('agent-resume', error); }
      }
      // A session from a previous workspace cannot be attached here (its header
      // cwd is immutable), so retire it and start a fresh session in the
      // configured workspace. The old session and its history stay visible in
      // the old workspace.
      if (handle && !this.sessionMatchesWorkspace(handle.agent.session, workspaceDir)) {
        this.logger.info(`Resumed session ${sessionId} is outside the dedicated workspace; creating a new one`);
        await this.disposeEntry(key, { handle, sessionId });
        handle = undefined;
        sessionId = '';
        state.sessionId = '';
        this.store.save();
      }
      if (this.stopped) { if (handle) await handle.dispose(); throw new Error('Bridge stopped'); }
      if (!handle) {
        sessionId = `wechat-${createHash('sha256').update(key).digest('hex').slice(0, 10)}-${randomUUID().slice(0, 8)}`;
        handle = await this.ctx.agents.create({ sessionId,
          meta: { cwd: workspaceDir, agentPreset: this.config.agentPreset || 'wechat' }, agentOptions, setup });
      }
      if (this.stopped) { await handle.dispose(); throw new Error('Bridge stopped'); }
      const entry = { handle, sessionId, workspaceDir, lastUsed: Date.now(), busy: true, isChatroom: isChatroom(contact),
        acceptsImages: this.modelImageSupport === true };
      this.agents.set(key, entry);
      this.knownSessions.add(sessionId);
      state.sessionId = sessionId;
      this.store.save();
      try { this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset || 'read-only'); }
      catch (error) { this.logger.rate('permission-preset', error); }
      try { this.ctx.sessionTitle.rename(handle.agent.session, `${isChatroom(contact) ? '微信群' : '微信'} · ${contact.display_name || key}`); }
      catch (error) { this.logger.rate('session-title', error); }
      try {
        if (!this.stopped) await workspace.attachSession(sessionId);
      } catch (error) {
        if (!/already.*attach|已.*(?:关联|attach)/i.test(String(error?.message))) this.logger.rate('workspace-attach', error);
      }
      return entry;
    } finally { this.creating--; }
  }

  setPaused(paused) {
    if (this.state.paused && !paused) this.resumeBaselinePending = true;
    if (paused !== this.state.paused) this.pauseGeneration++;
    this.state.paused = paused;
    if (paused) {
      for (const chat of this.chats.values()) {
        clearTimeout(chat.timer);
        chat.timer = null;
        this.noteSkipped(chat.pending.length);
        chat.pending.length = 0;
      }
    }
    this.syncRuntime();
    this.store.save(true);
    this.logger.info(paused ? 'Automatic replies paused; watermarks continue advancing' : 'Automatic replies resumed');
    return { paused, ok: true };
  }

  status() {
    this.syncRuntime();
    return jsonValue({ paused: this.state.paused, ready: this.state.runtime.ready,
      mcpUrl: this.logger.clean(this.config.mcpUrl), selfUsername: this.state.selfUsername,
      selfDisplayName: this.state.selfDisplayName, pollIntervalMs: this.config.pollIntervalMs,
      agentPreset: this.config.agentPreset, permissionPreset: this.config.permissionPreset,
      toolGuard: this.config.toolAllowlist ? 'allowlist' : 'off',
      workspaceTools: this.config.workspaceTools !== false,
      workspaceMode: this.config.workspaceMode,
      workspacePath: this.workspaceRoot || this.config.workspacePath,
      workspaceCount: this.workspaces.size,
      turnTimeoutMs: this.config.turnTimeoutMs,
      execTimeoutMs: this.config.execTimeoutMs,
      images: {
        enabled: this.config.reply.images,
        modelSupports: this.modelImageSupport === true,
        maxImagesPerMessage: this.config.reply.maxImagesPerMessage,
        contextAgeMs: this.config.reply.imageContextAgeMs,
      },
      files: {
        enabled: this.config.reply.files,
        maxFileBytes: this.config.reply.maxFileBytes,
        contextAgeMs: this.config.reply.fileContextAgeMs,
      },
      codex: {
        enabled: this.codex.enabled,
        staged: this.codexWorkspaces.size > 0,
        timeoutMs: this.codex.timeoutMs,
      },
      activeSessions: [...this.agents].map(([chat, entry]) => ({ chat, sessionId: entry.sessionId, isChatroom: entry.isChatroom })),
      stats: this.state.stats, runtime: this.state.runtime, lastErrors: this.logger.lastErrors });
  }

  /** Stop scheduling first, cancel turns, then allow at most five seconds to drain work. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.interval);
    for (const chat of this.chats.values()) { clearTimeout(chat.timer); chat.pending.length = 0; }
    this.semaphore.close();
    this.stopSignal.abort();
    this.api.client.close();
    for (const entry of this.agents.values()) {
      if (entry.busy) {
        try { entry.handle.agent.cancel({ kind: 'hook', reason: 'wechat bridge stopped' }); }
        catch (error) { this.logger.rate('agent-cancel', error); }
      }
    }
    try { await withTimeout(Promise.allSettled([...this.tasks]), 5000); }
    catch { this.logger.warn('Cleanup drain reached the five-second deadline'); }
    for (const [key, entry] of [...this.agents]) await this.disposeEntry(key, entry);
    this.state.runtime.ready = false;
    this.syncRuntime();
    this.store.close();
    this.logger.info('WeChat bridge stopped');
  }
}
