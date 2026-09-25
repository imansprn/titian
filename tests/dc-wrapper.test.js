'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const WRAPPER = path.join(__dirname, '..', 'dc-wrapper.js');

// Fake desktop-commander: records its argv and pids, spawns a grandchild in the
// same process group, then echoes stdin to stdout (or exits early if asked).
const FAKE_SOURCE = `#!${process.execPath}
const fs = require('fs');
const { spawn } = require('child_process');
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.FAKE_INFO, JSON.stringify({ args: process.argv.slice(2), pid: process.pid, grandchild: grandchild.pid }));
process.stdin.pipe(process.stdout);
`;

let dir, fakeBin;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titian-wrapper-'));
  fakeBin = path.join(dir, 'fake-desktop-commander');
  fs.writeFileSync(fakeBin, FAKE_SOURCE, { mode: 0o755 });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

function startWrapper(extraEnv = {}) {
  const info = path.join(dir, `info-${Date.now()}-${Math.random()}.json`);
  const child = spawn(process.execPath, [WRAPPER], {
    env: { ...process.env, DESKTOP_COMMANDER_BIN: fakeBin, FAKE_INFO: info, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const readInfo = async () => {
    assert.ok(await waitFor(() => fs.existsSync(info) && fs.statSync(info).size > 0), 'fake did not start');
    return JSON.parse(fs.readFileSync(info, 'utf8'));
  };
  return { child, exited, readInfo };
}

describe('dc-wrapper', () => {
  it('passes --no-onboarding and pipes stdio both ways', async () => {
    const { child, exited, readInfo } = startWrapper();
    const info = await readInfo();
    assert.deepEqual(info.args, ['--no-onboarding']);

    child.stdin.write('{"jsonrpc":"2.0"}\n');
    const [chunk] = await once(child.stdout, 'data');
    assert.equal(chunk.toString(), '{"jsonrpc":"2.0"}\n');

    child.stdin.end();
    await exited;
  });

  it('kills the whole process group when stdin closes', async () => {
    const { child, exited, readInfo } = startWrapper();
    const { pid, grandchild } = await readInfo();
    assert.ok(isAlive(pid) && isAlive(grandchild));

    child.stdin.end();
    await exited;
    assert.ok(await waitFor(() => !isAlive(pid) && !isAlive(grandchild)), 'desktop-commander tree leaked');
  });

  it('kills the whole process group on SIGTERM', async () => {
    const { child, exited, readInfo } = startWrapper();
    const { pid, grandchild } = await readInfo();

    child.kill('SIGTERM');
    await exited;
    assert.ok(await waitFor(() => !isAlive(pid) && !isAlive(grandchild)), 'desktop-commander tree leaked');
  });

  it('propagates the child exit code', async () => {
    const { exited } = startWrapper({ FAKE_EXIT: '3' });
    const [code] = await exited;
    assert.equal(code, 3);
  });
});
