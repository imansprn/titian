#!/usr/bin/env node
'use strict';
/**
 * dc-wrapper.js — runs desktop-commander in a DETACHED process group, so the
 * parent (the HTTP bridge) can cleanly kill the entire tree (npx + node) on
 * shutdown. Without this, child.kill() only kills the direct child, leaving
 * orphaned desktop-commander processes.
 *
 * Set DESKTOP_COMMANDER_BIN to a globally installed `desktop-commander` binary
 * to skip npx; otherwise `npx -y @wonderwhy-er/desktop-commander` is used.
 */
const { spawn } = require('child_process');

const bin = process.env.DESKTOP_COMMANDER_BIN;
const [cmd, args] = bin
  ? [bin, ['--no-onboarding']]
  : ['npx', ['-y', '@wonderwhy-er/desktop-commander', '--no-onboarding']];

const child = spawn(cmd, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

// Bridge stdio between the parent and desktop-commander.
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

// Swallow EPIPE / stream errors so a dead parent doesn't crash the wrapper.
for (const s of [process.stdin, process.stdout, process.stderr]) {
  s.on('error', () => {});
}

let cleaned = false;
function killGroup(sig) {
  try { process.kill(-child.pid, sig); } catch (_) { /* already gone */ }
}
function shutdown() {
  if (cleaned) return;
  cleaned = true;
  killGroup('SIGTERM');
  // Keep the timer REFERENCED (no .unref) so SIGKILL is guaranteed to fire even
  // if the wrapper is otherwise idle. Previously .unref() let the process exit
  // and cancel the SIGKILL, leaking desktop-commander processes on every session.
  setTimeout(() => killGroup('SIGKILL'), 1500);
}

['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((sig) => process.on(sig, shutdown));
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);

child.on('exit', (code, signal) => {
  process.exit(signal ? 0 : (code === null ? 0 : code));
});
