/**
 * Host-side JSON route backing the WeChat bridge settings page.
 *
 * The native settings form only serves volatile schema fields; this bridge's
 * configuration is plain and must restart the plugin, so the page talks to a
 * small same-origin route instead. Reads come from the live normalized config
 * (never the token), writes go through configEditor so the profile patch stays
 * the single durable source of truth.
 */

const MAX_BODY_BYTES = 262144;

const FIELD_TYPES = {
  mcpUrl: 'string',
  tokenFile: 'string',
  tokenEnv: 'string',
  workspaceMode: 'workspaceMode',
  workspaceTitle: 'string',
  agentPreset: 'string',
  permissionPreset: 'string',
  pollIntervalMs: 'number',
  turnTimeoutMs: 'number',
  execTimeoutMs: 'number',
  requestTimeoutMs: 'number',
  maxConcurrentChats: 'number',
  maxSessions: 'number',
  workspaceTools: 'boolean',
  'model.provider': 'string',
  'model.model': 'string',
  'model.reasoningEffort': 'string',
  'codex.enabled': 'boolean',
  'codex.timeoutMs': 'number',
  'tts.enabled': 'boolean',
  'tts.baseUrl': 'string',
  'tts.apiKey': 'string',
  'tts.model': 'string',
  'tts.voice': 'string',
  'tts.timeoutMs': 'number',
  'tts.maxChars': 'number',
  toolAllowlist: 'toolAllowlist',
  mentionNames: 'stringArray',
  'reply.private': 'boolean',
  'reply.groupMention': 'boolean',
  'reply.groupAll': 'boolean',
  'reply.attachAtInGroup': 'boolean',
  'reply.mentionPrefixFallback': 'boolean',
  'reply.history': 'boolean',
  'reply.debounceMs': 'number',
  'reply.maxReplyChars': 'number',
  'reply.maxPromptChars': 'number',
  'reply.maxRepliesPerMinute': 'number',
  'reply.rateLimitWindowMs': 'number',
  'reply.workingNoticeMs': 'number',
  'reply.workingNoticeText': 'string',
  'reply.workingNoticeTexts': 'stringArray',
  'reply.allowContacts': 'stringArray',
  'reply.denyContacts': 'stringArray',
  'reply.images': 'boolean',
  'reply.maxImagesPerMessage': 'number',
  'reply.imageContextAgeMs': 'number',
  'reply.maxImageBytes': 'number',
  'reply.imageDedupe': 'boolean',
  'reply.imageDedupeWindowMs': 'number',
  'reply.files': 'boolean',
  'reply.fileContextAgeMs': 'number',
  'reply.maxFileBytes': 'number',
};

const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function validValue(kind, value) {
  if (kind === 'workspaceMode') return value === 'per-chat' || value === 'shared';
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'stringArray') return isStringArray(value);
  if (kind === 'toolAllowlist') return value === null || isStringArray(value);
  return false;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Copy only the editable surface; the token never crosses the wire. */
function publicValues(config) {
  return {
    mcpUrl: config.mcpUrl,
    tokenFile: config.tokenFile,
    tokenEnv: config.tokenEnv,
    workspaceMode: config.workspaceMode,
    workspaceTitle: config.workspaceTitle,
    agentPreset: config.agentPreset,
    permissionPreset: config.permissionPreset,
    pollIntervalMs: config.pollIntervalMs,
    turnTimeoutMs: config.turnTimeoutMs,
    execTimeoutMs: config.execTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxConcurrentChats: config.maxConcurrentChats,
    maxSessions: config.maxSessions,
    workspaceTools: config.workspaceTools,
    model: {
      provider: config.model?.provider ?? '',
      model: config.model?.model ?? '',
      reasoningEffort: config.model?.reasoningEffort ?? '',
    },
    codex: {
      enabled: config.codex?.enabled === true,
      timeoutMs: config.codex?.timeoutMs,
    },
    tts: {
      enabled: config.tts?.enabled === true,
      baseUrl: config.tts?.baseUrl ?? '',
      // Never return the API key; an empty field means "keep the stored key".
      apiKey: '',
      model: config.tts?.model ?? '',
      voice: config.tts?.voice ?? '',
      timeoutMs: config.tts?.timeoutMs,
      maxChars: config.tts?.maxChars,
    },
    toolAllowlist: config.toolAllowlist,
    mentionNames: [...(config.mentionNames ?? [])],
    reply: {
      private: config.reply.private,
      groupMention: config.reply.groupMention,
      groupAll: config.reply.groupAll,
      attachAtInGroup: config.reply.attachAtInGroup,
      mentionPrefixFallback: config.reply.mentionPrefixFallback,
      history: config.reply.history,
      debounceMs: config.reply.debounceMs,
      maxReplyChars: config.reply.maxReplyChars,
      maxPromptChars: config.reply.maxPromptChars,
      maxRepliesPerMinute: config.reply.maxRepliesPerMinute,
      rateLimitWindowMs: config.reply.rateLimitWindowMs,
      workingNoticeMs: config.reply.workingNoticeMs,
      workingNoticeText: config.reply.workingNoticeText,
      workingNoticeTexts: [...(config.reply.workingNoticeTexts ?? [])],
      allowContacts: [...(config.reply.allowContacts ?? [])],
      denyContacts: [...(config.reply.denyContacts ?? [])],
      images: config.reply.images,
      maxImagesPerMessage: config.reply.maxImagesPerMessage,
      imageContextAgeMs: config.reply.imageContextAgeMs,
      maxImageBytes: config.reply.maxImageBytes,
      imageDedupe: config.reply.imageDedupe,
      imageDedupeWindowMs: config.reply.imageDedupeWindowMs,
      files: config.reply.files,
      fileContextAgeMs: config.reply.fileContextAgeMs,
      maxFileBytes: config.reply.maxFileBytes,
    },
    readOnly: {
      workspacePath: config.workspacePath,
      statePath: config.statePath,
      logPath: config.logPath,
      selfUsername: config.selfUsername,
      codexBinary: config.codex?.binary ?? '',
      codexAuthSource: config.codex?.authSource ?? '',
    },
  };
}

/** Read one nested value by a dotted path. */
function getPath(object, path) {
  let value = object;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[key];
  }
  return value;
}

/** Write one nested value by a dotted path into a detached object. */
function setPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
}

/** Collect a validated dotted-path patch from the client payload. */
function collectPatch(input) {
  const patch = {};
  const walk = (value, prefix = '') => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      const kind = FIELD_TYPES[prefix];
      if (kind === undefined) throw new Error(`Unknown or read-only field: ${prefix || '(root)'}`);
      if (!validValue(kind, value)) throw new Error(`Invalid value for ${prefix}`);
      // Keep dotted paths flat; the profile edit below walks them explicitly.
      patch[prefix] = clone(value);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key);
  };
  walk(input);
  return patch;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Request body is not JSON')); }
    });
    req.on('error', reject);
  });
}

/** Find the profile row this package was inserted as. */
function findEntry(configEditor) {
  const entries = configEditor.entries();
  return entries.find(entry => entry.options?.name === 'dsh-wechat-ai-bridge' && String(entry.options?.id ?? '').includes('wechat-ai-bridge'))
    ?? entries.find(entry => entry.options?.name === 'dsh-wechat-ai-bridge')
    ?? null;
}

/**
 * Register the settings route on a context that carries webServer, connection,
 * and configEditor. The route is same-origin and reuses the browser admission
 * check the rest of the Host uses; no token ever leaves the process.
 */
export function registerSettingsRoute(ctx, bridge, config, logger) {
  const route = {
    kind: 'exact',
    path: '/wechat-ai-bridge/config',
    async handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { status: 'ok', values: publicValues(config) });
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        const body = await readBody(req);
        const patch = collectPatch(body?.values);
        if (Object.hasOwn(patch, 'mcpUrl') && !String(patch.mcpUrl).trim()) {
          throw new Error('mcpUrl must not be empty');
        }
        if (Object.hasOwn(patch, 'tts.apiKey') && !String(patch['tts.apiKey']).trim()) {
          delete patch['tts.apiKey'];
        }
        if (patch['tts.enabled'] === true && Object.hasOwn(patch, 'tts.baseUrl') && !String(patch['tts.baseUrl']).trim()) {
          throw new Error('tts.baseUrl must not be empty when TTS is enabled');
        }
        if (Object.hasOwn(patch, 'tts.baseUrl') && patch['tts.baseUrl'] && !/^https?:\/\//i.test(patch['tts.baseUrl'])) {
          throw new Error('tts.baseUrl must start with http:// or https://');
        }
        const entry = findEntry(ctx.configEditor);
        if (!entry) throw new Error('Cannot locate the wechat-ai-bridge profile row');
        await ctx.configEditor.edit(entry, current => {
          const next = { ...(current ?? {}) };
          for (const [path, value] of Object.entries(patch)) {
            const keys = path.split('.');
            let target = next;
            for (const key of keys.slice(0, -1)) {
              if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
              target = target[key];
            }
            target[keys[keys.length - 1]] = clone(value);
          }
          return next;
        });
        sendJson(res, 200, { status: 'saved' });
      } catch (error) {
        logger.rate('settings-route', error);
        if (!res.headersSent) sendJson(res, 400, { status: 'error', message: error.message });
        else res.end();
      }
    },
  };
  return ctx.webServer.register(route);
}
