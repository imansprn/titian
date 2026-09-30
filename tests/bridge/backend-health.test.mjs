import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const signal of ['SIGTERM', 'SIGSTOP']) {
  it(`detects backend ${signal} and exits for supervisor recovery`, { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'titian-health-'));
    const pidFile = join(dir, 'pid');
    const proc = spawn(process.execPath, [fileURLToPath(new URL('../../src/bridge/server.mjs', import.meta.url))], {
      env: { ...process.env, MCP_BRIDGE_PORT: '0', MCP_STDIO_WRAPPER: fileURLToPath(new URL('./fixtures/fake-stdio-server.mjs', import.meta.url)), TEST_BACKEND_PID_FILE: pidFile },
      stdio: ['ignore','ignore','pipe'],
    });
    let output = ''; proc.stderr.on('data', chunk => { output += chunk; });
    let backend;
    try {
      const limit = Date.now()+8000;
      while (!output.includes('listening on')) {
        if (Date.now()>limit || proc.exitCode!==null) throw new Error(output);
        await new Promise(r=>setTimeout(r,25));
      }
      backend = Number(readFileSync(pidFile,'utf8'));
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)[1];
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
      const exit = once(proc,'exit');
      process.kill(backend,signal);
      if (signal==='SIGSTOP') {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(response.status,503);
        assert.equal(await response.text(),'backend unavailable');
      }
      const [code] = await exit;
      assert.equal(code,1);
    } finally {
      if (backend) { try { process.kill(backend,'SIGKILL'); } catch {} }
      if (proc.exitCode===null) { proc.kill('SIGKILL'); await once(proc,'exit'); }
      rmSync(dir,{recursive:true,force:true});
    }
  });
}
