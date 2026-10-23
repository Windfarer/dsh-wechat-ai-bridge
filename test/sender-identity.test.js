import assert from 'node:assert/strict';
import test from 'node:test';
import { Bridge, formatPrompt } from '../lib/bridge.js';
import { emptyState } from '../lib/state.js';
import { normalizeConfig } from '../lib/util.js';

const group = { username: 'test-group@chatroom', display_name: '测试群' };
const privateChat = { username: 'test-sender', display_name: '测试联系人' };
const profile = { username: 'test-sender', nick_name: '测试全局昵称', remark: '测试备注' };
const item = (fields = {}, mentioned = false) => ({
  message: {
    type: 1, create_time: 1, time: '00:00:01', text: '测试消息',
    sender_username: profile.username, sender_display: '测试群昵称', ...fields,
  },
  mentioned,
});

function fixture(api = {}) {
  const logs = [];
  const store = { data: emptyState(), save() {} };
  store.data.selfUsername = 'test-self';
  const logger = {
    info() {}, rate: (...args) => logs.push(args), clean: error => String(error),
  };
  const bridge = new Bridge({}, normalizeConfig(), store, { client: {}, ...api }, logger);
  return { bridge, logs, store };
}

test('group prompt labels global and group nicknames, keeping time, content and mentions', () => {
  const prompt = formatPrompt(group, [item({
    sender_nick_name: profile.nick_name, sender_remark: profile.remark,
  }, true)], '测试机器人群昵称', 4000);
  assert.ok(prompt.includes('发送者微信昵称：测试全局昵称\n发送者ID：test-sender\n'));
  assert.ok(prompt.includes('发送者群昵称：测试群昵称'));
  assert.ok(prompt.includes('时间：00:00:01'));
  assert.ok(prompt.includes('本条消息 @ 了你。'));
  assert.ok(prompt.includes('内容：\n测试消息'));
  assert.ok(!prompt.includes('发送者：'));
  assert.ok(!prompt.includes('发送者备注：'));
});

test('private prompt labels global nickname and only a distinct, nonempty remark', () => {
  for (const [nickname, remark, expectedRemark] of [
    [profile.nick_name, profile.remark, profile.remark],
    [profile.nick_name, profile.nick_name, ''],
    [profile.nick_name, '', ''],
    ['', profile.remark, profile.remark],
  ]) {
    const prompt = formatPrompt(privateChat, [item({
      sender_nick_name: nickname, sender_remark: remark, sender_display: '测试好友备注',
    })], '', 4000);
    assert.ok(prompt.includes(`发送者微信昵称：${nickname || '未知'}\n发送者ID：test-sender\n`));
    assert.equal(prompt.includes('发送者备注：'), Boolean(expectedRemark));
    if (expectedRemark) assert.ok(prompt.includes(`发送者备注：${expectedRemark}`));
    assert.ok(!prompt.includes('发送者群昵称：'));
    assert.ok(!prompt.includes('测试好友备注'));
  }
});

test('missing metadata stays unknown, without using display names as global nicknames', () => {
  const prompt = formatPrompt(group, [item({ sender_username: '', sender_display: '' })], '', 4000);
  assert.ok(prompt.includes('发送者微信昵称：未知\n发送者ID：未知\n'));
  assert.ok(prompt.includes('发送者群昵称：未知'));
  const displayed = formatPrompt(group, [item()], '', 4000);
  assert.ok(displayed.includes('发送者微信昵称：未知\n发送者ID：test-sender\n'));
  assert.ok(displayed.includes('发送者群昵称：测试群昵称'));
});

test('persona is prepended only when configured', () => {
  const batch = [item()];
  assert.ok(!formatPrompt(group, batch, '', 4000).includes('［角色设定］'));
  const prompt = formatPrompt(group, batch, '', 4000, '你叫小七，语气活泼。');
  assert.ok(prompt.startsWith('［角色设定］\n请始终遵循以下人设：\n你叫小七，语气活泼。\n\n［微信新消息］'));
  assert.ok(prompt.includes('内容：\n测试消息'));
  assert.ok(formatPrompt(group, batch, '', 4000, '   ').startsWith('［微信新消息］'));
});

test('prompt remains chronological and reserves reply instructions when truncated', () => {
  const batch = [item({ create_time: 2, text: '较晚消息' }), item({ text: '较早消息' })];
  const prompt = formatPrompt(group, batch, '', 4000);
  assert.ok(prompt.indexOf('较早消息') < prompt.indexOf('较晚消息'));
  const longBatch = [item({ text: '测试内容'.repeat(1000) })];
  const full = formatPrompt(group, longBatch, '', 10000);
  const suffix = full.slice(full.indexOf('\n\n请直接输出'));
  const truncated = formatPrompt(group, longBatch, '', 500);
  assert.equal(truncated.length, 500);
  assert.ok(truncated.endsWith(suffix));
  assert.equal(formatPrompt(group, longBatch, '', 20), full.slice(0, 20));
});

test('resolution uses an exact contact match once per distinct sender and reuses fresh cache', async () => {
  const calls = [];
  const { bridge, store } = fixture({
    async searchContacts(username, limit) {
      calls.push([username, limit]);
      return { contacts: [{ ...profile, username: 'test-other', nick_name: '错误匹配' }, profile] };
    },
  });
  const stateBefore = JSON.stringify(store.data);
  const batch = [item(), item(), item({ sender_username: '' }), item({ sender_username: 'test-self' })];
  await bridge.resolveSenderNicknames(batch);
  await bridge.resolveSenderNicknames([item()]);
  assert.deepEqual(calls, [[profile.username, 5]]);
  for (const { message } of batch.slice(0, 2)) {
    assert.equal(message.sender_nick_name, profile.nick_name);
    assert.equal(message.sender_remark, profile.remark);
    assert.equal(message.sender_display, '测试群昵称');
  }
  for (const { message } of batch.slice(2)) {
    assert.equal(message.sender_nick_name, '');
    assert.equal(message.sender_remark, '');
  }
  assert.equal(JSON.stringify(store.data), stateBefore);
});

test('expired profiles are refreshed and failed refreshes do not reuse stale metadata', async () => {
  let calls = 0;
  const { bridge, logs } = fixture({
    async searchContacts() {
      calls++;
      if (calls === 2) throw new Error('test lookup failure');
      return { contacts: [profile] };
    },
  });
  bridge.rememberSenderProfile({ ...profile, nick_name: '测试旧昵称' });
  const expire = () => { bridge.senderProfiles.get(profile.username).fetchedAt = Date.now() - 30 * 60 * 1000; };
  expire();
  const batch = [item()];
  await bridge.resolveSenderNicknames(batch);
  assert.equal(batch[0].message.sender_nick_name, profile.nick_name);
  expire();
  await assert.doesNotReject(bridge.resolveSenderNicknames(batch));
  assert.equal(batch[0].message.sender_nick_name, '');
  assert.equal(batch[0].message.sender_remark, '');
  assert.equal(bridge.senderProfiles.has(profile.username), false);
  assert.equal(logs[0][0], 'sender-profile');
});

test('missing exact matches and missing nick_name never fall back to other contact fields', async () => {
  const { bridge } = fixture({
    async searchContacts(username) {
      return { contacts: username === profile.username
        ? [{ username, nick_name: '', remark: profile.remark, display_name: '测试显示名', alias: 'test-alias' }]
        : [profile] };
    },
  });
  const batch = [item(), item({ sender_username: 'test-missing' })];
  await bridge.resolveSenderNicknames(batch);
  assert.equal(batch[0].message.sender_nick_name, '');
  assert.equal(batch[0].message.sender_remark, profile.remark);
  assert.equal(batch[1].message.sender_nick_name, '');
  assert.equal(batch[1].message.sender_remark, '');
  assert.equal(bridge.senderProfiles.has('test-missing'), false);
});

test('one room refresh caches all members and retains group-scoped self identity', async () => {
  let roomCalls = 0;
  let searchCalls = 0;
  const { bridge } = fixture({
    async roomMembers(room) {
      assert.equal(room, group.username);
      roomCalls++;
      return { members: [
        { ...profile, display_name: '测试群昵称' },
        { username: 'test-member', display_name: '另一个测试群昵称' },
        { username: 'test-self', nick_name: '测试机器人', display_name: '测试机器人群昵称' },
      ] };
    },
    async searchContacts() { searchCalls++; return { contacts: [] }; },
  });
  await bridge.ensureRoomIdentity(group);
  await bridge.ensureRoomIdentity(group);
  const batch = [item(), item({ sender_username: 'test-member' })];
  await bridge.resolveSenderNicknames(batch);
  assert.equal(roomCalls, 1);
  assert.equal(searchCalls, 0);
  assert.equal(bridge.senderProfiles.size, 3);
  assert.equal(bridge.chatState(group).roomSelfName, '测试机器人群昵称');
  assert.deepEqual(bridge.chatState(group).roomMemberNames, [
    { username: profile.username, display_name: '测试群昵称' },
    { username: 'test-member', display_name: '另一个测试群昵称' },
    { username: 'test-self', display_name: '测试机器人群昵称' },
  ]);
  assert.equal(batch[0].message.sender_nick_name, profile.nick_name);
  assert.equal(batch[0].message.sender_remark, profile.remark);
  assert.equal(batch[1].message.sender_nick_name, '');
  assert.equal(batch[1].message.sender_remark, '');
});

test('sender profile cache evicts the oldest fetched entry and stays bounded', () => {
  const { bridge } = fixture();
  for (let i = 0; i < 1000; i++) bridge.rememberSenderProfile({ ...profile, username: `test-sender-${i}` });
  bridge.rememberSenderProfile({ ...profile, username: 'test-sender-0' });
  bridge.rememberSenderProfile({ ...profile, username: 'test-sender-1000' });
  assert.equal(bridge.senderProfiles.size, 1000);
  assert.equal(bridge.senderProfiles.has('test-sender-0'), true);
  assert.equal(bridge.senderProfiles.has('test-sender-1'), false);
  assert.equal(bridge.senderProfiles.has('test-sender-1000'), true);
});

test('auto-@ skips a display name that prefixes another member', () => {
  const { bridge } = fixture();
  bridge.chatState(group).roomMemberNames = [
    { username: 'test-y', display_name: 'y' },
    { username: 'test-yang', display_name: 'Yang' },
    { username: 'test-bread', display_name: 'Bread' },
  ];
  assert.equal(bridge.mentionNameFor(group, 'y', 'test-y'), undefined);
  assert.equal(bridge.mentionNameFor(group, 'Yang', 'test-yang'), 'Yang');
  assert.equal(bridge.mentionNameFor(group, 'Bread', 'test-bread'), 'Bread');
  bridge.chatState(group).roomMemberNames = [];
  assert.equal(bridge.mentionNameFor(group, 'y', 'test-y'), 'y');
});

test('room metadata failures are non-fatal and allow contact lookup', async () => {
  const { bridge, logs } = fixture({
    async roomMembers() { throw new Error('test room lookup failure'); },
    async searchContacts() { return { contacts: [profile] }; },
  });
  await assert.doesNotReject(bridge.ensureRoomIdentity(group));
  const batch = [item()];
  await bridge.resolveSenderNicknames(batch);
  assert.equal(batch[0].message.sender_nick_name, profile.nick_name);
  assert.equal(logs[0][0], 'room-members');
});

test('runBatch attaches recent images for visual group follow-ups and preserves image request rules', async t => {
  const cases = [
    { name: 'direct image followed by 你再看看', text: '你再看看', expected: 1 },
    { name: 'look again resends previously delivered pixels', text: '你再看看', sent: true, expected: 1 },
    { name: 'follow-up without recent image', text: '你再看看', remembered: false, expected: 0 },
    { name: 'follow-up with expired image', text: '你再看看', expired: true, expected: 0 },
    { name: 'unrelated text after image', text: '今天天气怎么样', expected: 0 },
    { name: 'explicit image question', text: '图片里有什么', expected: 1 },
    { name: 'explicit image question falls back to media', text: '图片里有什么', remembered: false, expected: 1 },
    { name: 'generic image question keeps sent-image dedupe', text: '图片里有什么', sent: true, expected: 0, reads: 1 },
    { name: 'explicit image reference resends pixels', text: '之前的图片', sent: true, expected: 1 },
    { name: 'direct image resends pixels', text: '', type: 3, sent: true, expected: 1 },
    { name: 'disabled images stay disabled', text: '你再看看', disabled: true, expected: 0 },
    ...['看一下', '再看', '看下', '瞅瞅', '瞧瞧', '这个', '这张', '那个', '那张', '上面', '刚才']
      .map(text => ({ name: `recent image reference: ${text}`, text, expected: 1 })),
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const now = Math.floor(Date.now() / 1000);
    const data = Buffer.from('test image pixels');
    const image = item({
      type: 3, local_id: 'test-image', create_time: now - 1, text: '',
      image_block: { data: data.toString('base64'), mimeType: 'image/png' },
    }).message;
    const prompts = [];
    const saved = [];
    let reads = 0;
    const { bridge, store, logs } = fixture({
      async searchContacts() { return { contacts: [profile] }; },
      async recentMedia(username) {
        assert.equal(username, group.username);
        reads++;
        return { messages: [image] };
      },
      async sendText() { return { status: 'executed', completed: true }; },
    });
    bridge.identityResolved = true;
    bridge.config.reply.images = !scenario.disabled;
    if (scenario.expired) image.create_time = now - bridge.config.reply.imageContextAgeMs / 1000 - 1;
    // Group images are remembered without triggering a reply; the later @ text runs the batch.
    if (scenario.remembered !== false) bridge.rememberImage(group, image);
    if (scenario.sent) bridge.rememberSentImages(group, [{ hash: bridge.imageHash(data) }]);
    bridge.ctx.attachments = { async saveImages(images) {
      saved.push(...images);
      return images.map(() => 'test-image-attachment');
    } };
    bridge.ensureAgent = async () => ({ sessionId: 'test-session', acceptsImages: true, handle: { agent: {
      followup({ content }) { prompts.push(content); },
      async whenIdle() { bridge.lastAssistantText.set('test-session', '测试回复'); },
    } } });
    await bridge.runBatch(group, [item({
      type: scenario.type || 1, create_time: now, text: `@测试机器人 ${scenario.text}`,
    }, true)], bridge.pauseGeneration);
    assert.equal(store.data.stats.errors, 0);
    assert.equal(store.data.stats.replies, 1);
    assert.deepEqual(logs, []);
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].filter(block => block.type === 'image'),
      Array.from({ length: scenario.expected }, () => ({ type: 'image', attachment: 'test-image-attachment' })));
    assert.equal(reads, scenario.reads ?? scenario.expected);
    assert.equal(saved.length, scenario.expected);
    if (scenario.expected) {
      assert.deepEqual(Buffer.from(saved[0].data), data);
      assert.equal(saved[0].mediaType, 'image/png');
    }
  });
});

test('runBatch resolves after agent readiness, continues on failure and keeps the group @ name', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'failed lookup' : 'successful lookup', async () => {
    const calls = [];
    const sent = [];
    const { bridge, store, logs } = fixture({
      async searchContacts() {
        calls.push('lookup');
        if (fail) throw new Error('test lookup failure');
        return { contacts: [profile] };
      },
      async sendText(args) {
        sent.push(args);
        return { status: 'executed', completed: true };
      },
    });
    bridge.identityResolved = true;
    bridge.ensureAgent = async () => {
      calls.push('agent-ready');
      return { sessionId: 'test-session', handle: { agent: {
        followup({ content }) {
          calls.push('prompt');
          assert.ok(content[0].text.includes(`发送者微信昵称：${fail ? '未知' : profile.nick_name}\n发送者ID：test-sender\n`));
          assert.ok(content[0].text.includes('发送者群昵称：测试群昵称'));
        },
        async whenIdle() { bridge.lastAssistantText.set('test-session', '测试回复'); },
      } } };
    };
    await bridge.runBatch(group, [item({}, true)], bridge.pauseGeneration);
    assert.deepEqual(calls, ['agent-ready', 'lookup', 'prompt']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].at_user_name, '测试群昵称');
    assert.equal(store.data.stats.replies, 1);
    assert.equal(store.data.stats.errors, 0);
    assert.equal(logs.length, fail ? 1 : 0);
    assert.ok(!JSON.stringify(store.data).includes(profile.nick_name));
    assert.ok(!JSON.stringify(store.data).includes(profile.remark));
  });
});
