# dsh-wechat-ai-bridge

[English](README.md)

DeepSeek Harness（DSH）的微信桥接插件：通过 [wechat-ai](https://github.com/ChisBread/wechat-ai) 的 MCP 服务，把微信私聊/群聊 @ 消息交给持久化的 DSH Agent 会话，并把 Agent 的最终回复发回微信。同时提供 Web 设置页和微信上下文读取工具。

## 功能

- 私聊自动回复；群聊只在被 @ 时回复，并 @ 回发送者。
- 每个微信会话对应一个 DSH Session，可在 Web UI 侧边栏查看。
- 接收文本、图片、引用消息和文件；引用图片会作为附件转发。
- Agent 的文件/命令工具限定在专用工作区（bubblewrap，不挂载宿主机目录）。
- 可选 Codex CLI 子代理，运行在同一个工作区 jail 内。
- Web UI「设置 → 微信桥接」配置页，支持分组表单和保存。

## 环境要求

- DSH Web profile（插件基于 DSH 0.2.x 开发）。
- 运行中的 wechat-ai，提供 Streamable HTTP MCP（默认 `http://127.0.0.1:8100/mcp`）。
- 可用的 DSH 模型；图片转发需要模型支持 image 输入。
- 发送消息需要 wechat-ai 侧 `WECHAT_AI_MCP_WRITE_ENABLED=true`。
- 可选：Codex CLI（`codex` 与 `codex-code-mode-host`）。

## 安装

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
    workspaceTitle: 微信桥接
    agentPreset: wechat-work
    permissionPreset: workspace-write
```

`workspacePath` 可选，默认 `~/.dsh/wechat-ai-bridge-workspace`。

## 设置页

安装后打开 **设置 → 微信桥接**，可编辑基础、模型、自动回复、图片/文件、工具与 Codex 配置；连接路径和 token 文件只读展示，token 不会返回浏览器。保存会通过 `configEditor` 写回 profile patch 并重载插件。

## 注意

- 群成员 @ 机器人即可驱动工作区内的 Agent；可用 `reply.allowContacts` / `denyContacts` 限制触发者。
- 启用 Codex 会把 Codex 认证复制到工作区，工作区内代码可读取该凭据；建议使用单独账号。
- 插件不硬编码任何账号、wxid 或 token；自己的 wxid 从 wechat-ai 的 `database.data_dir` 动态解析。

## 开发

纯 ESM，无构建、无 npm 依赖。语法检查：

```bash
node --check index.js client.js lib/*.js
```

代码结构：`index.js`（Host 入口）、`client.js`（设置页）、`lib/`（MCP 客户端、桥接、工作区工具、设置路由）、`cordis.patch.yml`（bundle patch）。

## License

MIT
