// 登录凭据只在主进程和 Codex 子进程中使用；持久文件经系统密钥加密。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createCodexSession } from './codex-session.mjs';

const digest = (scope, value) => value ? createHash('sha256').update(`${scope}\0${value}`).digest('hex') : null;
export function identityMatches(binding, response) {
  if (response?.account?.type !== 'chatgpt') return false;
  const email = response.account.email?.trim().toLowerCase();
  const workspace = response.workspaceRouting?.chatgptAccountId?.trim();
  return binding.workspaceHash ? Boolean(workspace && digest(binding.scopeId, workspace) === binding.workspaceHash)
    : Boolean(email && digest(binding.scopeId, email) === binding.emailHash);
}

export function createAccountSessions({ directory, crypto, createSession = createCodexSession,
  sourceHome = process.env.CODEX_RESET_MONITOR_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex'), openLogin = async () => {},
  onChanged = () => {}, loginTimeoutMs = 10 * 60_000 } = {}) {
  const root = resolve(directory, 'accounts');
  const vault = join(root, 'credentials');
  const runtime = join(root, 'runtime');
  const queues = new Map();
  let login = null;
  let publicLogin = { state: 'idle' };
  let stopped = false;
  const secure = () => crypto.isEncryptionAvailable()
    && (!crypto.getSelectedStorageBackend || crypto.getSelectedStorageBackend() !== 'basic_text');
  const validateScope = (scopeId) => {
    if (typeof scopeId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(scopeId)) throw new Error('账号编号无效');
    return join(vault, `${scopeId}.bin`);
  };
  async function removeRuntime(path) {
    const target = resolve(path);
    if (!target.startsWith(`${runtime}${sep}`)) throw new Error('账号临时目录无效');
    await rm(target, { recursive: true, force: true });
  }
  async function initialize() {
    await mkdir(vault, { recursive: true, mode: 0o700 });
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(runtime)) await removeRuntime(join(runtime, entry));
  }
  const initialized = initialize();
  function enqueue(scopeId, run) {
    const previous = queues.get(scopeId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await initialized;
      if (stopped) throw new Error('账号服务已停止');
      return run();
    });
    queues.set(scopeId, next);
    next.finally(() => { if (queues.get(scopeId) === next) queues.delete(scopeId); }).catch(() => {});
    return next;
  }
  async function persist(scopeId, home, sourceHash = null) {
    if (!secure()) throw new Error('系统凭据保护不可用，请解锁系统钥匙串后重新登录');
    let auth;
    try { auth = await readFile(join(home, 'auth.json'), 'utf8'); JSON.parse(auth); }
    catch { throw new Error('未获得可保存的登录会话，请重新登录此账号'); }
    const path = validateScope(scopeId);
    const encrypted = crypto.encryptString(JSON.stringify({ version: 1, scopeId, auth, sourceHash }));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, encrypted, { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async function withHome(script, auth, run) {
    const home = await mkdtemp(join(runtime, 'session-'));
    let session;
    try {
      if (auth) await writeFile(join(home, 'auth.json'), auth, { mode: 0o600 });
      session = createSession(script, { home });
      return await run(session, home);
    } finally { await session?.close(); await removeRuntime(home); }
  }
  async function has(scopeId) {
    await initialized;
    try { await readFile(validateScope(scopeId)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw new Error('无法读取账号登录会话'); }
  }
  async function request({ scopeId, script, method, params }) {
    if (!scopeId) {
      const session = createSession(script, { home: sourceHome, managed: false });
      try { return await session.request(method, params); } finally { await session.close(); }
    }
    return enqueue(scopeId, async () => {
      if (!secure()) throw new Error('系统凭据保护不可用，账号缓存仍可查看');
      let saved;
      try { saved = JSON.parse(crypto.decryptString(await readFile(validateScope(scopeId)))); }
      catch { throw new Error('此账号需要重新登录，卡片与记录已保留'); }
      if (saved.version !== 1 || saved.scopeId !== scopeId) throw new Error('账号登录会话不匹配，请重新登录');
      return withHome(script, saved.auth, async (session, home) => {
        const result = await session.request(method, params);
        // OAuth 可能刷新凭据，成功后保存新值，下次启动继续使用。
        await persist(scopeId, home, saved.sourceHash || null);
        return result;
      });
    });
  }
  async function capture({ binding, script }) {
    return enqueue(binding.scopeId, async () => {
      if (!secure()) return { saved: false, reason: 'secure_storage_unavailable' };
      let auth;
      try { auth = await readFile(join(sourceHome, 'auth.json'), 'utf8'); JSON.parse(auth); }
      catch { return { saved: false, reason: 'login_required' }; }
      const sourceHash = createHash('sha256').update(auth).digest('hex');
      try {
        const saved = JSON.parse(crypto.decryptString(await readFile(validateScope(binding.scopeId))));
        if (saved.scopeId === binding.scopeId && saved.sourceHash === sourceHash) return { saved: true };
      } catch { /* 新账号或会话损坏时重新验证源登录。 */ }
      return withHome(script, auth, async (session, home) => {
        if (!identityMatches(binding, await session.request('account/read', {})))
          throw new Error('Codex 登录已变化，请重新获取当前账号');
        await persist(binding.scopeId, home, sourceHash);
        return { saved: true };
      });
    });
  }
  async function cleanupLogin(record) {
    clearTimeout(record.timer);
    await record.session.close(); await removeRuntime(record.home);
    if (login === record) login = null;
  }
  async function cancelLogin() {
    const record = login;
    if (!record) return;
    record.cancelled = true;
    await cleanupLogin(record);
    publicLogin = { state: 'idle' }; onChanged();
  }
  async function startLogin({ script, expectedScopeId = null, onComplete }) {
    await initialized;
    if (!secure()) throw new Error('系统凭据保护不可用，请解锁系统钥匙串后再添加账号');
    if (login) throw new Error('已有账号正在登录，请完成或取消后再试');
    const home = await mkdtemp(join(runtime, 'login-'));
    const token = randomUUID();
    const record = { home, token, expectedScopeId, cancelled: false, completing: false, session: null, timer: null };
    login = record;
    const failLogin = async () => {
      if (login !== record || record.cancelled || record.completing) return;
      record.cancelled = true; await cleanupLogin(record);
      publicLogin = { state: 'failed', message: '登录未完成，请重试' }; onChanged();
    };
    record.session = createSession(script, { home, onExit: () => { failLogin().catch(() => {}); },
      onNotification: (method, params) => {
        if (method !== 'account/login/completed' || record.cancelled || record.completing) return;
        if (!params?.success) { failLogin().catch(() => {}); return; }
        record.completing = true;
        Promise.resolve().then(() => onComplete({ loginToken: token, expectedScopeId })).then(() => {
          publicLogin = { state: 'complete' };
        }, () => { publicLogin = { state: 'failed', message: '登录账号不匹配或会话未保存，请重试' }; })
          .finally(async () => { await cleanupLogin(record); onChanged(); });
      } });
    record.timer = setTimeout(() => { failLogin().catch(() => {}); }, loginTimeoutMs);
    try {
      const result = await record.session.request('account/login/start', { type: 'chatgpt' });
      const url = new URL(result.authUrl);
      if (result.type !== 'chatgpt' || url.protocol !== 'https:'
        || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname))
        throw new Error('Codex 登录地址无效');
      publicLogin = { state: 'waiting', scopeId: expectedScopeId }; onChanged();
      await openLogin(url.href);
      return { state: 'waiting' };
    } catch { await failLogin(); throw new Error('无法打开账号登录，请重试'); }
  }
  async function loginRequest({ loginToken, script, binding }) {
    const record = login;
    if (!record || record.token !== loginToken || record.cancelled) throw new Error('登录会话已结束');
    const response = await record.session.request('account/read', {});
    if (binding) {
      if (!identityMatches(binding, response)) throw new Error('登录的账号与所选账号不匹配');
      await enqueue(binding.scopeId, () => persist(binding.scopeId, record.home));
    }
    return response;
  }
  return { has, request, capture, startLogin, cancelLogin, loginRequest,
    status: () => ({ ...publicLogin, secureStorage: secure() }),
    async close() { stopped = true; await cancelLogin(); await Promise.allSettled([...queues.values()]); } };
}
