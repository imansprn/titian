// Operation policy. This is a host-execution guardrail, NOT an OS sandbox.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const definitions = require('./permissions.json');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function validatePolicy(value) {
  if (!object(value) || Object.keys(value).some(k => !['version', 'preset', 'rules'].includes(k)) ||
      value.version !== definitions.version || typeof value.preset !== 'string' || !own(definitions.presets, value.preset) || !object(value.rules)) {
    throw new Error('Invalid permission policy. Expected version 2, a supported preset and rules.');
  }
  if (Object.keys(value.rules).length && value.preset !== 'custom') throw new Error('Only custom accepts rule overrides.');
  for (const [operation, decision] of Object.entries(value.rules)) {
    if (!definitions.operations.includes(operation) || !['allow', 'ask', 'deny'].includes(decision)) {
      throw new Error('Invalid permission rule: ' + operation);
    }
  }
  return JSON.parse(JSON.stringify(value));
}
function inside(file, directory) {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function resolveTarget(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('An absolute filesystem path is required.');
  const absolute = path.resolve(input);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling symlink must not become a supposedly safe new file.
    try { if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Dangling symlink denied.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(absolute) === absolute) throw error;
    return path.join(resolveTarget(path.dirname(absolute)), path.basename(absolute));
  }
}
const TOOL_OPERATIONS = {
  read_file: 'files.read', read_multiple_files: 'files.read', list_directory: 'files.read', get_file_info: 'files.read',
  write_file: 'files.write', edit_block: 'files.write', create_directory: 'files.write', write_pdf: 'files.write',
  move_file: 'files.move', start_search: 'search', get_more_search_results: 'search', stop_search: 'search',
  start_process: 'process.start', interact_with_process: 'process.input', read_process_output: 'process.read',
  force_terminate: 'process.stop', kill_process: 'process.stop',
  list_processes: 'system.inspect', list_sessions: 'system.inspect', list_searches: 'system.inspect',
  get_config: 'system.inspect', get_usage_stats: 'system.inspect', get_recent_tool_calls: 'system.inspect',
};
class Policy {
  constructor({ policy, roots = [], protectedPaths = [], cwd, project = 'titian', executionContext = () => ({}) }) {
    this.config = validatePolicy(policy);
    this.roots = roots.map(resolveTarget);
    this.protectedPaths = protectedPaths.map(resolveTarget);
    this.cwd = cwd ? resolveTarget(cwd) : this.roots[0];
    this.project = project;
    this.executionContext = executionContext;
    this.sessions = new Map();
    this.revision = digest({ policy: this.config, roots: this.roots, protectedPaths: this.protectedPaths, cwd: this.cwd });
  }
  effective() {
    return { version: 2, project: this.project, policy: this.config, roots: this.roots, revision: this.revision,
      execution: 'host', sandboxed: false, rules: Object.fromEntries(definitions.operations.map(op => [op, this.decision(op)])) };
  }
  decision(operation) {
    if (!definitions.operations.includes(operation)) return 'deny';
    return (this.config.preset === 'custom' ? this.config.rules[operation] : definitions.presets[this.config.preset][operation]) || 'deny';
  }
  evaluate(name, arguments_, principal) {
    try {
      if (!principal) throw new Error('Authentication required.');
      if (!object(arguments_)) throw new Error('Tool arguments must be an object.');
      if (Buffer.byteLength(JSON.stringify(arguments_)) > 262144) throw new Error('Tool arguments exceed 256 KiB.');
      if (['approved', 'approvalId', '_titian', 'permissionMode'].some(k => own(arguments_, k))) throw new Error('Approval cannot be supplied in tool arguments.');
      if (!own(TOOL_OPERATIONS, name)) throw new Error('Tool has no reviewed permission mapping.');
      if (name === 'kill_process') throw new Error('Raw PID signaling is disabled. Use force_terminate for a session owned by this client.');
      const args = JSON.parse(JSON.stringify(arguments_));
      const operations = [TOOL_OPERATIONS[name]];
      const targets = [];
      const checkPath = (input, recursive = false) => {
        const target = resolveTarget(input);
        if (!this.roots.some(root => inside(target, root))) throw new Error('Path is outside approved workspace roots.');
        if (this.protectedPaths.some(p => inside(target, p) || (recursive && inside(p, target)))) {
          throw new Error('Titian control/state paths are protected. Narrow the requested directory.');
        }
        let stat;
        try { stat = fs.statSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (stat && !stat.isFile() && !stat.isDirectory()) throw new Error('Special files are not permitted.');
        if (stat?.isFile() && stat.nlink > 1) throw new Error('Hard-linked files require a separate trusted workflow.');
        if (stat?.isDirectory() && this.protectedPaths.some(p => inside(p, target))) throw new Error('Directory contains protected Titian state.');
        targets.push({ path: target, state: stat ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : null });
        return target;
      };
      if (name === 'read_multiple_files') {
        if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 100) throw new Error('Expected 1-100 file paths.');
        args.paths = args.paths.map(p => checkPath(p));
      } else if (name === 'move_file') {
        args.source = checkPath(args.source, true); args.destination = checkPath(args.destination, true);
      } else if (name === 'edit_block') {
        args.file_path = checkPath(args.file_path);
      } else if (['read_file', 'list_directory', 'get_file_info', 'write_file', 'create_directory', 'start_search', 'write_pdf'].includes(name)) {
        if (name === 'read_file' && args.isUrl === true) {
          const url = new URL(args.path);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) URLs are supported.');
          operations.splice(0, 1, 'network.fetch');
        } else {
          args.path = checkPath(args.path, ['start_search', 'list_directory', 'create_directory'].includes(name));
        }
      }
      if (name === 'read_file' && args.options && Object.keys(args.options).length) throw new Error('Use top-level read options; nested options are not supported.');
      if (name === 'write_pdf') {
        operations.push('document.render');
        if (args.outputPath) args.outputPath = checkPath(args.outputPath);
        if (Array.isArray(args.content)) for (const item of args.content) {
          if (item.sourcePdfPath) item.sourcePdfPath = checkPath(item.sourcePdfPath);
        }
      }
      if (name === 'write_file' && /\.(docx|pdf)$/i.test(args.path)) operations.push('document.render');
      if (name === 'start_process') {
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0')) throw new Error('A nonempty command is required.');
        // The WHOLE invocation is trusted code; no claim is made about shell semantics.
        if (!this.cwd || !this.roots.some(root => inside(this.cwd, root))) throw new Error('Execution requires a configured workspace directory.');
      }
      let session;
      if (['read_process_output', 'interact_with_process', 'force_terminate', 'kill_process'].includes(name)) {
        if (!Number.isSafeInteger(args.pid) || args.pid === 0 || args.pid === -1) throw new Error('A valid tracked process/session ID is required.');
        session = this.sessions.get('process:' + args.pid);
        if (!session || session.principal !== principal) throw new Error('Process is not owned by this authenticated client.');
      }
      if (['get_more_search_results', 'stop_search'].includes(name)) {
        session = this.sessions.get('search:' + args.sessionId);
        if (!session || session.principal !== principal) throw new Error('Search is not owned by this authenticated client.');
      }
      const decisions = operations.map(op => this.decision(op));
      const decision = decisions.includes('deny') ? 'deny' : decisions.includes('ask') ? 'ask' : 'allow';
      return { decision, reason: decision === 'deny' ? 'Denied by workspace policy. The owner must change the policy.' : '',
        operation: operations.join('+'), request: { name, arguments: args }, context: { project: this.project,
          principal, cwd: this.cwd || null, policyRevision: this.revision, execution: 'host', targets, session: session ? { generation: session.generation, startedWith: session.startedWith } : null,
          runtimeContext: this.executionContext() } };
    } catch (error) { return { decision: 'deny', reason: error.message }; }
  }
  record(name, args, result, principal) {
    if (result.isError) return;
    const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    let key;
    if (name === 'start_process') {
      const pid = /^(?:Process|Node\.js session) started with PID (-?\d+)\b/.exec(text)?.[1];
      if (pid) key = 'process:' + pid;
    } else if (name === 'start_search') {
      const id = /^Started (?:content|files?|file) search session: ([\w-]+)/.exec(text)?.[1];
      if (id) key = 'search:' + id;
    }
    if (key) this.sessions.set(key, { principal, generation: crypto.randomUUID(), startedWith: JSON.parse(JSON.stringify(args)) });
    if (['force_terminate', 'kill_process'].includes(name) || (name === 'read_process_output' && /Process (?:finished|exited)/.test(text))) {
      this.sessions.delete('process:' + args.pid);
    }
    if (name === 'stop_search') this.sessions.delete('search:' + args.sessionId);
  }
}
module.exports = { Policy, validatePolicy, canonical, digest, definitions, resolveTarget, inside };
