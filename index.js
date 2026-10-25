import { normalizeConfig, createLogger } from './lib/util.js';
import { McpClient } from './lib/mcp-client.js';
import { WechatApi } from './lib/wechat-api.js';
import { StateStore } from './lib/state.js';
import { Bridge } from './lib/bridge.js';
import { registerTools, WECHAT_AGENT_TOOLS } from './lib/tools.js';
import { registerSettingsRoute } from './lib/settings-api.js';

export const name = 'wechat-ai-bridge';
export const inject = [
  'agents', 'agentPresets', 'permissionPresets', 'sessionTitle',
  'workspaceRegistry', 'tools', 'agentDefaultModel', 'attachments', 'llm',
];

/** Host entry: synchronous registration, background I/O, lifecycle-owned teardown. */
export function apply(ctx, input = {}) {
  let logger;
  let bridge;
  const disposers = [];
  try {
    const config = normalizeConfig(input);
    logger = createLogger(ctx, config);
    const store = new StateStore(config.statePath, logger);
    const client = new McpClient({ url: config.mcpUrl, timeoutMs: config.requestTimeoutMs, logger });
    bridge = new Bridge(ctx, config, store, new WechatApi(client), logger);
    // Optional Web settings surface: the bridge itself must also load headless.
    ctx.inject(['webServer', 'connection', 'configEditor'], webCtx => {
      webCtx.effect(
        () => registerSettingsRoute(webCtx, bridge, config, logger),
        'wechat-ai-bridge: settings route',
      );
    });
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => bridge.onSessionEvent(session, event));
      if (typeof off === 'function') disposers.push(off);
      registerTools(ctx, bridge, bridge.api, disposers);
      bridge.checkToolAllowlist(WECHAT_AGENT_TOOLS);
      bridge.start();
      return async () => {
        // Remove entry points synchronously before draining asynchronous work.
        const stopping = bridge.stop();
        for (const dispose of disposers.splice(0).reverse()) {
          try { await dispose(); } catch (error) { logger.rate('resource-dispose', error); }
        }
        await stopping;
      };
    });
  } catch (error) {
    if (logger) logger.rate('apply', error);
    else { try { console.error('[wechat-ai-bridge] Plugin registration failed'); } catch { /* Host remains alive. */ } }
    for (const dispose of disposers.splice(0).reverse()) {
      try { Promise.resolve(dispose()).catch(failure => logger?.rate('resource-dispose', failure)); }
      catch (failure) { logger?.rate('resource-dispose', failure); }
    }
    if (bridge) bridge.stop().catch(failure => logger?.rate('cleanup', failure));
  }
}
