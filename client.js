window.__ModuleLoader__.load({
  id: 'dsh-wechat-ai-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'wechat-ai-bridge-settings';
    const ENDPOINT = '/wechat-ai-bridge/config';

    const zh = {
      nav: '微信桥接',
      title: '微信桥接设置',
      intro: '修改会写入当前 profile 的插件配置并重载桥接；正在进行的微信回合不受影响。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，插件正在应用新配置。',
      reload: '重新读取',
      loadFailed: '加载失败',
      loading: '加载中…',
      saveFailed: '保存失败',
      unavailable: '当前部署没有提供 Web 设置入口。',
      advanced: '高级选项',
      readOnly: '只读',
      groupBasic: '基础',
      groupPersona: '人设',
      groupModel: '模型',
      groupTts: '文字转语音（TTS）',
      groupReply: '自动回复',
      groupMedia: '图片与文件',
      groupTools: '工具与 Codex',
      workspaceTitle: '工作区标题',
      workspaceTitleHint: '工作区标题前缀；逐聊天模式会附加联系人或群名称。',
      workspaceMode: '工作区模式',
      workspaceModeHint: '逐聊天模式按联系人和群隔离目录；共享模式使用同一目录。切换后不匹配的会话会重新创建，旧数据保留。',
      workspacePerChat: '逐聊天隔离（默认）',
      workspaceShared: '共享工作区',
      persona: '人设设定',
      personaHint: '可选。会附加到每轮微信消息提示开头，用于设定身份、语气和称呼（最多 1200 字）；留空则使用默认助手人设。',
      agentPreset: 'Agent 预设',
      agentPresetHint: '例如 wechat-work；修改后新建会话生效。',
      permissionPreset: '权限预设',
      permissionPresetHint: '例如 wechat-work。',
      pollIntervalMs: '轮询间隔（毫秒）',
      turnTimeoutMs: '单轮超时（毫秒）',
      execTimeoutMs: 'workspace_run 超时（毫秒）',
      modelProvider: '模型 provider',
      modelProviderHint: 'provider 与 model 都填写时才覆盖 DSH 默认模型。',
      modelName: '模型名称',
      modelEffort: '推理强度',
      ttsEnabled: '启用 TTS 语音合成',
      ttsBaseUrl: 'TTS Base URL',
      ttsBaseUrlHint: 'OpenAI 兼容端点，例如 http://10.0.0.14:8000/v1；实际请求 Base URL + /audio/speech。',
      ttsApiKey: 'TTS API Key',
      ttsApiKeyHint: '不会回显；留空表示保持现有 Key。无鉴权的本地服务可填 unused。',
      ttsModel: 'TTS 模型',
      ttsModelHint: '例如 breeze-tts-2。',
      ttsVoice: 'TTS 音色',
      ttsVoiceHint: '例如 alloy（本地默认女声）。',
      ttsInstructions: 'TTS 音色指令（可选）',
      ttsInstructionsHint: '可选。作为 instructions 字段发给支持该参数的 TTS 服务，用于控制音色、情绪或说话风格；留空则不发送。',
      ttsTimeout: 'TTS 超时（毫秒）',
      ttsMaxChars: '单次合成最大字数',
      ttsMaxCharsHint: '限制文本长度，避免生成超过微信 55 秒上限的语音。',
      replyPrivate: '回复私聊',
      replyGroupMention: '回复群里 @',
      replyGroupAll: '回复所有群消息',
      replyAttachAt: '群回复时 @ 对方',
      replyHistory: '首次轮询处理历史消息',
      replyDebounce: '消息合并延迟（毫秒）',
      replyMaxChars: '单条回复最大字数',
      replyMaxPrompt: '输入 prompt 最大字数',
      replyRate: '每分钟最大回复数',
      replyWorkingNoticeMs: '工作中提示延迟（毫秒）',
      replyWorkingNoticeTexts: '工作中提示文案（每行一条，随机使用）',
      mediaImages: '接收图片',
      mediaMaxImages: '单条消息最多图片数',
      mediaImageAge: '图片上下文窗口（毫秒）',
      mediaMaxImageBytes: '单张图片最大字节',
      mediaImageDedupe: '图片内容去重',
      mediaImageDedupeWindow: '去重窗口（毫秒）',
      mediaFiles: '接收文件',
      mediaFileAge: '文件上下文窗口（毫秒）',
      mediaMaxFileBytes: '单个文件最大字节',
      toolsWorkspace: '启用工作区工具',
      toolsAllowlist: '工具白名单覆盖',
      toolsAllowlistEnable: '覆盖预设工具策略',
      toolsAllowlistHint: '不覆盖时使用预设策略；开启后只有列表里的工具可用，列表为空表示全部禁用。',
      codexEnabled: '启用 Codex 子代理',
      codexTimeout: 'Codex 超时（毫秒）',
      advancedRequestTimeout: 'MCP 请求超时（毫秒）',
      advancedMaxChats: '并发会话数',
      advancedMaxSessions: '最大会话数',
      advancedMentionNames: '额外 @ 名称（每行一条）',
      advancedAllow: '只回复的联系人（每行一个 username）',
      advancedDeny: '不回复的联系人（每行一个 username）',
      mcpUrl: 'MCP 地址',
      mcpUrlHint: 'wechat-ai 的 Streamable HTTP MCP 地址，例如 http://127.0.0.1:8100/mcp。',
      tokenFile: '凭据文件',
      tokenFileHint: '包含 WECHAT_AI_MCP_TOKEN 的 dotenv 文件；留空则使用环境变量。',
      tokenEnv: 'Token 环境变量名',
      tokenEnvHint: '当凭据文件为空时读取该环境变量。',
      readWorkspacePath: '工作区根目录 / 共享路径',
      readStatePath: '状态文件',
      readLogPath: '日志文件',
      readSelfUsername: '自身 username',
      readCodexBinary: 'Codex 二进制',
      readCodexAuth: 'Codex 认证目录',
      valueNumber: '请输入数字',
      valueText: '请输入文本',
      unavailableHint: '请检查 DSH Web 服务与插件配置。',
    };

    const en = {
      nav: 'WeChat bridge',
      title: 'WeChat bridge settings',
      intro: 'Saving writes this profile plugin configuration and reloads the bridge; running WeChat turns are not interrupted.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The plugin is applying the new configuration.',
      reload: 'Reload',
      loadFailed: 'Could not load configuration',
      loading: 'Loading…',
      saveFailed: 'Save failed',
      unavailable: 'This deployment exposes no web settings endpoint.',
      advanced: 'Advanced',
      readOnly: 'Read only',
      groupBasic: 'Basics',
      groupPersona: 'Persona',
      groupModel: 'Model',
      groupTts: 'Text to speech (TTS)',
      groupReply: 'Replies',
      groupMedia: 'Images and files',
      groupTools: 'Tools and Codex',
      workspaceTitle: 'Workspace title',
      workspaceTitleHint: 'Title prefix; per-chat mode adds the contact or group name.',
      workspaceMode: 'Workspace mode',
      workspaceModeHint: 'Per-chat mode isolates contacts and groups; shared mode uses one directory. Switching starts fresh sessions where paths differ and preserves old data.',
      workspacePerChat: 'Per chat (default)',
      workspaceShared: 'Shared workspace',
      persona: 'Persona',
      personaHint: 'Optional. Prepended to every WeChat prompt to set identity, tone and address (max 1200 characters); leave empty for the default assistant persona.',
      agentPreset: 'Agent preset',
      agentPresetHint: 'For example wechat-work; applies to new sessions.',
      permissionPreset: 'Permission preset',
      permissionPresetHint: 'For example wechat-work.',
      pollIntervalMs: 'Poll interval (ms)',
      turnTimeoutMs: 'Turn timeout (ms)',
      execTimeoutMs: 'workspace_run timeout (ms)',
      modelProvider: 'Model provider',
      modelProviderHint: 'Set both provider and model to override the DSH default.',
      modelName: 'Model name',
      modelEffort: 'Reasoning effort',
      ttsEnabled: 'Enable TTS speech synthesis',
      ttsBaseUrl: 'TTS base URL',
      ttsBaseUrlHint: 'OpenAI-compatible endpoint such as http://10.0.0.14:8000/v1; requests go to base URL + /audio/speech.',
      ttsApiKey: 'TTS API key',
      ttsApiKeyHint: 'Never echoed; leave empty to keep the stored key. Use unused for an unauthenticated local service.',
      ttsModel: 'TTS model',
      ttsModelHint: 'For example breeze-tts-2.',
      ttsVoice: 'TTS voice',
      ttsVoiceHint: 'For example alloy, the local default female voice.',
      ttsInstructions: 'TTS instructions (optional)',
      ttsInstructionsHint: 'Optional instructions field for TTS services that support it, to control timbre, emotion or delivery; omitted when empty.',
      ttsTimeout: 'TTS timeout (ms)',
      ttsMaxChars: 'Maximum synthesized characters',
      ttsMaxCharsHint: 'Caps text length so generated audio stays below the WeChat 55-second limit.',
      replyPrivate: 'Reply to DMs',
      replyGroupMention: 'Reply to group mentions',
      replyGroupAll: 'Reply to every group message',
      replyAttachAt: 'Mention sender in group replies',
      replyHistory: 'Process history on the first poll',
      replyDebounce: 'Batching delay (ms)',
      replyMaxChars: 'Maximum reply characters',
      replyMaxPrompt: 'Maximum prompt characters',
      replyRate: 'Maximum replies per minute',
      replyWorkingNoticeMs: 'Working notice delay (ms)',
      replyWorkingNoticeTexts: 'Working notice texts (one per line, chosen randomly)',
      mediaImages: 'Receive images',
      mediaMaxImages: 'Images per message',
      mediaImageAge: 'Image context window (ms)',
      mediaMaxImageBytes: 'Maximum image bytes',
      mediaImageDedupe: 'Deduplicate image content',
      mediaImageDedupeWindow: 'Deduplication window (ms)',
      mediaFiles: 'Receive files',
      mediaFileAge: 'File context window (ms)',
      mediaMaxFileBytes: 'Maximum file bytes',
      toolsWorkspace: 'Enable workspace tools',
      toolsAllowlist: 'Tool allowlist override',
      toolsAllowlistEnable: 'Override the preset tool policy',
      toolsAllowlistHint: 'When off the preset policy applies; when on only listed tools run, and an empty list disables all tools.',
      codexEnabled: 'Enable the Codex subagent',
      codexTimeout: 'Codex timeout (ms)',
      advancedRequestTimeout: 'MCP request timeout (ms)',
      advancedMaxChats: 'Concurrent chats',
      advancedMaxSessions: 'Maximum sessions',
      advancedMentionNames: 'Additional mention names (one per line)',
      advancedAllow: 'Allowed contacts (one username per line)',
      advancedDeny: 'Denied contacts (one username per line)',
      mcpUrl: 'MCP URL',
      mcpUrlHint: 'The wechat-ai Streamable HTTP MCP endpoint, for example http://127.0.0.1:8100/mcp.',
      tokenFile: 'Credential file',
      tokenFileHint: 'Dotenv file containing WECHAT_AI_MCP_TOKEN; leave empty to use an environment variable.',
      tokenEnv: 'Token environment variable',
      tokenEnvHint: 'Read this environment variable when the credential file is empty.',
      readWorkspacePath: 'Workspace root / shared path',
      readStatePath: 'State file',
      readLogPath: 'Log file',
      readSelfUsername: 'Self username',
      readCodexBinary: 'Codex binary',
      readCodexAuth: 'Codex auth directory',
      valueNumber: 'Enter a number',
      valueText: 'Enter text',
      unavailableHint: 'Check the DSH web service and this plugin.',
    };

    const GROUPS = [
      {
        id: 'basic',
        title: 'groupBasic',
        fields: [
          { path: 'workspaceMode', kind: 'select', label: 'workspaceMode', hint: 'workspaceModeHint',
            options: [{ value: 'per-chat', label: 'workspacePerChat' }, { value: 'shared', label: 'workspaceShared' }] },
          { path: 'workspaceTitle', kind: 'text', label: 'workspaceTitle', hint: 'workspaceTitleHint' },
          { path: 'agentPreset', kind: 'text', label: 'agentPreset', hint: 'agentPresetHint' },
          { path: 'permissionPreset', kind: 'text', label: 'permissionPreset', hint: 'permissionPresetHint' },
          { path: 'pollIntervalMs', kind: 'number', label: 'pollIntervalMs' },
          { path: 'turnTimeoutMs', kind: 'number', label: 'turnTimeoutMs' },
          { path: 'execTimeoutMs', kind: 'number', label: 'execTimeoutMs' },
        ],
      },
      {
        id: 'persona',
        title: 'groupPersona',
        fields: [
          { path: 'persona', kind: 'textarea', label: 'persona', hint: 'personaHint' },
        ],
      },
      {
        id: 'model',
        title: 'groupModel',
        fields: [
          { path: 'model.provider', kind: 'text', label: 'modelProvider', hint: 'modelProviderHint' },
          { path: 'model.model', kind: 'text', label: 'modelName' },
          { path: 'model.reasoningEffort', kind: 'text', label: 'modelEffort' },
        ],
      },
      {
        id: 'tts',
        title: 'groupTts',
        fields: [
          { path: 'tts.enabled', kind: 'boolean', label: 'ttsEnabled' },
          { path: 'tts.baseUrl', kind: 'text', label: 'ttsBaseUrl', hint: 'ttsBaseUrlHint' },
          { path: 'tts.apiKey', kind: 'text', label: 'ttsApiKey', hint: 'ttsApiKeyHint' },
          { path: 'tts.model', kind: 'text', label: 'ttsModel', hint: 'ttsModelHint' },
          { path: 'tts.voice', kind: 'text', label: 'ttsVoice', hint: 'ttsVoiceHint' },
          { path: 'tts.instructions', kind: 'textarea', label: 'ttsInstructions', hint: 'ttsInstructionsHint' },
          { path: 'tts.timeoutMs', kind: 'number', label: 'ttsTimeout' },
          { path: 'tts.maxChars', kind: 'number', label: 'ttsMaxChars', hint: 'ttsMaxCharsHint' },
        ],
      },
      {
        id: 'reply',
        title: 'groupReply',
        fields: [
          { path: 'reply.private', kind: 'boolean', label: 'replyPrivate' },
          { path: 'reply.groupMention', kind: 'boolean', label: 'replyGroupMention' },
          { path: 'reply.groupAll', kind: 'boolean', label: 'replyGroupAll' },
          { path: 'reply.attachAtInGroup', kind: 'boolean', label: 'replyAttachAt' },
          { path: 'reply.history', kind: 'boolean', label: 'replyHistory' },
          { path: 'reply.debounceMs', kind: 'number', label: 'replyDebounce' },
          { path: 'reply.maxReplyChars', kind: 'number', label: 'replyMaxChars' },
          { path: 'reply.maxPromptChars', kind: 'number', label: 'replyMaxPrompt' },
          { path: 'reply.maxRepliesPerMinute', kind: 'number', label: 'replyRate' },
          { path: 'reply.workingNoticeMs', kind: 'number', label: 'replyWorkingNoticeMs' },
          { path: 'reply.workingNoticeTexts', kind: 'array', label: 'replyWorkingNoticeTexts' },
        ],
      },
      {
        id: 'media',
        title: 'groupMedia',
        fields: [
          { path: 'reply.images', kind: 'boolean', label: 'mediaImages' },
          { path: 'reply.maxImagesPerMessage', kind: 'number', label: 'mediaMaxImages' },
          { path: 'reply.imageContextAgeMs', kind: 'number', label: 'mediaImageAge' },
          { path: 'reply.maxImageBytes', kind: 'number', label: 'mediaMaxImageBytes' },
          { path: 'reply.imageDedupe', kind: 'boolean', label: 'mediaImageDedupe' },
          { path: 'reply.imageDedupeWindowMs', kind: 'number', label: 'mediaImageDedupeWindow' },
          { path: 'reply.files', kind: 'boolean', label: 'mediaFiles' },
          { path: 'reply.fileContextAgeMs', kind: 'number', label: 'mediaFileAge' },
          { path: 'reply.maxFileBytes', kind: 'number', label: 'mediaMaxFileBytes' },
        ],
      },
      {
        id: 'tools',
        title: 'groupTools',
        fields: [
          { path: 'workspaceTools', kind: 'boolean', label: 'toolsWorkspace' },
          { path: 'toolAllowlist', kind: 'allowlist', label: 'toolsAllowlist', hint: 'toolsAllowlistHint' },
          { path: 'codex.enabled', kind: 'boolean', label: 'codexEnabled' },
          { path: 'codex.timeoutMs', kind: 'number', label: 'codexTimeout' },
        ],
      },
      {
        id: 'advanced',
        title: 'advanced',
        collapsed: true,
        fields: [
          { path: 'requestTimeoutMs', kind: 'number', label: 'advancedRequestTimeout' },
          { path: 'maxConcurrentChats', kind: 'number', label: 'advancedMaxChats' },
          { path: 'maxSessions', kind: 'number', label: 'advancedMaxSessions' },
          { path: 'mentionNames', kind: 'array', label: 'advancedMentionNames' },
          { path: 'reply.allowContacts', kind: 'array', label: 'advancedAllow' },
          { path: 'reply.denyContacts', kind: 'array', label: 'advancedDeny' },
          { path: 'mcpUrl', kind: 'text', label: 'mcpUrl', hint: 'mcpUrlHint' },
          { path: 'tokenFile', kind: 'text', label: 'tokenFile', hint: 'tokenFileHint' },
          { path: 'tokenEnv', kind: 'text', label: 'tokenEnv', hint: 'tokenEnvHint' },
          { path: 'readOnly.workspacePath', kind: 'readonly', label: 'readWorkspacePath' },
          { path: 'readOnly.statePath', kind: 'readonly', label: 'readStatePath' },
          { path: 'readOnly.logPath', kind: 'readonly', label: 'readLogPath' },
          { path: 'readOnly.selfUsername', kind: 'readonly', label: 'readSelfUsername' },
          { path: 'readOnly.codexBinary', kind: 'readonly', label: 'readCodexBinary' },
          { path: 'readOnly.codexAuthSource', kind: 'readonly', label: 'readCodexAuth' },
        ],
      },
    ];

    const CSS = `
      .wb-page{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
      .wb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .wb-head h2{margin:0;font-size:18px;font-weight:600}
      .wb-head p{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);max-width:62ch}
      .wb-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px 14px}
      .wb-group-title{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .wb-field{display:flex;flex-direction:column;gap:5px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1)}
      .wb-field:first-of-type{border-top:0;padding-top:0}
      .wb-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
      .wb-hint{margin:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
      .wb-input,.wb-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 9px;outline:none}
      .wb-input:focus,.wb-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
      .wb-input:disabled,.wb-textarea:disabled{opacity:.65;cursor:not-allowed}
      .wb-textarea{min-height:64px;resize:vertical;line-height:1.45;font-family:inherit}
      .wb-switch{display:inline-flex;align-items:center;gap:8px;width:max-content;cursor:pointer;border:0;background:none;padding:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
      .wb-switch-track{width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;transition:background .15s}
      .wb-switch-track[data-on="true"]{background:var(--dsw-alias-brand-primary)}
      .wb-switch-dot{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s}
      .wb-switch-track[data-on="true"] .wb-switch-dot{left:17px}
      .wb-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px}
      .wb-button{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 12px;cursor:pointer}
      .wb-button:hover{border-color:var(--dsw-alias-border-l2)}
      .wb-button[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .wb-button:disabled{opacity:.5;cursor:not-allowed}
      .wb-status{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
      .wb-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
      .wb-status[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
      .wb-readonly{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
    `;

    const getPath = (object, path) => path.split('.').reduce((value, key) => (
      value !== null && typeof value === 'object' ? value[key] : undefined
    ), object);

    const setPath = (object, path, value) => {
      const keys = path.split('.');
      const clone = JSON.parse(JSON.stringify(object ?? {}));
      let target = clone;
      for (const key of keys.slice(0, -1)) {
        if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
        target = target[key];
      }
      target[keys[keys.length - 1]] = value;
      return clone;
    };

    const splitLines = text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    function Switch({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button', className: 'wb-switch', role: 'switch', 'aria-checked': checked,
        disabled, onClick: () => { onChange(!checked) }, 'aria-label': label,
      }, h('span', { className: 'wb-switch-track', 'data-on': checked }, h('span', { className: 'wb-switch-dot' })));
    }

    function Field({ field, values, disabled, onEdit, t }) {
      const value = getPath(values, field.path);
      const label = t(field.label);
      const hint = field.hint ? t(field.hint) : '';
      const readOnly = field.kind === 'readonly';
      return h('div', { className: 'wb-field' }, [
        h('label', { className: 'wb-label', key: 'label' }, label),
        field.kind === 'boolean' && h(Switch, {
          key: 'control', checked: value === true, disabled, label,
          onChange: next => onEdit(field.path, next),
        }),
        field.kind === 'select' && h('select', {
          key: 'control', className: 'wb-input', value: value ?? '', disabled, 'aria-label': label,
          onChange: event => onEdit(field.path, event.target.value),
        }, field.options.map(option => h('option', { key: option.value, value: option.value }, t(option.label)))),
        (field.kind === 'text' || field.kind === 'number') && h('input', {
          key: 'control', className: 'wb-input',
          type: field.kind === 'number' ? 'number' : 'text',
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          onChange: event => {
            const next = field.kind === 'number'
              ? (event.target.value === '' ? '' : Number(event.target.value))
              : event.target.value;
            if (field.kind === 'number' && next !== '' && !Number.isFinite(next)) return;
            onEdit(field.path, next);
          },
        }),
        field.kind === 'textarea' && h('textarea', {
          key: 'control', className: 'wb-textarea',
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          onChange: event => onEdit(field.path, event.target.value),
        }),
        field.kind === 'array' && h('textarea', {
          key: 'control', className: 'wb-textarea',
          value: Array.isArray(value) ? value.join('\n') : '',
          disabled,
          onChange: event => onEdit(field.path, splitLines(event.target.value)),
        }),
        field.kind === 'allowlist' && h(AllowlistField, { value, disabled, onEdit: next => onEdit(field.path, next), label, t }),
        readOnly && h('div', { className: 'wb-readonly' }, String(value ?? '')),
        hint && h('p', { className: 'wb-hint', key: 'hint' }, hint),
      ]);
    }

    function AllowlistField({ value, disabled, onEdit, label, t }) {
      const enabled = Array.isArray(value);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } }, [
        h(Switch, {
          key: 'toggle', checked: enabled, disabled, label,
          onChange: next => onEdit(next ? [] : null),
        }),
        h('span', { key: 'toggle-label', className: 'wb-hint' }, t('toolsAllowlistEnable')),
        enabled && h('textarea', {
          key: 'list', className: 'wb-textarea', disabled,
          value: value.join('\n'),
          onChange: event => onEdit(splitLines(event.target.value)),
        }),
      ]);
    }

    function Group({ group, values, disabled, onEdit, t }) {
      const content = group.fields.map(field => h(Field, {
        key: field.path, field, values, disabled, onEdit, t,
      }));
      if (group.collapsed) {
        return h('details', { key: group.id, className: 'wb-group' }, [
          h('summary', { key: 'title', className: 'wb-group-title', style: { cursor: 'pointer' } }, t(group.title)),
          ...content,
        ]);
      }
      return h('section', { key: group.id, className: 'wb-group' }, [
        h('h3', { key: 'title', className: 'wb-group-title' }, t(group.title)),
        ...content,
      ]);
    }

    function Page(props) {
      const { t } = props;
      const [values, setValues] = React.useState(null);
      const [status, setStatus] = React.useState({ kind: 'loading', text: '' });
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);

      const load = React.useCallback(async () => {
        setStatus({ kind: 'loading', text: '' });
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          setValues(payload.values);
          setDirty(false);
          setStatus({ kind: 'idle', text: '' });
        } catch (error) {
          setStatus({ kind: 'error', text: `${t('loadFailed')}: ${error.message}` });
        }
      }, [t]);

      React.useEffect(() => { void load(); }, [load]);

      const edit = (path, value) => {
        setValues(current => current === null ? current : setPath(current, path, value));
        setDirty(true);
        setStatus({ kind: 'idle', text: '' });
      };

      const save = async () => {
        if (values === null || saving) return;
        setSaving(true);
        setStatus({ kind: 'saving', text: t('saving') });
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ values: (() => { const { readOnly, ...editable } = values; return editable; })() }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setDirty(false);
          setStatus({ kind: 'ok', text: t('saved') });
          window.setTimeout(() => { void load(); }, 1800);
        } catch (error) {
          setStatus({ kind: 'error', text: `${t('saveFailed')}: ${error.message}` });
        } finally {
          setSaving(false);
        }
      };

      if (values === null) {
        return h('section', { className: 'wb-page' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { className: 'wb-head', key: 'head' }, h('h2', null, t('title'))),
          h('p', { className: 'wb-status', 'data-kind': status.kind === 'error' ? 'error' : undefined, key: 'status' },
            status.kind === 'error' ? status.text : t('loading')),
        ]);
      }

      return h('section', { className: 'wb-page' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'wb-head', key: 'head' }, [
          h('div', { key: 'copy' }, [
            h('h2', { key: 'title' }, t('title')),
            h('p', { key: 'intro' }, t('intro')),
          ]),
          h('button', {
            key: 'reload', type: 'button', className: 'wb-button', disabled: saving || dirty,
            onClick: () => { void load() },
          }, t('reload')),
        ]),
        ...GROUPS.map(group => h(Group, {
          key: group.id, group, values, disabled: saving, onEdit: edit, t,
        })),
        h('div', { className: 'wb-footer', key: 'footer' }, [
          h('button', {
            key: 'save', type: 'button', className: 'wb-button', 'data-primary': true,
            disabled: !dirty || saving, onClick: () => { void save() },
          }, saving ? t('saving') : t('save')),
          h('span', {
            key: 'status', className: 'wb-status', 'data-kind': status.kind === 'ok' ? 'ok' : status.kind === 'error' ? 'error' : undefined,
          }, status.text),
        ]),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'wechat-ai-bridge-settings: locale');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'wechat-ai-bridge',
          order: 80,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, Page));
      },
    };
  },
});
