import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { normalizeConfig } from '../lib/util.js';
import { synthesizeSpeech, ttsEndpoint } from '../lib/tts.js';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('TTS config normalizes defaults and numeric bounds', () => {
  const defaults = normalizeConfig().tts;
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.model, 'breeze-tts-2');
  assert.equal(defaults.voice, 'alloy');
  assert.equal(defaults.maxChars, 200);
  const custom = normalizeConfig({
    tts: { enabled: true, baseUrl: ' http://10.0.0.14:8000/v1 ', apiKey: 'unused', timeoutMs: 999999, maxChars: 0 },
  }).tts;
  assert.equal(custom.baseUrl, 'http://10.0.0.14:8000/v1');
  assert.equal(custom.timeoutMs, 180000);
  assert.equal(custom.maxChars, 200);
  assert.equal(custom.apiKey, 'unused');
});

test('TTS endpoint joins the OpenAI-compatible speech path', () => {
  assert.equal(ttsEndpoint('http://10.0.0.14:8000/v1/'), 'http://10.0.0.14:8000/v1/audio/speech');
  assert.throws(() => ttsEndpoint('  '), /base URL/);
});

test('TTS synthesizes audio with model, voice and optional bearer key', async t => {
  let received;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('ID3fixture-audio'));
    });
  });
  const base = await listen(server);
  t.after(() => server.close());
  const config = normalizeConfig({
    tts: { enabled: true, baseUrl: `${base}/v1`, apiKey: 'unused', model: 'breeze-tts-2', voice: 'alloy' },
  }).tts;
  const result = await synthesizeSpeech(config, '你好，我是 Nemu。');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.buffer.toString(), 'ID3fixture-audio');
  assert.deepEqual(received, {
    method: 'POST',
    url: '/v1/audio/speech',
    authorization: 'Bearer unused',
    contentType: 'application/json',
    body: { model: 'breeze-tts-2', input: '你好，我是 Nemu。', voice: 'alloy' },
  });
});

test('TTS rejects disabled, empty and overlong text before making a request', async () => {
  const disabled = normalizeConfig().tts;
  await assert.rejects(synthesizeSpeech(disabled, 'hello'), /disabled/);
  const enabled = normalizeConfig({ tts: { enabled: true, baseUrl: 'http://127.0.0.1:1', maxChars: 3 } }).tts;
  await assert.rejects(synthesizeSpeech(enabled, '   '), /must not be empty/);
  await assert.rejects(synthesizeSpeech(enabled, 'four'), /too long/);
});

test('TTS surfaces HTTP errors without exposing request headers', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('speech backend unavailable');
  });
  const base = await listen(server);
  t.after(() => server.close());
  const config = normalizeConfig({
    tts: { enabled: true, baseUrl: `${base}/v1`, apiKey: 'top-secret-key' },
  }).tts;
  await assert.rejects(synthesizeSpeech(config, 'hello'), error => {
    assert.match(error.message, /HTTP 503/);
    assert.match(error.message, /speech backend unavailable/);
    assert.doesNotMatch(error.message, /top-secret-key/);
    return true;
  });
});
