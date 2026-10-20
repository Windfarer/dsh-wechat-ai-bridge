/** Decode JSON or the last JSON data event in an MCP SSE response. */
export function parseResponse(body, contentType = '') {
  if (!body.trim()) return null;
  if (contentType.includes('text/event-stream') || /^data:/m.test(body)) {
    let result = null;
    for (const event of body.replace(/\r\n/g, '\n').split(/\n\n/)) {
      const lines = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
      if (!lines.length) continue;
      try { result = JSON.parse(lines.join('\n')); }
      catch {
        // Some endpoints omit blank separators; tolerate individual JSON data lines.
        for (const line of lines) if (line && line !== '[DONE]') result = JSON.parse(line);
      }
    }
    return result;
  }
  return JSON.parse(body);
}

/** Minimal serialized Streamable HTTP client. No network retry for ambiguous writes. */
export class McpClient {
  constructor({ url, token = '', timeoutMs = 30000, logger }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.sessionId = '';
    this.sessionOk = false;
    this.id = 0;
    this.tail = Promise.resolve();
    this.abort = new AbortController();
  }

  serialize(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async post(method, params, notification = false) {
    if (this.abort.signal.aborted) throw new Error('MCP client closed');
    if (!this.token) throw new Error('MCP token missing');
    const headers = {
      Authorization: `Bearer ${this.token}`, Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    if (!notification) payload.id = ++this.id;
    const response = await fetch(this.url, {
      method: 'POST', headers, body: JSON.stringify(payload),
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.abort.signal]),
    });
    if (!response.ok) {
      // FastMCP may report a stale session as a JSON-RPC error with HTTP 400.
      let rpcError;
      try { rpcError = parseResponse(await response.text(), response.headers.get('content-type') || '')?.error; }
      catch { /* Keep the HTTP error if a proxy returned HTML or an empty response. */ }
      const error = new Error(`MCP HTTP ${response.status}`);
      error.staleSession = response.status === 404 || /session/i.test(rpcError?.message || '');
      throw error;
    }
    const body = parseResponse(await response.text(), response.headers.get('content-type') || '');
    if (body?.error) {
      const error = new Error(`MCP JSON-RPC error ${body.error.code}: ${body.error.message || 'unknown error'}`);
      error.staleSession = /session/i.test(body.error.message || '');
      throw error;
    }
    if (!notification && (!body || body.id !== payload.id || !Object.hasOwn(body, 'result'))) {
      throw new Error('MCP missing or mismatched JSON-RPC response');
    }
    if (method === 'initialize') {
      this.sessionId = response.headers.get('mcp-session-id') || '';
      if (!this.sessionId) throw new Error('MCP initialize response missing mcp-session-id');
    }
    return body?.result ?? null;
  }

  async initializeInternal() {
    if (this.sessionOk) return;
    this.sessionId = '';
    try {
      await this.post('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'dsh-wechat-ai-bridge', version: '0.1.0' },
      });
      await this.post('notifications/initialized', undefined, true);
      this.sessionOk = true;
    } catch (error) {
      this.sessionId = '';
      this.sessionOk = false;
      throw error;
    }
  }

  initialize() { return this.serialize(() => this.initializeInternal()); }

  /**
   * Execute one tool and return its complete MCP content list.
   *
   * Media tools now put JSON metadata in the first text block and decoded
   * pictures in following `image` blocks, so callers that forward pixels must
   * keep the full content instead of joining text blocks only.
   */
  callTool(name, args = {}) {
    return this.serialize(async () => {
      try {
        await this.initializeInternal();
        let result;
        try { result = await this.post('tools/call', { name, arguments: args }); }
        catch (error) {
          if (!error.staleSession) throw error;
          this.sessionOk = false;
          await this.initializeInternal();
          result = await this.post('tools/call', { name, arguments: args });
        }
        if (!result || !Array.isArray(result.content)) throw new Error(`MCP ${name}: missing tool content`);
        const content = result.content;
        const text = content.filter(block => block.type === 'text').map(block => block.text || '').join('\n');
        if (result.isError === true) throw new Error(`MCP ${name}: ${text || 'tool error'}`);
        return { content, text, isError: false };
      } catch (error) {
        // A later call may reconnect, but a possibly executed send is never replayed here.
        this.sessionOk = false;
        throw error;
      }
    });
  }

  async callText(name, args = {}) {
    return (await this.callTool(name, args)).text;
  }

  async callJson(name, args = {}) {
    const text = await this.callText(name, args);
    try { return JSON.parse(text); }
    catch { return { raw: text }; }
  }

  close() { this.sessionOk = false; this.abort.abort(); }
}
