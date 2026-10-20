# dsh-wechat-ai-bridge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that bridges WeChat to persistent DSH agent sessions through the [wechat-ai](https://github.com/ChisBread/wechat-ai) MCP server.

The plugin polls WeChat through wechat-ai's MCP tools, creates one DSH session per WeChat conversation, sends incoming text/images/files to the agent, and sends the agent's final reply back to WeChat. It also ships a Web settings page and optional agent tools for reading WeChat context.

## Features

- Private-chat auto replies and group replies only when the bot is mentioned.
- Per-conversation DSH sessions shown in the Web UI sidebar.
- Text, decoded images, quoted messages, and files are forwarded to the agent.
- Workspace-confined tools: the agent can read/write files and run shell commands only inside its dedicated workspace (bubblewrap jail; no host paths).
- Optional Codex CLI subagent executed inside the same workspace jail.
- Web settings page at **Settings → WeChat bridge** (grouped config form, no token exposure).
- No build step and no npm dependencies: plain ESM using Node.js built-ins and the DSH host API.

## Requirements

- DSH with the `web` profile (this bundle was developed against the current DSH 0.2.x web profile).
- A running [wechat-ai](https://github.com/ChisBread/wechat-ai) instance exposing the Streamable HTTP MCP endpoint (default `http://127.0.0.1:8100/mcp`).
- A DSH model route. Image forwarding additionally requires an image-capable route (`deepseek-flash` is `text+image`).
- For sending: `WECHAT_AI_MCP_WRITE_ENABLED=true` on the wechat-ai side.
- Optional: a standalone Codex CLI installation (`codex` + `codex-code-mode-host`) if you enable the `codex` subagent.

## Install

Install the bundle into a DSH profile with the harness plugin manager:

```text
plugin_manager → install_bundle → <this repository directory>
```

The bundle patch inserts two agent presets (`preset-wechat`, `preset-wechat-work`) and one plugin row (`wechat-ai-bridge`). It does **not** override DSH's `permission` row; the bridge uses the built-in `workspace-write` permission preset and enforces the real filesystem boundary in its own tools.

The package is a linked directory, so editing its files requires reloading DSH (or reinstalling the bundle) to load new Host/Client modules.

## Configure

All options live in the plugin row's `config` (in the profile patch or, for local development, `cordis.patch.yml`).

### MCP token

The plugin never hardcodes a token. Configure one of:

- `tokenFile`: path to a dotenv file containing `WECHAT_AI_MCP_TOKEN=...` (for example, the `wechat-ai` project's `.env`);
- `tokenEnv`: name of an environment variable (default `WECHAT_AI_MCP_TOKEN`);
- `token`: literal token (not recommended for shared repositories).

### Minimal config

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

`workspacePath` is optional; by default the plugin creates `~/.dsh/wechat-ai-bridge-workspace`. The workspace is used by the agent's file tools and the optional Codex subagent.

### Settings page

After installation, open **Settings → WeChat bridge** in the DSH Web UI. The page edits the core configuration in grouped sections:

- basics, model override, automatic replies, images/files, workspace tools and Codex;
- read-only connection details (MCP URL, credential file, workspace/state/log paths);
- a tool-allowlist switch where “off” keeps the preset policy (`null`) and “on” with an empty list disables every tool (`[]`).

Saving writes through DSH's `configEditor` to the profile patch and reloads the plugin. The browser never receives the MCP token.

## Behavior

- **Private chats**: every new text message (and private image/file message) triggers a reply.
- **Groups**: only messages that mention the bot trigger replies; group images/files become context for the next mention. A group reply mentions the sender when `reply.attachAtInGroup` is enabled.
- **Quoted messages**: quote/reply message text is read through `get_recent_messages(parse_media=true)`; quoted images are forwarded as image attachments when wechat-ai resolves them.
- **Images**: message attachments are forwarded whenever the model route supports image input; `reply.images=false` disables that.
- **Files**: inbound files are copied from the wechat-ai host config mount into `incoming/` inside the workspace, then the agent is told the workspace path.
- **Loop protection**: self messages are ignored, with a rate limit and a self-tail guard.
- **Pause**: `wechat_ai_bridge_control({ paused: true })` stops automatic replies while advancing the watermark; resuming does not replay skipped messages.

## Agent tools

Depending on the allowlist and preset, the bridge exposes:

| Tool | Purpose |
| --- | --- |
| `workspace_list/read/write/edit/search/run` | Workspace-confined files and shell |
| `workspace_codex` | Optional Codex CLI subagent inside the workspace jail |
| `web_search/web_fetch` | Web access |
| `todo_write` | Todo list |
| `wechat_list_chats` / `wechat_recent_messages` / `wechat_search_contacts` | Read WeChat context |
| `wechat_send_image` | Send a workspace image to WeChat |
| `wechat_ai_bridge_status` / `wechat_ai_bridge_control` | Bridge health and pause/resume |

The bridge's final text reply is sent automatically; `wechat_send_message` is deliberately hidden by the tool guard.

## Configuration reference

Selected options (see `lib/util.js` for defaults and ranges):

| Key | Default | Meaning |
| --- | --- | --- |
| `mcpUrl` | `http://127.0.0.1:8100/mcp` | wechat-ai MCP endpoint |
| `tokenEnv` / `tokenFile` | `WECHAT_AI_MCP_TOKEN` / empty | Token source |
| `pollIntervalMs` | 2500 | WeChat poll interval |
| `workspacePath` | `~/.dsh/wechat-ai-bridge-workspace` | Agent workspace |
| `agentPreset` / `permissionPreset` | `wechat-work` / `workspace-write` | Session composition |
| `toolAllowlist` | `null` | `null` keeps preset policy; `[]` denies all |
| `reply.private` / `groupMention` | true / true | Reply triggers |
| `reply.maxReplyChars` | 2000 | Reply length cap |
| `reply.images` / `files` | true / true | Forward media |
| `reply.maxImageBytes` / `maxFileBytes` | 8 MB / 20 MB | Media limits |
| `codex.enabled` | false | Stage Codex CLI into the jail |
| `codex.timeoutMs` | 600000 | Codex timeout |

## Security

- The agent's filesystem access is confined to its workspace: the plugin replaces host file/shell tools with workspace-scoped tools and a bubblewrap jail. Host directories such as `/home`, `/root`, `/var`, and `/opt` are not mounted inside the jail.
- The MCP token and all credentials stay on the Host; the settings route does not return them and rejects unauthenticated requests.
- Group members can mention the bot and drive its workspace-confined agent. Use `reply.allowContacts` / `denyContacts` or chat mode to restrict who can trigger it.
- Enabling `codex` copies Codex authentication into the workspace so Codex can run; any code inside that workspace can read that credential. Use a dedicated Codex account if this matters.
- `workspace_run` uses the host's `bwrap`; install bubblewrap before enabling work mode.

## Development

- Source layout: `index.js` (Host entry), `client.js` (settings page), `lib/` (MCP client, bridge, workspace tools, settings route), `cordis.patch.yml` (bundle patch), `locale/`, `icon.svg`.
- Syntax check: `node --check index.js client.js lib/*.js`.
- No build step, no dependencies. DSH host/client services are accessed through Cordis contexts.

## License

MIT
