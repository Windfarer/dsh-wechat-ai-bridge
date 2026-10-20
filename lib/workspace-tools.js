/**
 * Workspace-confined tools for the WeChat work-mode Agent.
 *
 * The ambient DSH sandbox modes only restrict writes, so work mode replaces the
 * host bash/fs tools with this module: every file path is resolved against the
 * session workspace, and shell commands run under bubblewrap with only the
 * workspace writable and system directories read-only. Host user directories
 * (other projects, home, SSH keys, …) are not mounted at all.
 *
 * Tools are registered on the Agent's scoped context in `setup`, so they exist
 * only for bridge sessions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 262144;
const MAX_OUTPUT_BYTES = 65536;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;

/** Canonical directory root shared by every tool instance. */
function canonicalRoot(root) {
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('workspace root is not a directory');
  return resolved;
}

/** Resolve `input` inside `root`, rejecting `..`, absolute escapes, and symlink escapes. */
function resolveInside(root, input, { allowRoot = true } = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path must be a non-empty string');
  let value = input.trim();
  // Accept the jail spelling so a command result naming /workspace still works.
  if (value === '/workspace') value = '.';
  else if (value.startsWith('/workspace/')) value = value.slice('/workspace/'.length);
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`path escapes the workspace: ${input}`);
  }
  if (relative === '' && !allowRoot) throw new Error('path must name a file or subdirectory');
  // Every existing ancestor must canonicalize inside the workspace, which also
  // blocks a symlink planted in the workspace that points at host paths.
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== root && !realProbe.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace through a symlink: ${input}`);
  }
  return absolute;
}

/** Relative, slash-normalized display path for tool results. */
function displayPath(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

/**
 * Resolve a file inside a canonical workspace root.
 *
 * Exported for host-side helpers (for example the image-send tool) that must
 * read workspace files without exposing the rest of the host filesystem.
 */
export function resolveWorkspacePath(root, input, options = {}) {
  return resolveInside(root, input, { allowRoot: false, ...options });
}

/** Validate one tool argument object against the small schema description. */
function readArgs(args, spec) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  for (const key of Object.keys(args)) if (!Object.hasOwn(spec, key)) throw new Error(`unknown parameter: ${key}`);
  const value = {};
  for (const [key, rule] of Object.entries(spec)) {
    let input = args[key];
    if (input === undefined) {
      if (rule.required) throw new Error(`${key} is required`);
      if (rule.default !== undefined) value[key] = rule.default;
      continue;
    }
    if (rule.type === 'number') {
      if (typeof input !== 'number' || !Number.isFinite(input)) throw new Error(`${key} must be a number`);
      input = Math.trunc(input);
      if (rule.min !== undefined) input = Math.max(rule.min, input);
      if (rule.max !== undefined) input = Math.min(rule.max, input);
      value[key] = input;
      continue;
    }
    if (rule.type === 'boolean') {
      if (typeof input !== 'boolean') throw new Error(`${key} must be a boolean`);
      value[key] = input;
      continue;
    }
    if (typeof input !== 'string') throw new Error(`${key} must be a string`);
    if (rule.required && input.trim() === '') throw new Error(`${key} must not be empty`);
    value[key] = input;
  }
  return value;
}

/** Parameter JSON Schema for the scoped tools (the model sees this). */
function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function textProperty(description) { return { type: 'string', description }; }
function numberProperty(description) { return { type: 'integer', description }; }

/** Text file detection for read/search: NUL bytes mark binary content. */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 4096);
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true;
  return false;
}

/** Run a shell command inside the bubblewrap jail. */
function runJailed(root, command, timeoutMs, options = {}) {
  const systemRoots = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32'];
  const args = ['--die-with-parent', '--unshare-all', '--share-net'];
  for (const dir of systemRoots) if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir);
  // No wholesale /etc bind: only the files and certificate trees tools need.
  // This keeps host account databases, SSH configuration, and other system
  // configuration out of the jail.
  args.push('--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--dir', '/etc');
  for (const file of [
    '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime',
    '/etc/timezone', '/etc/ld.so.cache', '/etc/ld.so.conf',
  ]) {
    if (fs.existsSync(file)) args.push('--ro-bind', file, file);
  }
  for (const dir of [
    '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/ld.so.conf.d', '/etc/profile.d',
  ]) {
    if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir);
  }
  args.push('--bind', root, '/workspace');
  if (options.codexBinary) {
    args.push('--dir', '/opt', '--dir', '/opt/codex');
    args.push('--ro-bind', options.codexBinary, '/opt/codex/codex');
    if (options.codexHostBinary && fs.existsSync(options.codexHostBinary)) {
      args.push('--ro-bind', options.codexHostBinary, '/opt/codex/codex-code-mode-host');
    }
  }
  args.push('--clearenv');
  args.push('--setenv', 'PATH', options.codexBinary
    ? '/opt/codex:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  args.push('--setenv', 'HOME', '/workspace');
  args.push('--setenv', 'TMPDIR', '/tmp');
  if (options.codexBinary) args.push('--setenv', 'CODEX_HOME', '/workspace/.codex');
  args.push('--setenv', 'LANG', process.env.LANG || 'C.UTF-8');
  args.push('--setenv', 'LC_ALL', process.env.LC_ALL || process.env.LANG || 'C.UTF-8');
  for (const key of ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[key]) args.push('--setenv', key, process.env[key]);
  }
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  args.push('--chdir', '/workspace', '--', shell, '-lc', command);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('bwrap', args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => { /* The jail exited before reading stdin. */ });
      child.stdin.end(typeof options.input === 'string' ? options.input : '');
    } catch (error) {
      reject(new Error(`cannot start workspace sandbox: ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      stdoutBytes += chunk.length;
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      stderrBytes += chunk.length;
      stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT'
        ? 'workspace sandbox runner "bwrap" is not installed on the host'
        : `workspace sandbox failed: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const truncate = text => text.length <= MAX_OUTPUT_BYTES
        ? text
        : `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[output truncated]`;
      resolve({
        exit_code: code === null ? -1 : code,
        signal: signal || '',
        timed_out: timedOut,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    });
  });
}

/** Register every workspace-scoped tool on one unpublished Agent context. */
export function registerWorkspaceTools(agentCtx, { root, execTimeoutMs = 120000, logger, codex = {} }) {
  const base = canonicalRoot(root);
  const register = (name, description, parameters, execute, outputSchema = { type: 'object', additionalProperties: true }) => {
    agentCtx.tools.register({
      name,
      description,
      parameters,
      output: {
        schema: outputSchema,
        render(_args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        try {
          return await execute(args);
        } catch (error) {
          logger.rate(`workspace-tool:${name}`, error);
          throw error;
        }
      },
    });
  };

  register('workspace_list',
    '列出工作区内的目录或文件。 List a directory inside the workspace (paths are relative to it).',
    schema({ path: textProperty('Directory path relative to the workspace; default "."'), limit: numberProperty('Maximum entries; default 200') }),
    async input => {
      const args = readArgs(input, { path: { type: 'string', default: '.' }, limit: { type: 'number', default: 200 } });
      const directory = resolveInside(base, args.path);
      const stat = fs.statSync(directory);
      if (!stat.isDirectory()) throw new Error(`not a directory: ${args.path}`);
      const limit = Math.max(1, Math.min(MAX_LIST_ENTRIES, args.limit));
      const entries = fs.readdirSync(directory, { withFileTypes: true })
        .map(entry => {
          const absolute = path.join(directory, entry.name);
          let size = 0;
          let modified = '';
          try {
            const info = fs.statSync(absolute);
            size = info.size;
            modified = info.mtime.toISOString();
          } catch { /* Broken symlink or unreadable entry. */ }
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
            size,
            modified,
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
        .slice(0, limit);
      return { path: displayPath(base, directory), entries, truncated: entries.length >= limit };
    });

  register('workspace_read',
    '读取工作区内的文本文件。 Read a text file inside the workspace, with optional line offset and limit.',
    schema({
      path: textProperty('File path relative to the workspace'),
      offset: numberProperty('First line, 1-based; default 1'),
      limit: numberProperty('Maximum lines; default 400, max 2000'),
    }, ['path']),
    async input => {
      const args = readArgs(input, {
        path: { type: 'string', required: true },
        offset: { type: 'number', default: 1 },
        limit: { type: 'number', default: 400 },
      });
      const file = resolveInside(base, args.path, { allowRoot: false });
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error(`not a regular file: ${args.path}`);
      if (stat.size > MAX_READ_BYTES) throw new Error(`file is larger than ${MAX_READ_BYTES} bytes; use workspace_run with head/tail or workspace_search`);
      const buffer = fs.readFileSync(file);
      if (looksBinary(buffer)) throw new Error('file appears to be binary');
      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      const offset = Math.max(1, args.offset);
      const limit = Math.max(1, Math.min(MAX_READ_LINES, args.limit));
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      return {
        path: displayPath(base, file),
        content: selected.join('\n'),
        offset,
        lines: selected.length,
        total_lines: lines.length,
        truncated: offset - 1 + selected.length < lines.length,
      };
    });

  register('workspace_write',
    '在工作区内创建或覆盖文件。 Write a text file inside the workspace (parent directories are created).',
    schema({
      path: textProperty('File path relative to the workspace'),
      content: textProperty('Full file content'),
      append: { type: 'boolean', description: 'Append instead of overwrite; default false' },
    }, ['path', 'content']),
    async input => {
      const args = readArgs(input, {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
        append: { type: 'boolean', default: false },
      });
      const file = resolveInside(base, args.path, { allowRoot: false });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (args.append) fs.appendFileSync(file, args.content, 'utf8');
      else fs.writeFileSync(file, args.content, 'utf8');
      const stat = fs.statSync(file);
      return { path: displayPath(base, file), bytes: stat.size, appended: args.append };
    });

  register('workspace_edit',
    '替换工作区文件中的文本。 Replace literal text in a workspace file; requires a unique match unless replace_all is true.',
    schema({
      path: textProperty('File path relative to the workspace'),
      old_text: textProperty('Exact text to replace'),
      new_text: textProperty('Replacement text; may be empty'),
      replace_all: { type: 'boolean', description: 'Replace every occurrence; default false' },
    }, ['path', 'old_text', 'new_text']),
    async input => {
      const args = readArgs(input, {
        path: { type: 'string', required: true },
        old_text: { type: 'string', required: true },
        new_text: { type: 'string', required: true },
        replace_all: { type: 'boolean', default: false },
      });
      const file = resolveInside(base, args.path, { allowRoot: false });
      const text = fs.readFileSync(file, 'utf8');
      const count = args.old_text === '' ? 0 : text.split(args.old_text).length - 1;
      if (count === 0) throw new Error('old_text was not found in the file');
      if (count > 1 && !args.replace_all) throw new Error(`old_text occurs ${count} times; pass replace_all:true or provide a unique snippet`);
      const next = args.replace_all
        ? text.split(args.old_text).join(args.new_text)
        : text.replace(args.old_text, args.new_text);
      fs.writeFileSync(file, next, 'utf8');
      return { path: displayPath(base, file), replacements: args.replace_all ? count : 1 };
    });

  register('workspace_search',
    '在工作区内按正则搜索文本。 Search text files inside the workspace with a JavaScript regular expression.',
    schema({
      pattern: textProperty('JavaScript regular expression source'),
      path: textProperty('Directory or file relative to the workspace; default "."'),
      case_sensitive: { type: 'boolean', description: 'Case sensitive; default false' },
      limit: numberProperty('Maximum matches; default 100, max 200'),
    }, ['pattern']),
    async input => {
      const args = readArgs(input, {
        pattern: { type: 'string', required: true },
        path: { type: 'string', default: '.' },
        case_sensitive: { type: 'boolean', default: false },
        limit: { type: 'number', default: 100 },
      });
      let matcher;
      try { matcher = new RegExp(args.pattern, args.case_sensitive ? 'g' : 'gi'); }
      catch (error) { throw new Error(`invalid regular expression: ${error.message}`); }
      const start = resolveInside(base, args.path);
      const limit = Math.max(1, Math.min(MAX_SEARCH_MATCHES, args.limit));
      const skip = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);
      const matches = [];
      let filesScanned = 0;
      let truncated = false;
      const visit = entry => {
        if (matches.length >= limit) { truncated = true; return; }
        let stat;
        try { stat = fs.lstatSync(entry); } catch { return; }
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          if (skip.has(path.basename(entry))) return;
          for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
          return;
        }
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) return;
        let buffer;
        try { buffer = fs.readFileSync(entry); } catch { return; }
        if (looksBinary(buffer)) return;
        filesScanned += 1;
        const lines = buffer.toString('utf8').split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          matcher.lastIndex = 0;
          if (!matcher.test(lines[index])) continue;
          matches.push({ path: displayPath(base, entry), line: index + 1, text: lines[index].trim().slice(0, 400) });
          if (matches.length >= limit) { truncated = true; return; }
        }
      };
      visit(start);
      return { matches, files_scanned: filesScanned, truncated };
    });

  register('workspace_run',
    '在隔离沙箱中运行命令。 Run a shell command with the workspace mounted at /workspace; the host filesystem outside the workspace is not visible.',
    schema({
      command: textProperty('Shell command; runs in /workspace inside the sandbox'),
      timeout_ms: numberProperty('Timeout in milliseconds; default 120000, max 600000'),
    }, ['command']),
    async input => {
      const args = readArgs(input, {
        command: { type: 'string', required: true },
        timeout_ms: { type: 'number', default: execTimeoutMs },
      });
      const timeout = Math.max(1000, Math.min(600000, args.timeout_ms));
      return await runJailed(base, args.command, timeout);
    });

  if (codex?.enabled && codex.binary) {
    register('workspace_codex',
      '在工作区沙箱里运行 Codex CLI 子代理（能读写工作区、联网，不能访问宿主机其它目录）。 Run a Codex CLI subagent inside the workspace jail; it can edit the workspace but cannot see host paths.',
      schema({
        prompt: textProperty('Task for the Codex subagent'),
        timeout_ms: numberProperty(`Timeout in milliseconds; default ${codex.timeoutMs || 600000}, max 1800000`),
      }, ['prompt']),
      async input => {
        const args = readArgs(input, {
          prompt: { type: 'string', required: true },
          timeout_ms: { type: 'number', default: codex.timeoutMs || 600000 },
        });
        const timeout = Math.max(10000, Math.min(1800000, args.timeout_ms));
        if (typeof codex.beforeRun === 'function') await codex.beforeRun();
        return await runJailed(base,
          '/opt/codex/codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -',
          timeout, { codexBinary: codex.binary, codexHostBinary: codex.hostBinary, input: args.prompt });
      });
  }
}
