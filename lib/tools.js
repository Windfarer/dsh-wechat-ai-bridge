import fs from 'node:fs';
import path from 'node:path';
import { isChatroom, jsonValue } from './util.js';
import { resolveWorkspacePath } from './workspace-tools.js';

/** wechat-ai's send_image_msg rejects decoded images above 10 MiB. */
const MAX_SEND_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

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
      const root = bridge.workspaceDir || bridge.config.workspacePath;
      const absolute = resolveWorkspacePath(root, args.file_path);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error(`not a regular file: ${args.file_path}`);
      if (stat.size === 0) throw new Error(`image file is empty: ${args.file_path}`);
      if (stat.size > MAX_SEND_IMAGE_BYTES) throw new Error(`image file exceeds 10 MiB: ${args.file_path}`);
      const mimeType = IMAGE_MIME_BY_EXT[path.extname(absolute).toLowerCase()];
      const fileName = args.file_name || path.basename(absolute);
      const data = fs.readFileSync(absolute);
      const result = await api.sendImage({
        recipient_name: args.recipient_name,
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
        recipient: result.recipient_name ?? args.recipient_name,
        resolved: result.resolved ?? null,
        image: result.image ?? { mime_type: mimeType ?? null, bytes: stat.size, file_name: fileName },
        dry_run: result.dry_run === true,
        queued: result.queued === true,
        completed: result.completed === true,
        result: result.result ?? null,
      };
    });

  register('wechat_list_chats', '读取最近的微信会话。 List recent WeChat chats.', { limit: num(20, 1, 100) },
    async ({ limit }) => (await api.recentChats(limit)).chats.map(chat => ({
      username: chat.contact?.username || '', name: chat.contact?.display_name || '', is_chatroom: isChatroom(chat.contact),
      last_time: chat.last_message?.time ?? chat.last_message?.create_time ?? null,
      last_sender: chat.last_message?.sender_display || chat.last_message?.sender_username || '',
      last_text: chat.last_message?.text || '',
    })), true);

  register('wechat_recent_messages', '读取指定微信会话的最近消息。 Read recent messages in a WeChat chat.',
    { contact_name: str(true), limit: num(30, 1, 200) },
    async ({ contact_name, limit }) => (await api.recentMessages(contact_name, limit)).messages.map(message => ({
      time: message.time ?? message.create_time ?? null, sender: message.sender_display || message.sender_username || '',
      text: message.text || '', type: message.type ?? null,
    })), true);

  register('wechat_search_contacts', '搜索微信联系人和群聊。 Search WeChat contacts and groups.',
    { query: str(true), limit: num(20, 1, 100) },
    async ({ query, limit }) => (await api.searchContacts(query, limit)).contacts.map(contact => ({
      username: contact.username || '', name: contact.display_name || '', nick_name: contact.nick_name || '',
      remark: contact.remark || '', alias: contact.alias || '', is_chatroom: isChatroom(contact),
    })), true);

  register('wechat_ai_bridge_status', '查看微信桥接健康、会话和统计。 Inspect WeChat bridge health, sessions and statistics.',
    {}, () => bridge.status());

  register('wechat_ai_bridge_control',
    '暂停或恢复自动回复；暂停仍推进水位，恢复不补发。 Pause or resume auto replies without replaying messages received while paused.',
    { paused: { type: 'boolean', required: true } }, ({ paused }) => bridge.setPaused(paused));
  return disposers;
}
