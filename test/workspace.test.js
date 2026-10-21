import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Bridge } from '../lib/bridge.js';
import { emptyState } from '../lib/state.js';
import { chatWorkspaceSegment, normalizeConfig } from '../lib/util.js';
import { registerTools } from '../lib/tools.js';
import { registerSettingsRoute } from '../lib/settings-api.js';

const contactA = { username: 'test-contact-a', display_name: '测试联系人' };
const contactB = { username: 'test-group@chatroom', display_name: '测试群' };
const logger = { info() {}, warn() {}, rate() {}, clean: value => value, lastErrors: [] };

function fixture(t, options = {}) {
  // All fixtures live in this clone, never in a profile or system temp directory.
  const temp = fs.mkdtempSync(fileURLToPath(new URL('./.workspace-', import.meta.url)));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = normalizeConfig({
    workspacePath: path.join(temp, 'root'), statePath: path.join(temp, 'state.json'),
    logPath: path.join(temp, 'log'), model: { provider: 'test', model: 'test' },
    agentPreset: 'wechat-work', ...options,
  });
  const store = { data: emptyState(), save() {} };
  const registered = new Map();
  const live = new Map();
  const snapshots = new Map();
  const created = [];
  const ctx = {
    get: name => name === 'sessionPersistence' ? { stat: async id => snapshots.get(id) } : undefined,
    workspaceRegistry: {
      resolveByPath: async dir => registered.get(dir),
      async create(dir, title) {
        const entity = { dir, title, sessions: [], async attachSession(id) { this.sessions.push(id); } };
        registered.set(dir, entity);
        created.push(entity);
        return entity;
      },
    },
    agents: {
      get: id => live.get(id),
      currentInitiator: () => undefined,
      async create({ sessionId, meta, setup }) {
        const tools = new Map();
        let restriction;
        let guard;
        await setup({ tools: { register: tool => tools.set(tool.name, tool),
          restrict(value) { restriction = value; }, guard(value) { guard = value; } } });
        const handle = { agent: { id: sessionId, session: { id: sessionId, header: meta } }, tools, restriction, guard,
          async dispose() { live.delete(sessionId); } };
        live.set(sessionId, handle);
        return handle;
      },
      async resume({ resumeSessionId, ...options }) {
        const snapshot = snapshots.get(resumeSessionId);
        if (!snapshot) throw new Error('Missing session');
        return this.create({ ...options, sessionId: resumeSessionId, meta: snapshot.header });
      },
    },
    agentPresets: { async mount() {} },
    permissionPresets: { set() {} },
    sessionTitle: { rename() {} },
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] }; } },
  };
  const bridge = new Bridge(ctx, config, store, { client: {} }, logger);
  return { bridge, ctx, config, temp, store, registered, created, snapshots };
}

test('directory segments are safe, bounded, stable and distinguish sanitized collisions', () => {
  for (const username of ['../', '.', '..', '...', '/absolute/path', 'a\\b', 'a/../b', '中文', 'a'.repeat(200), 'a@chatroom']) {
    const segment = chatWorkspaceSegment(username);
    assert.match(segment, /^[A-Za-z0-9_@-][A-Za-z0-9._@-]*-[a-f0-9]{8}$/);
    assert.ok(!segment.includes('..'));
    assert.ok(segment.length <= 73);
    assert.equal(segment, chatWorkspaceSegment(username));
    assert.ok(segment.endsWith(createHash('sha256').update(username).digest('hex').slice(0, 8)));
  }
  assert.notEqual(chatWorkspaceSegment('a/b'), chatWorkspaceSegment('a\\b'));
  assert.notEqual(chatWorkspaceSegment('a'.repeat(100)), chatWorkspaceSegment('a'.repeat(101)));
  for (const bad of ['', ' ', null, undefined, 42]) assert.throws(() => chatWorkspaceSegment(bad), /username/);
});

test('workspace mode defaults safely and accepts only the two supported values', () => {
  assert.equal(normalizeConfig().workspaceMode, 'per-chat');
  for (const workspaceMode of [null, '', 'SHARED', 'other', 1, {}, []]) {
    assert.equal(normalizeConfig({ workspaceMode }).workspaceMode, 'per-chat');
  }
  for (const workspaceMode of ['shared', 'per-chat']) {
    assert.equal(normalizeConfig({ workspaceMode }).workspaceMode, workspaceMode);
  }
  assert.ok(normalizeConfig().workspacePath.endsWith(path.join('.dsh', 'wechat-ai-bridge-workspace')));
});

test('startup is lazy; concurrent creation and renamed contacts reuse one workspace', async t => {
  const { bridge, config, created } = fixture(t);
  await bridge.prepareWorkspace();
  assert.equal(fs.existsSync(config.workspacePath), false);
  const results = await Promise.all(Array.from({ length: 8 }, () => bridge.ensureWorkspace(contactA)));
  assert.equal(created.length, 1);
  assert.ok(results.every(result => result === results[0]));
  const renamed = await bridge.ensureWorkspace({ ...contactA, display_name: '改名' });
  assert.equal(renamed, results[0]);
  const group = await bridge.ensureWorkspace(contactB);
  assert.notEqual(group.dir, renamed.dir);
  assert.match(renamed.workspace.title, /微信 · 测试联系人/);
  assert.match(group.workspace.title, /微信群 · 测试群/);
  assert.equal(bridge.status().workspacePath, fs.realpathSync(config.workspacePath));
  assert.equal(bridge.status().workspaceMode, 'per-chat');
  assert.equal(bridge.status().workspaceCount, 2);
});

test('existing registry entities are reused and failed creation can be retried', async t => {
  const { bridge, ctx, registered, created, config } = fixture(t);
  const dir = path.join(config.workspacePath, chatWorkspaceSegment(contactA.username));
  fs.mkdirSync(dir, { recursive: true });
  const existing = { attachSession() {} };
  registered.set(fs.realpathSync(dir), existing);
  assert.equal((await bridge.ensureWorkspace(contactA)).workspace, existing);
  assert.equal(created.length, 0);
  const create = ctx.workspaceRegistry.create;
  ctx.workspaceRegistry.create = async () => { throw new Error('registry unavailable'); };
  await assert.rejects(bridge.ensureWorkspace(contactB), /unavailable/);
  ctx.workspaceRegistry.create = create;
  assert.ok((await bridge.ensureWorkspace(contactB)).workspace);
});

test('shared mode keeps one canonical root and the base title', async t => {
  const { bridge, config, created } = fixture(t, { workspaceMode: 'shared' });
  await bridge.prepareWorkspace();
  const [a, b] = await Promise.all([bridge.ensureWorkspace(contactA), bridge.ensureWorkspace(contactB)]);
  assert.equal(a, b);
  assert.equal(a.dir, fs.realpathSync(config.workspacePath));
  assert.equal(a.workspace.title, config.workspaceTitle);
  assert.equal(created.length, 1);
  assert.equal(await bridge.imageWorkspaceRoot(), a.dir);
});

test('canonical base aliases work, but chat directory aliases are rejected', async t => {
  const { bridge, config, temp } = fixture(t);
  const realRoot = path.join(temp, 'real');
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, config.workspacePath);
  const a = await bridge.ensureWorkspace(contactA);
  assert.equal(path.dirname(a.dir), realRoot);
  fs.symlinkSync(a.dir, path.join(realRoot, chatWorkspaceSegment(contactB.username)));
  await assert.rejects(bridge.ensureWorkspace(contactB), /symlink/);
});

test('rehome clears only incompatible mappings and leaves old files and sessions intact', async t => {
  const { bridge, store, snapshots, config, created } = fixture(t);
  const old = config.workspacePath;
  const matching = bridge.workspacePathForChat(contactB.username);
  fs.mkdirSync(matching, { recursive: true });
  fs.writeFileSync(path.join(old, 'old.txt'), 'old data');
  const a = bridge.chatState(contactA);
  const b = bridge.chatState(contactB);
  a.sessionId = 'old-session';
  b.sessionId = 'matching-session';
  snapshots.set(a.sessionId, { header: { cwd: old, agentPreset: config.agentPreset } });
  snapshots.set(b.sessionId, { header: { cwd: matching, agentPreset: config.agentPreset } });
  await bridge.rehomeStoredSessions();
  assert.equal(a.sessionId, '');
  assert.equal(b.sessionId, 'matching-session');
  assert.equal(snapshots.size, 2);
  assert.equal(fs.readFileSync(path.join(old, 'old.txt'), 'utf8'), 'old data');
  assert.equal(fs.existsSync(bridge.workspacePathForChat(contactA.username)), false);
  assert.equal(created.length, 0);
  assert.equal(store.data.chats[contactA.username], a);
});

test('agents create and resume in their chat workspace with scoped file tools', async t => {
  const { bridge, snapshots } = fixture(t);
  const a = await bridge.ensureAgent(contactA);
  const b = await bridge.ensureAgent(contactB);
  assert.notEqual(a.workspaceDir, b.workspaceDir);
  assert.equal(a.handle.agent.session.header.cwd, a.workspaceDir);
  const aWorkspace = await bridge.ensureWorkspace(contactA);
  assert.deepEqual(aWorkspace.workspace.sessions, [a.sessionId]);
  fs.writeFileSync(path.join(b.workspaceDir, 'private.txt'), 'group file');
  await assert.rejects(a.handle.tools.get('workspace_read').execute({ path: path.join(b.workspaceDir, 'private.txt') }), /escapes/);
  snapshots.set(a.sessionId, { header: a.handle.agent.session.header });
  await bridge.disposeEntry(contactA.username, a);
  const resumed = await bridge.ensureAgent(contactA);
  assert.equal(resumed.sessionId, a.sessionId);
  assert.equal(resumed.workspaceDir, a.workspaceDir);
});

test('a resumed session in the wrong workspace is replaced without removing its history', async t => {
  const { bridge, snapshots, config } = fixture(t);
  fs.mkdirSync(config.workspacePath);
  bridge.chatState(contactA).sessionId = 'old-session';
  snapshots.set('old-session', { header: { cwd: config.workspacePath } });
  const entry = await bridge.ensureAgent(contactA);
  assert.notEqual(entry.sessionId, 'old-session');
  assert.equal(entry.handle.agent.session.header.cwd, bridge.workspacePathForChat(contactA.username));
  assert.ok(snapshots.has('old-session'));
});

test('global image send rejects missing context, other chats, traversal and symlink escapes', async t => {
  const { bridge, ctx } = fixture(t);
  const a = await bridge.ensureAgent(contactA);
  const b = await bridge.ensureAgent(contactB);
  fs.writeFileSync(path.join(a.workspaceDir, 'image.png'), 'own image fixture');
  fs.writeFileSync(path.join(b.workspaceDir, 'image.png'), 'other image fixture');
  const tools = new Map();
  const sent = [];
  ctx.tools = { register: tool => tools.set(tool.name, tool) };
  registerTools(ctx, bridge, { async sendImage(args) { sent.push(args); return { status: 'sent' }; } });
  const send = file_path => tools.get('wechat_send_image').execute({ recipient_name: '测试联系人', file_path });
  await assert.rejects(send('image.png'), /active WeChat bridge chat/);
  ctx.agents.currentInitiator = () => ({ id: 'unrelated-session' });
  await assert.rejects(send('image.png'), /active WeChat bridge chat/);
  ctx.agents.currentInitiator = () => ({ id: a.sessionId });
  await send('/workspace/image.png');
  assert.equal(Buffer.from(sent[0].image_base64, 'base64').toString(), 'own image fixture');
  await assert.rejects(send(path.join(b.workspaceDir, 'image.png')), /escapes/);
  await assert.rejects(send(`../${path.basename(b.workspaceDir)}/image.png`), /escapes/);
  fs.symlinkSync(path.join(b.workspaceDir, 'image.png'), path.join(a.workspaceDir, 'alias.png'));
  await assert.rejects(send('alias.png'), /symlink/);
  assert.equal(sent.length, 1);
});

test('chat scope uses the live Agent id, with existing identity fallbacks and display name fallback', async t => {
  const { bridge, ctx } = fixture(t);
  const a = await bridge.ensureAgent(contactA);
  const b = await bridge.ensureAgent(contactB);
  for (const initiator of [a.handle.agent, { id: a.sessionId, sessionId: b.sessionId },
    { sessionId: a.sessionId }, a.sessionId]) {
    ctx.agents.currentInitiator = async () => initiator;
    assert.deepEqual(await bridge.currentChatScope(), {
      username: contactA.username, displayName: contactA.display_name,
    });
  }
  bridge.state.chats[contactA.username].displayName = '';
  assert.equal((await bridge.currentChatScope()).displayName, contactA.username);
  delete bridge.state.chats[contactA.username];
  assert.equal((await bridge.currentChatScope()).displayName, contactA.username);
  for (const initiator of [undefined, { id: 'ordinary-session' }, { id: 'ordinary-session', sessionId: a.sessionId }]) {
    ctx.agents.currentInitiator = () => initiator;
    assert.equal(await bridge.currentChatScope(), undefined);
  }
  delete ctx.agents.currentInitiator;
  assert.equal(await bridge.currentChatScope(), undefined);
});

test('scoped WeChat tools pin private and group targets and reject cross-chat access without leaking data', async t => {
  for (const workspaceMode of ['per-chat', 'shared']) await t.test(workspaceMode, async t => {
    const { bridge, ctx } = fixture(t, { workspaceMode, token: 'fixture-secret-token' });
    const entries = [await bridge.ensureAgent(contactA), await bridge.ensureAgent(contactB)];
    const tools = new Map();
    const calls = [];
    ctx.tools = { register: tool => tools.set(tool.name, tool) };
    registerTools(ctx, bridge, {
      async recentMessages(name, limit) {
        calls.push(['read', name, limit]);
        return { messages: [{ text: 'own chat fixture' }] };
      },
      async sendImage(args) { calls.push(['send', args.recipient_name]); return { status: 'sent' }; },
      async recentChats() { assert.fail('scoped enumeration must not call the API'); },
      async searchContacts() { assert.fail('scoped search must not call the API'); },
    });
    for (const [index, contact] of [contactA, contactB].entries()) {
      const entry = entries[index];
      ctx.agents.currentInitiator = () => entry.handle.agent;
      fs.writeFileSync(path.join(entry.workspaceDir, 'image.png'), 'image fixture');
      for (const name of [contact.username, contact.display_name]) {
        const messages = await tools.get('wechat_recent_messages').execute({ contact_name: name, limit: 7 });
        assert.equal(messages[0].text, 'own chat fixture');
        assert.deepEqual(calls.at(-1), ['read', contact.username, 7]);
        const image = await tools.get('wechat_send_image').execute({ recipient_name: name, file_path: 'image.png' });
        assert.equal(image.recipient, contact.username);
        assert.deepEqual(calls.at(-1), ['send', contact.username]);
      }
      const other = [contactA, contactB][1 - index];
      const rejected = [
        ['wechat_list_chats', {}, 'wechat_list_chats is unavailable to a chat-bound WeChat bridge Agent'],
        ['wechat_search_contacts', { query: other.display_name }, 'wechat_search_contacts is unavailable to a chat-bound WeChat bridge Agent'],
      ];
      for (const name of [other.username, other.display_name, 'fixture-secret-token']) {
        rejected.push(
          ['wechat_recent_messages', { contact_name: name }, 'wechat_recent_messages: contact_name must match the current WeChat bridge chat'],
          ['wechat_send_image', { recipient_name: name, file_path: 'missing.png' }, 'wechat_send_image: recipient_name must match the current WeChat bridge chat'],
        );
      }
      const before = calls.length;
      for (const [tool, args, message] of rejected) {
        await assert.rejects(tools.get(tool).execute(args), error => {
          assert.equal(error.message, message);
          for (const secret of [bridge.config.token, other.username, other.display_name, 'own chat fixture']) {
            assert.ok(!error.message.includes(secret));
          }
          return true;
        });
      }
      assert.equal(calls.length, before);
    }
  });
});

test('unscoped DSH calls preserve chat lookup, enumeration, search and shared-workspace image sending', async t => {
  const { bridge, ctx } = fixture(t, { workspaceMode: 'shared' });
  await bridge.ensureAgent(contactA);
  const workspace = await bridge.ensureWorkspace();
  fs.writeFileSync(path.join(workspace.dir, 'image.png'), 'image fixture');
  const tools = new Map();
  const calls = [];
  ctx.tools = { register: tool => tools.set(tool.name, tool) };
  registerTools(ctx, bridge, {
    async recentMessages(name, limit) { calls.push(['read', name, limit]); return { messages: [{ text: 'normal message' }] }; },
    async recentChats(limit) { calls.push(['list', limit]); return { chats: [{ contact: contactB }] }; },
    async searchContacts(query, limit) { calls.push(['search', query, limit]); return { contacts: [contactB] }; },
    async sendImage(args) { calls.push(['send', args.recipient_name]); return { status: 'sent' }; },
  });
  for (const initiator of [undefined, { id: 'ordinary-dsh-agent' }]) {
    ctx.agents.currentInitiator = () => initiator;
    assert.equal((await tools.get('wechat_recent_messages').execute({ contact_name: contactB.display_name, limit: 5 }))[0].text, 'normal message');
    assert.equal((await tools.get('wechat_list_chats').execute({ limit: 6 }))[0].username, contactB.username);
    assert.equal((await tools.get('wechat_search_contacts').execute({ query: '测试', limit: 7 }))[0].username, contactB.username);
    assert.equal((await tools.get('wechat_send_image').execute({ recipient_name: contactB.display_name, file_path: 'image.png' })).recipient, contactB.display_name);
    assert.deepEqual(calls.splice(0), [
      ['read', contactB.display_name, 5], ['list', 6], ['search', '测试', 7], ['send', contactB.display_name],
    ]);
  }
});

test('bridge presets hide enumeration, search and global bridge control while work mode keeps image sending', async t => {
  const { bridge } = fixture(t, { agentPreset: 'wechat' });
  const { handle } = await bridge.ensureAgent(contactA);
  assert.deepEqual(handle.restriction, { allow: ['wechat_recent_messages'] });
  assert.equal(handle.guard({ name: 'wechat_recent_messages' }), undefined);
  const denied = ['wechat_list_chats', 'wechat_search_contacts', 'wechat_ai_bridge_status', 'wechat_ai_bridge_control', 'wechat_send_message'];
  for (const name of denied) assert.equal(typeof handle.guard({ name }), 'string');
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const block = patch.match(/        toolAllowlist:\n((?:          - [^\n]+\n)+)/)[1];
  const toolAllowlist = [...block.matchAll(/- (\S+)/g)].map(match => match[1]);
  const work = fixture(t, { toolAllowlist });
  const workHandle = (await work.bridge.ensureAgent(contactA)).handle;
  for (const name of denied) assert.equal(typeof workHandle.guard({ name }), 'string');
  for (const name of ['wechat_recent_messages', 'wechat_send_image', 'workspace_read', 'workspace_run', 'web_search', 'todo_write']) {
    assert.equal(workHandle.guard({ name }), undefined);
  }
});

test('incoming files are copied into the selected workspace and reject symlink escapes', async t => {
  const { bridge, temp } = fixture(t);
  bridge.config.tokenFile = path.join(temp, 'service', '.env');
  const data = path.join(temp, 'service', 'config', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'document.txt'), 'incoming fixture');
  bridge.wechatDataDir = '/config/data';
  const a = await bridge.ensureWorkspace(contactA);
  const b = await bridge.ensureWorkspace(contactB);
  const files = [{ filePath: 'document.txt', name: 'document.txt', localId: 1 }];
  const saved = await bridge.importFilesForBatch(files, a.dir);
  assert.equal(saved[0].path, 'incoming/1-document.txt');
  assert.equal(fs.readFileSync(path.join(a.dir, saved[0].path), 'utf8'), 'incoming fixture');
  assert.equal(fs.existsSync(path.join(b.dir, 'incoming')), false);
  fs.symlinkSync(path.join(a.dir, 'incoming'), path.join(b.dir, 'incoming'));
  await assert.rejects(bridge.importFilesForBatch(files, b.dir), /symlink/);
});

test('Codex staging and auth refresh are lazy and independent per workspace', async t => {
  const { bridge, temp } = fixture(t);
  const source = path.join(temp, 'auth-source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'auth.json'), '{}');
  const binary = path.join(temp, 'test-codex');
  fs.writeFileSync(binary, 'test binary fixture');
  bridge.config.codex = { enabled: true, binary, authSource: source, timeoutMs: 60000 };
  await bridge.prepareWorkspace();
  assert.equal(bridge.codexWorkspaces.size, 0);
  const a = await bridge.ensureWorkspace(contactA);
  const b = await bridge.ensureWorkspace(contactB);
  assert.equal(a.codex.enabled, true);
  assert.equal(b.codex.enabled, true);
  assert.notEqual(a.codexHome, b.codexHome);
  assert.equal(fs.statSync(path.join(a.codexHome, 'auth.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(source, 'auth.json'), '{"fixture":true}');
  bridge.syncCodexAuth(a.dir);
  assert.equal(fs.readFileSync(path.join(a.codexHome, 'auth.json'), 'utf8'), '{"fixture":true}');
  assert.equal(fs.readFileSync(path.join(b.codexHome, 'auth.json'), 'utf8'), '{}');
  fs.rmSync(path.join(a.codexHome, 'auth.json'));
  fs.symlinkSync(path.join(b.codexHome, 'auth.json'), path.join(a.codexHome, 'auth.json'));
  bridge.syncCodexAuth(a.dir);
  assert.equal(fs.readFileSync(path.join(b.codexHome, 'auth.json'), 'utf8'), '{}');
  fs.rmSync(a.codexHome, { recursive: true });
  fs.symlinkSync(b.codexHome, a.codexHome);
  assert.throws(() => bridge.syncCodexAuth(a.dir), /symlink/);
});

test('settings expose the mode without credentials and reject invalid enum values', async t => {
  const { bridge, config } = fixture(t);
  let route;
  let edited;
  const ctx = {
    connection: { requestRejection() {} },
    webServer: { register(value) { route = value; } },
    configEditor: {
      entries: () => [{ options: { id: 'wechat-ai-bridge', name: 'dsh-wechat-ai-bridge' } }],
      async edit(_entry, update) { edited = update({}); },
    },
  };
  registerSettingsRoute(ctx, bridge, config, logger);
  const request = async (method, values) => {
    const req = Readable.from(values === undefined ? [] : [Buffer.from(JSON.stringify({ values }))]);
    req.method = method;
    let code;
    let result;
    await route.handler(req, {
      writeHead(value) { code = value; },
      end(body) { result = JSON.parse(body); },
    });
    return { code, result };
  };
  const read = await request('GET');
  assert.equal(read.result.values.workspaceMode, 'per-chat');
  assert.equal(Object.hasOwn(read.result.values, 'token'), false);
  assert.equal((await request('POST', { workspaceMode: 'shared' })).code, 200);
  assert.equal(edited.workspaceMode, 'shared');
  assert.equal((await request('POST', { workspaceMode: 'invalid' })).code, 400);
  assert.equal(edited.workspaceMode, 'shared');
});
