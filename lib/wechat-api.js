/** Validate semantic MCP results instead of silently treating errors as empty lists. */
export class WechatApi {
  constructor(client) { this.client = client; }

  /** Validate one JSON payload returned in the first text content block. */
  validate(name, data, listKey) {
    if (!data || typeof data !== 'object' || data.raw !== undefined || data.status === 'error' || data.status === 'failed') {
      throw new Error(`wechat-ai ${name}: invalid or failed result`);
    }
    if (listKey && !Array.isArray(data[listKey])) throw new Error(`wechat-ai ${name}: missing ${listKey}`);
    return data;
  }

  async read(name, args = {}, listKey) {
    return this.validate(name, await this.client.callJson(name, args), listKey);
  }

  /**
   * Run a media-capable tool and keep its complete MCP content.
   *
   * wechat-ai returns the JSON metadata in the first text block and decoded
   * pictures as following `image` blocks. Each image message carries a 1-based
   * `image_content_index` into that content list; attach the block back to the
   * message so the bridge can forward pixels without a second lookup.
   */
  async readMedia(name, args = {}, listKey = 'messages') {
    const result = await this.client.callTool(name, args);
    let data;
    try { data = JSON.parse(result.text); }
    catch { throw new Error(`wechat-ai ${name}: media metadata is not JSON`); }
    this.validate(name, data, listKey);
    const images = result.content.filter(block => block.type === 'image' && block.data);
    for (const message of data[listKey]) {
      const index = Number(message.image_content_index);
      if (Number.isInteger(index) && index >= 1 && index <= images.length) {
        message.image_block = images[index - 1];
      }
      const quoteIndex = Number(message.quote_image_content_index);
      if (Number.isInteger(quoteIndex) && quoteIndex >= 1 && quoteIndex <= images.length) {
        message.quote_image_block = images[quoteIndex - 1];
      }
    }
    data.image_blocks = images;
    return data;
  }

  runtimeStatus() { return this.read('get_runtime_status'); }
  recentChats(limit = 50) { return this.read('get_recent_chats', { limit }, 'chats'); }
  recentMessages(contact_name, limit = 50) { return this.read('get_recent_messages', { contact_name, limit }, 'messages'); }
  /** parse_media=true exposes file paths/names and decoded image blocks. */
  recentMessagesWithMedia(contact_name, limit = 50) {
    return this.readMedia('get_recent_messages', { contact_name, limit, parse_media: true }, 'messages');
  }
  recentMedia(contact_name, limit = 20) { return this.readMedia('get_recent_media_messages', { contact_name, limit }, 'messages'); }
  searchContacts(query, limit = 20) { return this.read('search_contacts', { query, limit }, 'contacts'); }
  roomMembers(room_name) { return this.read('query_room_member_list', { room_name }, 'members'); }

  async sendText({ recipient_name, message, at_user_name, wait_seconds = 20, dry_run = false }) {
    const args = { recipient_name, message, wait_seconds, dry_run };
    if (at_user_name) args.at_user_name = at_user_name;
    const result = await this.client.callJson('send_text_msg', args);
    if (!result || typeof result.status !== 'string') throw new Error('wechat-ai send_text_msg: missing status');
    return result;
  }

  /**
   * wechat-ai stages audio bytes for the microphone RPA. Playback is real time,
   * so the default wait is the server's 60s ceiling rather than the image wait.
   */
  async sendVoice({ recipient_name, audio_base64, wait_seconds = 60, dry_run = false }) {
    const result = await this.client.callJson('send_voice_msg', {
      recipient_name, audio_base64, wait_seconds, dry_run,
    });
    if (!result || typeof result.status !== 'string') throw new Error('wechat-ai send_voice_msg: missing status');
    return result;
  }

  /** wechat-ai accepts arbitrary file bytes as base64 and stages them for the file RPA. */
  async sendFile({ recipient_name, file_base64, file_name, wait_seconds = 20, dry_run = false }) {
    const args = { recipient_name, file_base64, wait_seconds, dry_run };
    if (file_name) args.file_name = file_name;
    const result = await this.client.callJson('send_file_msg', args);
    if (!result || typeof result.status !== 'string') throw new Error('wechat-ai send_file_msg: missing status');
    return result;
  }

  /** wechat-ai accepts image bytes as base64 and stages them for the file RPA. */
  async sendImage({ recipient_name, image_base64, mime_type, file_name, wait_seconds = 20, dry_run = false }) {
    const args = { recipient_name, image_base64, wait_seconds, dry_run };
    if (mime_type) args.mime_type = mime_type;
    if (file_name) args.file_name = file_name;
    const result = await this.client.callJson('send_image_msg', args);
    if (!result || typeof result.status !== 'string') throw new Error('wechat-ai send_image_msg: missing status');
    return result;
  }
}

export const sendSucceeded = result => result?.status === 'executed' && result.completed === true;
