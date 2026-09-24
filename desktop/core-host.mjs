// Core host adapter: prefer running the Node core in-process when the
// Electron-bundled Node provides node:sqlite; otherwise fall back to a
// sidecar worker spawned with the system Node 24 (the same runtime the
// Windows scheduled tasks use). Callers only see coreRequest(op, args).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(directory, '..');
let desktopPresenter = null;

export function setDesktopPresenter(presenter) { desktopPresenter = presenter; }

async function detectSqlite() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return Boolean(DatabaseSync);
  } catch {
    return false;
  }
}

async function createInProcessHandler() {
  const { runCoreOperation } = await import('./core-operations.mjs');
  return {
    status: () => ({ mode: 'in-process', platform: process.platform }),
    request: (op, args) => runCoreOperation(op, args, { desktop: desktopPresenter }),
  };
}

async function createSidecarHandler() {
  let child = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map();

  function ensureWorker() {
    if (child) return ready;
    const runtime = app.isPackaged
      ? join(process.resourcesPath, 'vendor-node', process.platform === 'win32' ? 'node.exe' : 'node')
      : process.env.CODEX_RESET_MONITOR_NODE_PATH || 'node';
    child = spawn(runtime, [join(directory, 'core-worker.mjs')], {
      cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const worker = child;
    ready = new Promise((resolveReady, rejectReady) => {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === 'ready') resolveReady();
          else if (message.type === 'desktop') {
            Promise.resolve().then(() => desktopPresenter(message.payload)).then(
              () => child?.stdin.write(`${JSON.stringify({ type: 'desktop-result', eventId: message.eventId, ok: true })}\n`),
              (error) => child?.stdin.write(`${JSON.stringify({ type: 'desktop-result', eventId: message.eventId,
                ok: false, error: error.message })}\n`),
            );
          }
          else if (message.type === 'result' && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.ok) resolve(message.result);
            else reject(new Error(message.error));
          }
        }
      });
      child.stderr.on('data', (chunk) => { console.error('[core-worker]', chunk.toString()); });
      const failWorker = (error) => {
        for (const { reject } of pending.values()) reject(error);
        pending.clear();
        if (child === worker) { child = null; ready = null; }
        rejectReady(error);
      };
      worker.once('error', (error) => failWorker(new Error(`无法启动 core worker：${error.message}`)));
      worker.once('exit', (code) => {
        if (child === worker) failWorker(new Error(`core worker 提前退出，代码 ${code}`));
      });
    });
    return ready;
  }

  return {
    status: () => ({ mode: 'sidecar', platform: process.platform }),
    async request(op, args = {}) {
      await ensureWorker();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
      });
    },
  };
}

let handlerPromise = null;

async function createHandler() {
  const mode = process.env.CODEX_RESET_MONITOR_CORE_MODE; // sidecar | in-process | auto
  if (mode === 'in-process') return createInProcessHandler();
  if (mode === 'sidecar') return createSidecarHandler();
  return (await detectSqlite()) ? createInProcessHandler() : createSidecarHandler();
}

export function coreRequest(op, args) {
  if (!handlerPromise) handlerPromise = createHandler();
  return handlerPromise.then((handler) => handler.request(op, args));
}

export function coreStatus() {
  if (!handlerPromise) handlerPromise = createHandler();
  return handlerPromise.then((handler) => handler.status());
}
