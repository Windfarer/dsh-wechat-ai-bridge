import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { TTS_DEFAULTS } from './tts.js';

/** Persona text is prepended to each bridge prompt; keep it bounded. */
export const MAX_PERSONA_CHARS = 1200;

export const DEFAULTS = {
  mcpUrl: 'http://127.0.0.1:8100/mcp', token: '', tokenEnv: 'WECHAT_AI_MCP_TOKEN', tokenFile: '',
  requestTimeoutMs: 30000, pollIntervalMs: 2500, selfUsername: '', agentPreset: 'wechat',
  permissionPreset: 'read-only', workspaceMode: 'per-chat', workspacePath: '', workspaceTitle: '微信桥接',
  /** Optional persona appended to every WeChat prompt for this bridge. */
  persona: '',
  statePath: '', logPath: '', logMaxBytes: 262144,
  maxConcurrentChats: 2, maxSessions: 20, turnTimeoutMs: 180000,
  model: { provider: '', model: '' }, mentionNames: [],
  /** Register the workspace-only file/shell tools for work-mode Agents. */
  workspaceTools: true,
  /** Upper bound for one confined `workspace_run` call. */
  execTimeoutMs: 120000,
  /** Codex CLI subagent executed inside the workspace jail (no host paths). */
  codex: { enabled: false, binary: '', authSource: '', timeoutMs: 600000 },
  /**
   * OpenAI-compatible TTS endpoint. The bridge calls it from the Host, so the
   * API key remains outside the workspace jail and never reaches the Agent.
   */
  tts: { ...TTS_DEFAULTS },
  /**
   * Per-Agent tool guard. `null` leaves the preset's tools untouched (work
   * mode); an array allows only those tool names and denies everything else
   * (chat mode). The bridge always hides `wechat_send_message` separately.
   */
  toolAllowlist: null,
  reply: {
    private: true, groupMention: true, groupAll: false, attachAtInGroup: true,
    mentionPrefixFallback: false, history: false, debounceMs: 1200,
    maxReplyChars: 1500, maxPromptChars: 4000, allowContacts: [], denyContacts: [],
    maxRepliesPerMinute: 6, rateLimitWindowMs: 60000,
    workingNoticeMs: 0, workingNoticeText: '', workingNoticeTexts: [],
    images: true, maxImagesPerMessage: 4, imageContextAgeMs: 900000, maxImageBytes: 8000000,
    imageFetchAttempts: 4, imageFetchDelayMs: 1200,
    imageDedupe: true, imageDedupeWindowMs: 1800000,
    files: true, fileContextAgeMs: 900000, maxFileBytes: 20971520,
    fileFetchAttempts: 8, fileFetchDelayMs: 1500,
  },
};

/** Merge defaults and clamp numeric settings before creating resources. */
export function normalizeConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const config = { ...DEFAULTS, ...raw, model: { ...DEFAULTS.model, ...raw.model },
    reply: { ...DEFAULTS.reply, ...raw.reply },
    codex: { ...DEFAULTS.codex, ...(raw.codex && typeof raw.codex === 'object' ? raw.codex : {}) },
    tts: { ...DEFAULTS.tts, ...(raw.tts && typeof raw.tts === 'object' ? raw.tts : {}) } };
  const bound = (object, key, fallback, min, max) => {
    const value = object[key];
    object[key] = typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  };
  for (const [key, min, max] of [
    ['requestTimeoutMs', 1000, 120000], ['pollIntervalMs', 1000, 3600000],
    ['maxConcurrentChats', 1, 100], ['maxSessions', 1, 1000],
    ['turnTimeoutMs', 1000, 3600000], ['logMaxBytes', 4096, 10485760],
    ['execTimeoutMs', 1000, 600000],
  ]) bound(config, key, DEFAULTS[key], min, max);
  if (typeof config.workspaceTools !== 'boolean') config.workspaceTools = DEFAULTS.workspaceTools;
  if (!['per-chat', 'shared'].includes(config.workspaceMode)) config.workspaceMode = DEFAULTS.workspaceMode;
  if (typeof config.codex.enabled !== 'boolean') config.codex.enabled = DEFAULTS.codex.enabled;
  for (const key of ['binary', 'authSource']) {
    if (typeof config.codex[key] !== 'string') config.codex[key] = DEFAULTS.codex[key];
  }
  bound(config.codex, 'timeoutMs', DEFAULTS.codex.timeoutMs, 60000, 1800000);
  if (typeof config.tts.enabled !== 'boolean') config.tts.enabled = DEFAULTS.tts.enabled;
  for (const key of ['baseUrl', 'apiKey', 'model', 'voice', 'instructions']) {
    if (typeof config.tts[key] !== 'string') config.tts[key] = DEFAULTS.tts[key];
  }
  for (const key of ['baseUrl', 'apiKey', 'model', 'voice']) config.tts[key] = config.tts[key].trim();
  config.tts.instructions = config.tts.instructions.replace(/\r\n/g, '\n').trim().slice(0, 2000);
  config.persona = typeof config.persona === 'string'
    ? config.persona.replace(/\r\n/g, '\n').trim().slice(0, MAX_PERSONA_CHARS) : DEFAULTS.persona;
  for (const [key, min, max] of [['timeoutMs', 1000, 180000], ['maxChars', 1, 1000]]) {
    const value = config.tts[key];
    config.tts[key] = typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.max(min, Math.min(max, Math.floor(value))) : DEFAULTS.tts[key];
  }
  config.maxConcurrentChats = Math.min(config.maxConcurrentChats, config.maxSessions);
  for (const [key, min, max] of [
    ['debounceMs', 0, 60000], ['maxReplyChars', 1, 2000], ['maxPromptChars', 1, 100000],
    ['maxRepliesPerMinute', 1, 1000], ['rateLimitWindowMs', 1000, 3600000],
    ['workingNoticeMs', 0, 600000],
    ['maxImagesPerMessage', 1, 20], ['imageContextAgeMs', 0, 3600000],
    ['maxImageBytes', 65536, 20971520],
    ['imageFetchAttempts', 1, 10], ['imageFetchDelayMs', 200, 10000],
    ['imageDedupeWindowMs', 60000, 86400000],
    ['fileContextAgeMs', 0, 3600000], ['maxFileBytes', 1024, 104857600],
    ['fileFetchAttempts', 1, 20], ['fileFetchDelayMs', 200, 10000],
  ]) bound(config.reply, key, DEFAULTS.reply[key], min, max);
  if (typeof config.reply.workingNoticeText !== 'string') config.reply.workingNoticeText = DEFAULTS.reply.workingNoticeText;
  config.reply.workingNoticeTexts = (Array.isArray(config.reply.workingNoticeTexts) ? config.reply.workingNoticeTexts : [])
    .filter(text => typeof text === 'string')
    .map(text => text.trim())
    .filter(text => text && text.length <= 100)
    .slice(0, 10);
  config.toolAllowlist = Array.isArray(config.toolAllowlist)
    ? config.toolAllowlist.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim())
    : null;
  for (const key of ['private', 'groupMention', 'groupAll', 'attachAtInGroup', 'mentionPrefixFallback', 'history', 'images', 'imageDedupe', 'files']) {
    if (typeof config.reply[key] !== 'boolean') config.reply[key] = DEFAULTS.reply[key];
  }
  const strings = value => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
  config.mentionNames = [...strings(config.mentionNames), ...strings(config.reply.mentionNames)];
  config.reply.allowContacts = strings(config.reply.allowContacts);
  config.reply.denyContacts = strings(config.reply.denyContacts);
  for (const key of ['token', 'tokenEnv', 'tokenFile', 'selfUsername', 'agentPreset', 'permissionPreset', 'mcpUrl', 'workspaceTitle']) {
    if (typeof config[key] !== 'string' || (key === 'workspaceTitle' && !config[key].trim())) config[key] = DEFAULTS[key];
  }
  for (const [key, fallback] of [
    ['workspacePath', '.dsh/wechat-ai-bridge-workspace'], ['statePath', '.dsh/state/wechat-ai-bridge.json'],
    ['logPath', '.dsh/state/wechat-ai-bridge.log'],
  ]) {
    const value = typeof config[key] === 'string' && config[key] ? config[key] : path.join(os.homedir(), fallback);
    config[key] = path.resolve(value.replace(/^~(?=\/|$)/, os.homedir()));
  }
  return config;
}

/** Stable directory identity; display names must never participate in this key. */
export function chatWorkspaceSegment(username) {
  if (typeof username !== 'string' || !username.trim()) throw new Error('Chat username is required');
  const hash = createHash('sha256').update(username).digest('hex').slice(0, 8);
  const name = username.replace(/[^A-Za-z0-9._@-]/g, '_')
    .replace(/\.{2,}/g, '').replace(/^\.+/, '').slice(0, 64) || 'chat';
  return `${name}-${hash}`;
}

/** Read a dotenv value without evaluating shell substitutions or logging secrets. */
export function parseEnvValue(source, key) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== key) continue;
    const value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0], 1);
      if (end < 0) throw new Error('Unterminated quote in MCP token file');
      return value.slice(1, end);
    }
    return value.replace(/\s*#.*$/, '').trim();
  }
  return '';
}

/** Explicit token > environment > dotenv file. Missing credentials never break apply(). */
export function resolveToken(config) {
  if (config.token?.trim()) return config.token.trim();
  const key = config.tokenEnv || 'WECHAT_AI_MCP_TOKEN';
  if (process.env[key]?.trim()) return process.env[key].trim();
  if (config.tokenFile) {
    let source;
    try { source = fs.readFileSync(config.tokenFile, 'utf8'); }
    catch { throw new Error('Cannot read MCP tokenFile'); }
    const token = parseEnvValue(source, key);
    if (token) return token;
  }
  throw new Error('MCP token missing; configure token, tokenEnv or tokenFile');
}

/** Bounded, timestamped file logging with secret redaction and error backoff. */
export function createLogger(ctx, config) {
  const secrets = new Set();
  if (config.token) secrets.add(config.token);
  if (config.tts?.apiKey) secrets.add(config.tts.apiKey);
  const limits = new Map();
  const lastErrors = [];
  const clean = value => {
    let text = value instanceof Error ? value.message : String(value);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 2000);
  };
  const write = (level, value) => {
    const message = clean(value);
    const timestamp = new Date().toISOString();
    if (level !== 'info') {
      lastErrors.push({ time: timestamp, level, message });
      if (lastErrors.length > 20) lastErrors.shift();
    }
    try {
      const sink = typeof ctx.logger?.[level] === 'function' ? ctx.logger : console;
      sink[level](`[wechat-ai-bridge] ${message}`);
    } catch { /* Logging must never interrupt message processing. */ }
    try {
      fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
      const line = `${timestamp} ${level.toUpperCase()} ${message.replace(/[\r\n]+/g, ' ')}\n`;
      if (fs.existsSync(config.logPath) && fs.statSync(config.logPath).size + Buffer.byteLength(line) > config.logMaxBytes) {
        fs.renameSync(config.logPath, `${config.logPath}.1`);
      }
      fs.appendFileSync(config.logPath, line, { mode: 0o600 });
    } catch { /* The Host logger remains available if the log path is unwritable. */ }
  };
  return {
    clean, lastErrors, addSecret: value => { if (value) secrets.add(value); },
    info: value => write('info', value), warn: value => write('warn', value), error: value => write('error', value),
    rate(key, value) {
      const now = Date.now();
      const previous = limits.get(key);
      if (previous && now < previous.next) return;
      const delay = previous ? Math.min(previous.delay * 2, 300000) : 30000;
      limits.set(key, { delay, next: now + delay });
      write('warn', `${key}: ${clean(value)}`);
    },
    reset: key => limits.delete(key),
  };
}

/** FIFO semaphore; closing wakes waiters so cleanup cannot strand queued work. */
export class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; this.closed = false; }
  async acquire() {
    if (this.closed) throw new Error('Bridge stopped');
    if (this.active < this.limit) { this.active++; return; }
    await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Bridge stopped'));
  }
}

/** Await a task with a clearable deadline and optional lifecycle cancellation. */
export async function withTimeout(task, ms, signal) {
  let timer;
  let abort;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('wechat bridge reply timeout')), ms);
      abort = () => reject(new Error('Bridge stopped'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export const seconds = () => Math.floor(Date.now() / 1000);
export const isChatroom = contact => contact?.is_chatroom === true || String(contact?.username || '').endsWith('@chatroom');
export const isTextMessage = message => (message.type === 1 || message.type === 2) && typeof message.text === 'string' && !!message.text.trim();
/** Quote/reply messages carry their text only through parse_media=true. */
export const isQuoteMessage = message => message?.type_name === '引用消息' || message?.type === 244813135921;
/** WeChat image messages (type 3 / 图片); the media tool can return their pixels. */
export const isImageMessage = message => message?.type === 3 || message?.type_name === '图片';
/** WeChat voice messages (type 34 / 语音); wechat-ai may attach voice_to_text. */
export const isVoiceMessage = message => message?.type === 34 || String(message?.type_name || '').includes('语音');
/** Bound the transcript we put into one prompt; MCP text payloads are also bounded. */
export const MAX_VOICE_TRANSCRIPT_CHARS = 4000;
/**
 * Read the transcript supplied by wechat-ai's voice_transcription service.
 * `text` is `【语音】...` for compatibility, so only use it when the explicit
 * `voice_to_text` field is absent.
 */
export function voiceTranscript(message) {
  const explicit = typeof message?.voice_to_text === 'string' ? message.voice_to_text.trim() : '';
  if (explicit) return explicit.slice(0, MAX_VOICE_TRANSCRIPT_CHARS);
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const match = text.match(/^【语音】(.*)$/s);
  return match ? match[1].trim().slice(0, MAX_VOICE_TRANSCRIPT_CHARS) : '';
}
/** WeChat file messages; parse_media=true exposes their path/file_name/file_size. */
export const isFileMessage = message => {
  const name = String(message?.type_name || '');
  return name === '文件' || name === '文件消息' || name.includes('文件') || message?.type === 25769803825;
};
export const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const jsonValue = value => JSON.parse(JSON.stringify(value ?? null));

/**
 * Whether the incoming text explicitly asks for a voice reply. Used to skip the
 * delayed "working" notice from the start, before the Agent has prepared audio.
 */
export function isVoiceRequest(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (/(?:不要|别|不用|无需|不需要|禁止)(?:用|发|回|来|整)?(?:语音|voice)/i.test(value)) return false;
  const chinese = /(?:发|回|来|用|整|说)[^。！？\n]{0,6}(?:语音|音频|voice)/i.test(value)
    || /(?:语音|voice)[^。！？\n]{0,6}(?:回复|回答|打招呼|消息|条)/i.test(value);
  const english = /\b(?:send|reply|answer|use|record)\b[^.\n]{0,24}\bvoice\b/i.test(value)
    || /\bvoice\b[^.\n]{0,24}\b(?:reply|message|note|answer)\b/i.test(value);
  return chinese || english;
}
