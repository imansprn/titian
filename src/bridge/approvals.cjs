// Pending approvals live only in this bridge. Restart/revocation discards them.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { digest } = require('./policy.cjs');

function response(status, message, extra = {}) {
  const data = { status, message, ...extra };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true };
}
class ApprovalGate {
  constructor(policy, execute, { now = Date.now, ttl = 300000, limit = 200, audit = () => {} } = {}) {
    this.policy = policy; this.execute = execute; this.now = now; this.ttl = ttl; this.limit = limit;
    this.audit = audit; this.requests = new Map(); this.ownerAvailable = false;
  }
  emit(event, record = {}) {
    this.audit({ event, requestId: record.id, operation: record.plan?.operation, requestHash: record.hash,
      principalHash: record.plan ? digest(record.plan.context.principal) : undefined });
  }
  list() {
    for (const [id, rec] of this.requests) if (this.now() >= rec.expiresAt) this.requests.delete(id);
    return [...this.requests.values()].map(rec => this.view(rec.id));
  }
  get(id) {
    const rec = this.requests.get(id);
    if (!rec || this.now() >= rec.expiresAt) { this.requests.delete(id); throw new Error('Request is missing or expired.'); }
    return rec;
  }
  view(id) {
    const r = this.get(id);
    return { requestId: r.id, status: r.status, expiresAt: r.expiresAt, requestHash: r.hash,
      operation: r.plan.operation, request: r.plan.request, context: r.plan.context };
  }
  ownerDecision(id, decision, expectedHash) {
    if (!['approve', 'reject'].includes(decision)) throw new Error('Invalid owner decision.');
    const rec = this.get(id);
    if (rec.status !== 'pending' || rec.hash !== expectedHash) throw new Error('Request changed or is no longer pending.');
    const current = this.policy.evaluate(rec.plan.request.name, rec.plan.request.arguments, rec.plan.context.principal);
    if (current.decision !== 'ask' || digest(current) !== rec.hash) throw new Error('Policy or target changed; submit a new request.');
    rec.status = decision === 'approve' ? 'approved' : 'rejected';
    this.emit(rec.status, rec);
    return this.view(id);
  }
  async run(plan) {
    const result = await this.execute(plan.request.name, plan.request.arguments);
    this.policy.record(plan.request.name, plan.request.arguments, result, plan.context.principal);
    return { ...result, isError: result.isError ?? false };
  }
  async call(name, args, principal) {
    const plan = this.policy.evaluate(name, args, principal);
    if (plan.decision === 'deny') {
      this.emit('denied');
      return response('denied', plan.reason);
    }
    if (plan.decision === 'allow') { this.emit('allowed', { plan, hash: digest(plan) }); return this.run(plan); }
    if (!this.ownerAvailable) return response('approval_unavailable', 'Owner approval is unavailable. Nothing was executed.');
    this.list();
    const hash = digest(plan);
    let rec = [...this.requests.values()].find(r => r.hash === hash && ['pending', 'approved'].includes(r.status));
    if (!rec) {
      if (this.requests.size >= this.limit) return response('approval_queue_full', 'Too many pending requests. Nothing was executed.');
      rec = { id: crypto.randomUUID(), status: 'pending', expiresAt: this.now() + this.ttl, hash, plan };
      this.requests.set(rec.id, rec); this.emit('requested', rec);
    }
    return response('approval_required', 'Nothing was executed. The owner must review this request locally; then call titian_resume with requestId.', {
      requestId: rec.id, state: rec.status, expiresAt: rec.expiresAt, operation: plan.operation,
      ownerCommand: `titian approvals ${this.policy.project} approve ${rec.id}`,
      execution: 'host', sandboxed: false,
    });
  }
  async resume(id, principal) {
    try {
      if (!this.ownerAvailable) throw new Error('Owner approval service is unavailable.');
      const rec = this.get(id);
      if (!principal || rec.plan.context.principal !== principal) throw new Error('Request is not owned by this authenticated client.');
      if (rec.status !== 'approved') throw new Error('Request is not approved or has already been consumed.');
      const current = this.policy.evaluate(rec.plan.request.name, rec.plan.request.arguments, principal);
      if (current.decision !== 'ask' || digest(current) !== rec.hash) {
        rec.status = 'invalidated'; throw new Error('Policy, target or process changed. Submit a new request.');
      }
      // Consume synchronously, BEFORE awaiting the executor: concurrent retries cannot replay.
      rec.status = 'consumed'; this.emit('consumed', rec);
      return await this.run(current);
    } catch (error) { return response('approval_rejected', error.message); }
  }
}

// This endpoint is never served on HTTP/MCP. OS account ownership is the trust
// boundary; it cannot isolate hostile code running as that same OS account.
async function ownerServer(socketPath, gate) {
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Owner socket path is too long; use a shorter TITIAN_DATA_DIR.');
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Owner socket directory must be owned by this account with mode 0700.');
  const server = net.createServer(socket => {
    socket.setEncoding('utf8'); socket.setTimeout(5000, () => socket.destroy());
    let buffer = '', handled = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16384) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        let result;
        if (message.action === 'policy') result = gate.policy.effective();
        else if (message.action === 'list') result = gate.list();
        else if (message.action === 'show') result = gate.view(message.requestId);
        else if (['approve', 'reject'].includes(message.action)) result = gate.ownerDecision(message.requestId, message.action, message.requestHash);
        else throw new Error('Unknown owner action.');
        socket.end(JSON.stringify({ result }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
    });
  });
  // Clean only stale sockets owned by this OS account, never a live endpoint/file.
  if (fs.existsSync(socketPath)) {
    const existing = fs.lstatSync(socketPath);
    if (!existing.isSocket() || existing.uid !== process.getuid()) throw new Error('Unsafe owner socket path.');
    const live = await new Promise(resolve => {
      const probe = net.createConnection(socketPath);
      probe.setTimeout(500, () => { probe.destroy(); resolve(true); });
      probe.on('connect', () => { probe.destroy(); resolve(true); });
      probe.on('error', e => resolve(e.code !== 'ECONNREFUSED'));
    });
    if (live) throw new Error('An owner endpoint is already running.');
    fs.unlinkSync(socketPath);
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600); gate.ownerAvailable = true;
  server.on('close', () => { gate.ownerAvailable = false; gate.requests.clear(); });
  server.on('error', () => { gate.ownerAvailable = false; });
  return server;
}
module.exports = { ApprovalGate, ownerServer, response };
