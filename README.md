# dsh-wechat-ai-bridge

DeepSeek Harness（DSH）的微信桥接插件：通过 [wechat-ai](https://github.com/ChisBread/wechat-ai) 的 MCP 服务，把微信私聊/群聊 @ 消息交给持久化的 DSH Agent 会话，并把 Agent 的最终回复发回微信。同时提供 Web 设置页和微信上下文读取工具。

## 功能

- 私聊自动回复；群聊只在被 @ 时回复，并 @ 回发送者。
- 每个微信会话对应一个 DSH Session，可在 Web UI 侧边栏查看。
- 默认按联系人和群隔离工作区，首次需要 Agent 时才创建；也可切换为共享工作区。
- 接收文本、图片、引用消息和文件；引用图片会作为附件转发。
- Agent 可以把工作区里的音频文件作为微信原生语音条发送；仅在发送人明确要求或回复确实更适合语音时使用。
- Agent 的文件/命令工具限定在专用工作区（bubblewrap，不挂载宿主机目录）。
- 可选 Codex CLI 子代理，运行在同一个工作区 jail 内。
- Web UI「设置 → 微信桥接」配置页，支持分组表单和保存。

## 发送者昵称

从 0.2.1 起，交给 Agent 的每条消息都明确标注「发送者微信昵称」（全局昵称），下一行单独标注「发送者ID」（username，为空时显示「未知」）；群消息另外标注「发送者群昵称」。私聊中，联系人备注存在且与显示的全局昵称不同时，会单独标注「发送者备注」。

消息中的 `sender_display` 在群聊中是群昵称，私聊中也可能是好友备注，不能当作全局微信昵称。全局昵称只取联系人或群成员元数据的 `nick_name`：每次群成员刷新通过一次 `query_room_member_list` 批量填充缓存，缺失或过期时通过 `search_contacts` 按 username 精确匹配联系人。发送者资料缓存仅驻留内存，有效期 30 分钟，最多 1000 条，不新增联系人资料的磁盘存储。

非好友群成员等情况可能缺少全局昵称元数据，此时显示「未知」，不会用群昵称或备注冒充；查询失败不会中断回复。群内回复的 @ 仍使用消息中的 `sender_display`。

## 环境要求

- DSH Web profile（插件基于 DSH 0.2.x 开发）。
- 运行中的 wechat-ai，提供 Streamable HTTP MCP（默认 `http://127.0.0.1:8100/mcp`）。
- 可用的 DSH 模型；图片转发需要模型支持 image 输入。
- 发送消息需要 wechat-ai 侧 `WECHAT_AI_MCP_WRITE_ENABLED=true`。
- 可选：Codex CLI（`codex` 与 `codex-code-mode-host`）。

## 安装

```bash
git clone https://github.com/Windfarer/dsh-wechat-ai-bridge.git
```

使用 DSH plugin_manager 的 `install_bundle` 安装本目录。插件会插入 `preset-wechat`、`preset-wechat-work` 和 `wechat-ai-bridge` 行，不覆盖 DSH 的 `permission` 行，权限使用内置 `workspace-write`。

安装后需要配置 MCP token：

- `tokenFile`：包含 `WECHAT_AI_MCP_TOKEN=...` 的 dotenv 文件；
- 或环境变量 `WECHAT_AI_MCP_TOKEN`；
- 不建议在仓库中写死 `token`。

```yaml
- id: wechat-ai-bridge
  name: 'dsh-wechat-ai-bridge'
  config:
    mcpUrl: http://127.0.0.1:8100/mcp
    tokenFile: /path/to/wechat-ai/.env
    workspaceMode: per-chat
    workspaceTitle: 微信桥接
    agentPreset: wechat-work
    permissionPreset: workspace-write
```

`workspacePath` 可选，默认 `~/.dsh/wechat-ai-bridge-workspace`。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `workspaceMode` | `per-chat` | `per-chat` 为每个私聊联系人、每个群建立独立工作区；`shared` 保留单一工作区行为。 |
| `workspacePath` | `~/.dsh/wechat-ai-bridge-workspace` | 逐聊天模式的根目录，或共享模式的工作区本身；在部署配置中修改。 |
| `workspaceTitle` | `微信桥接` | 标题前缀；逐聊天模式附加“微信 / 微信群”和显示名，共享模式直接使用此标题。 |

## 工作区与会话迁移

逐聊天模式使用 `<workspacePath>/<安全用户名>-<8位摘要>/`，目录键来自稳定的联系人或群 username，显示名变化不会改变目录。用户名经过字符过滤、去除前导点和连续点、长度限制，再附加原始 username 的 SHA-256 前 8 位摘要。群内成员共用该群的工作区，不会按群成员分别建立目录。

首次需要 Agent 时才建立目录并创建或复用 DSH 工作区，收到的文件保存在该聊天的 `incoming/`，启用 Codex 后认证与配置保存在该聊天的 `.codex/`。启动时不会为所有已知聊天预建目录。

升级到 0.2.0 后，未指定模式的配置默认使用 `per-chat`。启动时检查已保存会话的工作目录；切换模式或根目录后，只清除不匹配的会话关联，下次触发创建新会话。旧会话历史和旧工作区文件不会自动移动或删除。原来的通用默认路径保留为逐聊天模式的根目录；建议在部署配置中指定一个新的根目录，使旧共享数据与新目录更清晰地分开。需要原有行为时显式配置 `workspaceMode: shared`，并保留原 `workspacePath`。

## 语音发送

从 0.3.0 起，工作模式提供 `wechat_send_voice(recipient_name, file_path)`：它从当前聊天的工作区读取音频文件，以 base64 交给 wechat-ai 的 `send_voice_msg`，最终由微信麦克风 RPA 发送原生语音条。音频支持 WAV/MP3/M4A/OGG/FLAC 等（wechat-ai 用 FFmpeg 解码），时长 1–55 秒、最大 10 MiB；播放按真实时长等待，默认等待 60 秒。

是否使用语音由 Agent 按系统提示判断：只有发送人明确要求“发语音/用语音回复”，或这条回复确实更适合语音时才调用；其他情况继续走普通文字回复。语音动作被接受后（包括已排队或等待超时、仍由 RPA 继续播放的情况）桥接会跳过本轮的文字自动回复，避免语音和文字重复；明确失败或被拒绝时仍回退到正常文字路径。当前插件不内置 TTS，需要先把音频文件放进工作区（例如用 `workspace_run` 调用 `espeak-ng` 等本机 TTS 生成 WAV）再发送。

## 设置页

安装后打开 **设置 → 微信桥接**，在基础设置中选择工作区模式。也可编辑 MCP 地址、token 文件、token 环境变量，以及模型、自动回复、图片/文件、工具与 Codex 配置；工作区根目录/状态/日志路径只读展示，token 本身不会返回浏览器。保存会通过 `configEditor` 写回 profile patch 并重载插件。

## 安全与注意事项

- 群成员 @ 机器人即可驱动工作区内的 Agent；可用 `reply.allowContacts` / `denyContacts` 限制触发者。
- 逐聊天模式下，文件工具、命令沙箱、图片发送和语音发送均限定在当前聊天的工作区。`wechat_send_image` / `wechat_send_voice` 依据当前 Agent 的会话关联确定根目录；没有活跃桥接聊天上下文的调用会被拒绝，不会回退到包含所有聊天的根目录。共享模式保留从共享工作区发送图片和语音的行为。
- 从 0.2.2 起，桥接 Agent 的微信工具严格绑定到当前私聊或群聊：`wechat_recent_messages`、`wechat_send_image` 和 `wechat_send_voice` 只接受当前会话的 username 或显示名，实际 API 调用统一使用绑定的 username，不能跨会话读取消息、发送图片或语音。范围由调用方 Agent 的身份与活跃会话关联确定，拒绝错误不包含 token 或其他聊天资料。
- 桥接 Agent 禁止调用 `wechat_list_chats` 和 `wechat_search_contacts`。聊天模式只保留当前会话消息读取工具；工作模式的白名单保留当前会话消息读取、图片/语音发送和原有非微信工具，移除会话枚举、联系人搜索及全局桥接状态/控制工具。没有活跃桥接会话范围的普通 DSH 调用保留原有行为，图片/语音发送仍遵守上述工作区限制。
- 自定义 Agent 预设应继续避免启用宿主机全局文件、终端等工具；微信会话范围校验不会放宽文件与命令的工作区隔离。
- 启用 Codex 会在聊天首次使用工作区时复制认证，每次运行前刷新各自的认证副本；工作区内代码可读取该凭据，建议使用单独账号。文件隔离不等于 Codex 账号隔离。
- 插件不硬编码任何账号、wxid 或 token；自己的 wxid 从 wechat-ai 的 `database.data_dir` 动态解析。

## 新加入群聊与轮询排错

从 0.2.3 起，单个聊天的消息或资料查询失败只记录限流日志，并继续处理其他聊天；本轮完成后 `runtime.ready` 保持正常，`lastPollError` 清空。token、运行状态和最近聊天列表等整轮查询失败仍按原有方式报告不可用。

新加入的群可能已出现在 `get_recent_chats`，但尚未进入联系人/消息数据库。当 `get_recent_messages` 返回 `missing messages`、`not_found` 或 `未找到`，且最近聊天中的 `last_message` 有有效时间戳和非空文本时，桥接会使用这一条消息继续正常的 @ 检测、排队及工作区/会话创建。回退诊断日志不包含消息内容，处理后推进时间游标，同一条消息不会重复触发；网络、超时、认证及其他错误不会使用此回退。回退只能补上最近一条消息，不能补齐该群的历史。

群成员资料缺失不会阻止处理；此时 @ 检测仍使用已解析的自身昵称和配置的 `mentionNames`。如果群内昵称不同于这些名称，请配置对应的 `mentionNames`。首次启动跳过历史、暂停、允许/拒绝名单等规则保持不变。

## 开发

纯 ESM，无构建、无 npm 依赖。语法检查：

```bash
for file in index.js client.js lib/*.js test/*.js; do node --check "$file" || exit; done
node --test
```

代码结构：`index.js`（Host 入口）、`client.js`（设置页）、`lib/`（MCP 客户端、桥接、工作区工具、设置路由）、`cordis.patch.yml`（bundle patch）。

## License

MIT
