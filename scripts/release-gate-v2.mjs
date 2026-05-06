#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const host = '127.0.0.1';
const tempRoot = process.env.CORTEX_RELEASE_TMPDIR || (process.platform === 'win32' ? os.tmpdir() : '/tmp');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ...options.env,
      },
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`));
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate release gate port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v2/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for release gate server health: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function startServer({ port, dbPath }) {
  return spawn('pnpm', ['--dir', 'packages/server', 'exec', 'tsx', 'src/index.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
      CORTEX_HOST: host,
      CORTEX_PORT: String(port),
      CORTEX_DB_PATH: dbPath,
      CORTEX_LLM_EXTRACTION_PROVIDER: 'none',
      CORTEX_LLM_LIFECYCLE_PROVIDER: 'none',
      CORTEX_EMBEDDING_PROVIDER: 'none',
    },
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runMain() {
  log('Cortex V2.0 release gate: server test');
  await run('pnpm', ['--dir', 'packages/server', 'test']);
  log('Cortex V2.0 release gate: server lint');
  await run('pnpm', ['--dir', 'packages/server', 'lint']);
  log('Cortex V2.0 release gate: server build');
  await run('pnpm', ['--dir', 'packages/server', 'build']);
  log('Cortex V2.0 release gate: dashboard test');
  await run('pnpm', ['--dir', 'packages/dashboard', 'test']);
  log('Cortex V2.0 release gate: dashboard build');
  await run('pnpm', ['--dir', 'packages/dashboard', 'build']);

  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'cortex-release-gate-v2-'));
  const dbPath = path.join(tempDir, 'brain.db');
  const port = await getFreePort();
  const baseUrl = `http://${host}:${port}`;
  const server = startServer({ port, dbPath });

  try {
    log(`Cortex V2.0 release gate: starting temp server at ${baseUrl}`);
    await waitForHealth(baseUrl);
    log('Cortex V2.0 release gate: smoke:v2');
    await run('pnpm', ['smoke:v2'], {
      env: {
        CORTEX_BASE_URL: baseUrl,
        SMOKE_ROUNDS: process.env.SMOKE_ROUNDS || '3',
      },
    });
    log('Cortex V2.0 release gate: recall-eval:v2');
    await run('pnpm', ['recall-eval:v2'], {
      env: {
        CORTEX_BASE_URL: baseUrl,
        RECALL_EVAL_ROUNDS: process.env.RECALL_EVAL_ROUNDS || '3',
      },
    });
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  log('Cortex V2.0 release gate passed.');
}

runMain().catch((error) => {
  process.stderr.write(`Cortex V2.0 release gate failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
