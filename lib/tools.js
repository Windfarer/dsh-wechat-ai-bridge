import fs from 'node:fs';
import path from 'node:path';
import { isChatroom, jsonValue } from './util.js';
import { synthesizeSpeech } from './tts.js';
import { resolveWorkspacePath } from './workspace-tools.js';

/** wechat-ai's send_image_msg / send_file_msg reject uploads above 10 MiB. */
const MAX_SEND_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SEND_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
// FFmpeg in wechat-ai decodes these; the server still enforces 1–55s and 10 MiB.
const MAX_SEND_VOICE_BYTES = 10 * 1024 * 1024;
const VOICE_EXTENSIONS = new Set([
  '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.amr', '.wma', '.webm',
]);

/** Enforce schemas ourselves, including unknown fields such as dry_run. */
function validate(args, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const key of Object.keys(args)) if (!Object.hasOwn(fields, key)) throw new Error(`Unknown parameter: ${key}`);
  const value = {};
  for (const [key, rule] of Object.entries(fields)) {
    let input = args[key];
    if (input === undefined) {
      if (rule.required) throw new Error(`${key} is required`);
      input = rule.default;
      if (input === undefined) continue;
    }
    if (typeof input !== rule.type) throw new Error(`${key} must be ${rule.type}`);
    if (rule.type === 'string') {
      input = input.trim();
      if (!input) throw new Error(`${key} must not be empty`);
    }
    if (rule.type === 'boolean') {
      value[key] = input;
      continue;
    }
    if (rule.type === 'number' && (!Number.isFinite(input) || input < rule.minimum || input > rule.maximum
        || (rule.integer && !Number.isInteger(input)))) {
      throw new Error(`${key} must be ${rule.integer ? 'an integer' : 'a number'} from ${rule.minimum} to ${rule.maximum}`);
    }
    value[key] = input;
  }
  return value;
}

/** WeChat tools a bridged Agent is expected to see; an explicit allowlist may omit them. */
export const WECHAT_AGENT_TOOLS = [
  'wechat_recent_messages', 'wechat_send_image', 'wechat_send_file',
  'wechat_voice_intent', 'wechat_send_voice_text', 'wechat_send_voice',
];

/** Register all global tools synchronously, returning explicit lifecycle disposers. */
export function registerTools(ctx, bridge, api, disposers = []) {
  const str = (required = false) => ({ type: 'string', required });
  const num = (defaultValue, minimum, maximum, integer = true) => ({ type: 'number', default: defaultValue, minimum, maximum, integer });
  const register = (name, description, fields, execute, array = false) => {
    const properties = {};
    for (const [key, rule] of Object.entries(fields)) {
      const { required, integer, ...schema } = rule;
      properties[key] = { ...schema, type: integer ? 'integer' : schema.type };
      if (rule.type === 'string') properties[key].minLength = 1;
    }
    const dispose = ctx.tools.register({
      name, description,
      parameters: { type: 'object', properties, required: Object.keys(fields).filter(key => fields[key].required), additionalProperties: false },
      output: {
        schema: array ? { type: 'array', items: { type: 'object', additionalProperties: true } } : { type: 'object', additionalProperties: true },
        render(args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]; },
      },
      async execute(args) { return jsonValue(await execute(validate(args, fields))); },
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  register('wechat_send_message',
    '向微信联系人或群聊发送真实文本消息。 Send a real text message to a WeChat contact or group.',
    { recipient_name: str(true), message: str(true), at_user_name: str(), wait_seconds: num(20, 0, 30, false) },
    async args => {
      const result = await api.sendText({ ...args, dry_run: false });
      bridge.state.runtime.writeBlocked = result.status === 'blocked';
      if (result.status === 'blocked') {
        bridge.logger.rate('write-blocked', 'wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true');
        throw new Error('wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true and restart wechat-ai');
      }
      return { status: result.status, recipient: result.recipient ?? args.recipient_name,
        resolved: result.resolved ?? result.resolved_recipient ?? null, message_preview: args.message.slice(0, 120),
        completed: result.completed === true, result: result.result ?? null };
    });

  register('wechat_send_image',
    '把工作区里的图片文件作为微信图片发送（支持 PNG/JPEG/WebP/GIF，最大 10 MiB）。 Send an image file from the workspace as a WeChat image message.',
    { recipient_name: str(true), file_path: str(true), file_name: str(), dry_run: { type: 'boolean', default: false }, wait_seconds: num(20, 0, 60, false) },
    async args => {
      const scope = await bridge.currentChatScope();
      if (scope && args.recipient_name !== scope.username && args.recipient_name !== scope.displayName) {
        throw new Error('wechat_send_image: recipient_name must match the current WeChat bridge chat');
      }
      const recipient = scope ? scope.username : args.recipient_name;
      const root = await bridge.imageWorkspaceRoot();
      const absolute = resolveWorkspacePath(root, args.file_path);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error(`not a regular file: ${args.file_path}`);
      if (stat.size === 0) throw new Error(`image file is empty: ${args.file_path}`);
      if (stat.size > MAX_SEND_IMAGE_BYTES) throw new Error(`image file exceeds 10 MiB: ${args.file_path}`);
      const mimeType = IMAGE_MIME_BY_EXT[path.extname(absolute).toLowerCase()];
      const fileName = args.file_name || path.basename(absolute);
      const data = fs.readFileSync(absolute);
      const result = await api.sendImage({
        recipient_name: recipient,
        image_base64: data.toString('base64'),
        mime_type: mimeType,
        file_name: fileName,
        dry_run: args.dry_run,
        wait_seconds: args.wait_seconds,
      });
      bridge.state.runtime.writeBlocked = result.status === 'blocked';
      if (result.status === 'blocked') {
        bridge.logger.rate('write-blocked', 'wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true');
        throw new Error('wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true and restart wechat-ai');
      }
      return {
        status: result.status,
        recipient: result.recipient_name ?? recipient,
        resolved: result.resolved ?? null,
        image: result.image ?? { mime_type: mimeType ?? null, bytes: stat.size, file_name: fileName },
        dry_run: result.dry_run === true,
        queued: result.queued === true,
        completed: result.completed === true,
        result: result.result ?? null,
      };
    });

  register('wechat_send_file',
    '把工作区里的文件作为微信文件发送（任意类型，最大 10 MiB）；发送结果未确认时不要自动重发。 Send a file from the workspace as a WeChat file message.',
    { recipient_name: str(true), file_path: str(true), file_name: str(), dry_run: { type: 'boolean', default: false }, wait_seconds: num(20, 0, 60, false) },
    async args => {
      const scope = await bridge.currentChatScope();
      if (scope && args.recipient_name !== scope.username && args.recipient_name !== scope.displayName) {
        throw new Error('wechat_send_file: recipient_name must match the current WeChat bridge chat');
      }
      const recipient = scope ? scope.username : args.recipient_name;
      if (args.file_name && (args.file_name.includes('/') || args.file_name.includes('\\'))) {
        throw new Error('wechat_send_file: file_name must be a plain file name');
      }
      const root = await bridge.fileWorkspaceRoot();
      const absolute = resolveWorkspacePath(root, args.file_path);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error(`not a regular file: ${args.file_path}`);
      if (stat.size === 0) throw new Error(`file is empty: ${args.file_path}`);
      if (stat.size > MAX_SEND_FILE_BYTES) throw new Error(`file exceeds 10 MiB: ${args.file_path}`);
      const fileName = args.file_name || path.basename(absolute);
      const data = fs.readFileSync(absolute);
      const result = await api.sendFile({
        recipient_name: recipient,
        file_base64: data.toString('base64'),
        file_name: fileName,
        dry_run: args.dry_run,
        wait_seconds: args.wait_seconds,
      });
      bridge.state.runtime.writeBlocked = result.status === 'blocked';
      if (result.status === 'blocked') {
        bridge.logger.rate('write-blocked', 'wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true');
        throw new Error('wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true and restart wechat-ai');
      }
      return {
        status: result.status,
        recipient: result.recipient_name ?? recipient,
        resolved: result.resolved ?? null,
        file: result.file ?? { bytes: stat.size, file_name: fileName },
        dry_run: result.dry_run === true,
        queued: result.queued === true,
        completed: result.completed === true,
        result: result.result ?? null,
      };
    });

  register('wechat_voice_intent',
    '声明本轮将用语音回复，立即取消尚未发出的“稍等”文字提示；不会发送任何微信消息。决定用语音后、准备或生成音频之前先调用；仅在当前微信桥接会话内可用。 Declare that this turn will answer by voice so the delayed working notice is suppressed. Sends no WeChat message; call it as soon as you decide to use voice, before preparing audio.',
    {},
    async () => {
      const scope = await bridge.currentChatScope();
      if (!scope) throw new Error('wechat_voice_intent requires an active WeChat bridge chat');
      if (!bridge.noteVoiceIntent(scope)) throw new Error('wechat_voice_intent requires an active WeChat bridge turn');
      return { status: 'ok', voice_reply: true };
    });

  register('wechat_send_voice_text',
    '把文本通过已配置的 TTS 服务合成为语音并作为微信原生语音条发送（无需先在工作区生成音频）。仅在发送人明确要求“发语音/用语音回复”，或这条回复确实更适合语音时使用；其他情况走文字回复。发送前会自动取消尚未发出的“稍等”提示。 Synthesize text through the configured TTS service and send it as a native WeChat voice message; use only when the sender explicitly asks for voice or the reply genuinely benefits from voice.',
    { text: str(true), wait_seconds: num(60, 0, 60, false) },
    async args => {
      const scope = await bridge.currentChatScope();
      if (!scope) throw new Error('wechat_send_voice_text requires an active WeChat bridge chat');
      const tts = bridge.config.tts;
      if (!tts?.enabled) throw new Error('wechat_send_voice_text requires TTS to be enabled in the bridge settings');
      const text = args.text.trim();
      const maxChars = Number.isInteger(tts.maxChars) ? tts.maxChars : 240;
      if (Array.from(text).length > maxChars) throw new Error(`wechat_send_voice_text: text exceeds ${maxChars} characters`);
      // Declare intent before the network round trip, so a slow TTS request cannot
      // race the delayed "working" text notice.
      bridge.noteVoiceIntent(scope);
      const audio = await synthesizeSpeech(tts, text);
      if (audio.buffer.length > MAX_SEND_VOICE_BYTES) throw new Error('generated voice exceeds 10 MiB');
      const result = await api.sendVoice({
        recipient_name: scope.username,
        audio_base64: audio.buffer.toString('base64'),
        wait_seconds: args.wait_seconds,
      });
      bridge.state.runtime.writeBlocked = result.status === 'blocked';
      if (result.status === 'blocked') {
        bridge.logger.rate('write-blocked', 'wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true');
        throw new Error('wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true and restart wechat-ai');
      }
      if (['executed', 'timeout', 'queued'].includes(result.status)) bridge.noteVoiceSent(scope);
      return {
        status: result.status,
        recipient: result.recipient_name ?? scope.username,
        resolved: result.resolved ?? null,
        audio: result.audio ?? { mime_type: audio.mimeType, bytes: audio.buffer.length },
        text_chars: Array.from(text).length,
        queued: result.queued === true,
        completed: result.completed === true,
        result: result.result ?? null,
      };
    });

  register('wechat_send_voice',
    '把工作区里的音频文件作为微信原生语音条发送（支持 WAV/MP3/M4A/OGG/FLAC 等，时长 1–55 秒，最大 10 MiB）。仅在发送人明确要求“发语音/用语音回复”，或这条回复确实更适合语音时使用；其他情况不要调用，直接按原文字路径回复。需要先生成音频时，可在工作区用 workspace_run 生成。 Send an audio file from the workspace as a native WeChat voice message; use only when the sender explicitly asks for voice or the reply genuinely benefits from voice.',
    { recipient_name: str(true), file_path: str(true), dry_run: { type: 'boolean', default: false }, wait_seconds: num(60, 0, 60, false) },
    async args => {
      const scope = await bridge.currentChatScope();
      if (scope && args.recipient_name !== scope.username && args.recipient_name !== scope.displayName) {
        throw new Error('wechat_send_voice: recipient_name must match the current WeChat bridge chat');
      }
      const recipient = scope ? scope.username : args.recipient_name;
      const root = await bridge.voiceWorkspaceRoot();
      const absolute = resolveWorkspacePath(root, args.file_path);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error(`not a regular file: ${args.file_path}`);
      if (stat.size === 0) throw new Error(`voice file is empty: ${args.file_path}`);
      if (stat.size > MAX_SEND_VOICE_BYTES) throw new Error(`voice file exceeds 10 MiB: ${args.file_path}`);
      const extension = path.extname(absolute).toLowerCase();
      if (!VOICE_EXTENSIONS.has(extension)) {
        throw new Error(`unsupported voice file type: ${extension || '(none)'}; use WAV, MP3, M4A, OGG or FLAC`);
      }
      const data = fs.readFileSync(absolute);
      const result = await api.sendVoice({
        recipient_name: recipient,
        audio_base64: data.toString('base64'),
        dry_run: args.dry_run,
        wait_seconds: args.wait_seconds,
      });
      bridge.state.runtime.writeBlocked = result.status === 'blocked';
      if (result.status === 'blocked') {
        bridge.logger.rate('write-blocked', 'wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true');
        throw new Error('wechat-ai MCP write is disabled; set WECHAT_AI_MCP_WRITE_ENABLED=true and restart wechat-ai');
      }
      // A queued/timed-out local voice action still plays on the RPA worker, so
      // suppress the text reply for any accepted voice send, not only a quick
      // completed result. Failed/blocked writes never reach this branch.
      if (!args.dry_run && scope && ['executed', 'timeout', 'queued'].includes(result.status)) {
        bridge.noteVoiceSent(scope);
      }
      return {
        status: result.status,
        recipient: result.recipient_name ?? recipient,
        resolved: result.resolved ?? null,
        audio: result.audio ?? { bytes: stat.size, file_name: path.basename(absolute) },
        dry_run: result.dry_run === true,
        queued: result.queued === true,
        completed: result.completed === true,
        result: result.result ?? null,
      };
    });

  register('wechat_list_chats', '读取最近的微信会话。 List recent WeChat chats.', { limit: num(20, 1, 100) },
    async ({ limit }) => {
      if (await bridge.currentChatScope()) {
        throw new Error('wechat_list_chats is unavailable to a chat-bound WeChat bridge Agent');
      }
      return (await api.recentChats(limit)).chats.map(chat => ({
        username: chat.contact?.username || '', name: chat.contact?.display_name || '', is_chatroom: isChatroom(chat.contact),
        last_time: chat.last_message?.time ?? chat.last_message?.create_time ?? null,
        last_sender: chat.last_message?.sender_display || chat.last_message?.sender_username || '',
        last_text: chat.last_message?.text || '',
      }));
    }, true);

  register('wechat_recent_messages', '读取指定微信会话的最近消息。 Read recent messages in a WeChat chat.',
    { contact_name: str(true), limit: num(30, 1, 200) },
    async ({ contact_name, limit }) => {
      const scope = await bridge.currentChatScope();
      if (scope && contact_name !== scope.username && contact_name !== scope.displayName) {
        throw new Error('wechat_recent_messages: contact_name must match the current WeChat bridge chat');
      }
      return (await api.recentMessages(scope ? scope.username : contact_name, limit)).messages.map(message => ({
        time: message.time ?? message.create_time ?? null, sender: message.sender_display || message.sender_username || '',
        text: message.text || '', type: message.type ?? null,
      }));
    }, true);

  register('wechat_search_contacts', '搜索微信联系人和群聊。 Search WeChat contacts and groups.',
    { query: str(true), limit: num(20, 1, 100) },
    async ({ query, limit }) => {
      if (await bridge.currentChatScope()) {
        throw new Error('wechat_search_contacts is unavailable to a chat-bound WeChat bridge Agent');
      }
      return (await api.searchContacts(query, limit)).contacts.map(contact => ({
        username: contact.username || '', name: contact.display_name || '', nick_name: contact.nick_name || '',
        remark: contact.remark || '', alias: contact.alias || '', is_chatroom: isChatroom(contact),
      }));
    }, true);

  register('wechat_ai_bridge_status', '查看微信桥接健康、会话和统计。 Inspect WeChat bridge health, sessions and statistics.',
    {}, () => bridge.status());

  register('wechat_ai_bridge_control',
    '暂停或恢复自动回复；暂停仍推进水位，恢复不补发。 Pause or resume auto replies without replaying messages received while paused.',
    { paused: { type: 'boolean', required: true } }, ({ paused }) => bridge.setPaused(paused));
  return disposers;
}
