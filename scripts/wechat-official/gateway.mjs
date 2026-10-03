import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export const GATEWAY_CODES = Object.freeze([
  'WECHAT_LOCAL_INVALID', 'WECHAT_LOCAL_UNAUTHORIZED', 'WECHAT_LOCAL_ORIGIN',
  'WECHAT_LOCAL_HOST', 'WECHAT_LOCAL_METHOD', 'WECHAT_LOCAL_NOT_FOUND',
  'WECHAT_LOCAL_TOO_LARGE', 'WECHAT_LOCAL_CONFLICT', 'WECHAT_LOCAL_BUSY',
  'WECHAT_LOCAL_COOLDOWN', 'WECHAT_LOCAL_CAPACITY', 'WECHAT_LOCAL_STORAGE',
  'WECHAT_LOCAL_OFFLINE', 'WECHAT_LOCAL_REVOKED', 'WECHAT_LOCAL_UNSENT', 'WECHAT_LOCAL_PENDING',
  'WECHAT_LOCAL_STATUS', 'WECHAT_ACCEPTED', 'WECHAT_UNKNOWN', 'WECHAT_REJECTED',
  'WECHAT_SESSION_EXPIRED', 'WECHAT_CANCELLED',
]);
const codeSet = new Set(GATEWAY_CODES);
const receiptStates = new Set(['pending', 'accepted', 'unknown', 'rejected', 'unsent']);
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 16384;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const fault = (code) => Object.assign(new Error('本机微信通知网关操作未完成。'), { code });
const validLabel = (value) => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= 60 && !/[\u0000-\u001f\u007f]/.test(value);
function publicReceipt(value) {
  return { id: value.id, state: value.state, code: value.code, at: value.at,
    ...(value.state === 'unsent' ? { unsent: true } : {}) };
}
function safePayload(value, label) {
  if (!record(value) || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'title') || !Object.hasOwn(value, 'text')
    || typeof value.id !== 'string' || !idPattern.test(value.id) || typeof value.title !== 'string' || value.title.length > 100
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000
    || /[\u0000-\u001f\u007f]/.test(value.title)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text))
    throw fault('WECHAT_LOCAL_INVALID');
  const text = `[${label}]${value.title ? ` ${value.title}` : ''}\n${value.text}`;
  if (Buffer.byteLength(text, 'utf8') > 8192) throw fault('WECHAT_LOCAL_TOO_LARGE');
  return { id: value.id, hash: digest(JSON.stringify([value.title, value.text])), text };
}

/** A local capability gateway. Its caller supplies encrypted storage and the
 * sole WeChat sender; callers can never choose a recipient or provider URL.
 * Receipts contain hashes, never message bodies. Only proved-unsent requests
 * may be explicitly resubmitted; uncertain requests retain their IDs forever. */
export class WechatGateway {
  constructor({ storage, sendText, discoveryPath, publish = () => {}, now = Date.now,
    cooldownMs = 15000, maxQueue = 2, maxClients = 32, maxReceipts = 1024,
    sendTimeoutMs = 20000 }) {
    if (!storage?.read || !storage?.write || typeof sendText !== 'function'
      || typeof discoveryPath !== 'string' || !isAbsolute(discoveryPath)
      || !Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 8
      || !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 128
      || !Number.isInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 4096
      || !Number.isFinite(cooldownMs) || cooldownMs < 0
      || !Number.isFinite(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 30000)
      throw fault('WECHAT_LOCAL_INVALID');
    Object.assign(this, { storage, sendText, discoveryPath, publish, now,
      cooldownMs, maxQueue, maxClients, maxReceipts, sendTimeoutMs });
    this.saved = { version: 1, clients: [], receipts: [] };
    this.running = false; this.server = null; this.endpoint = '';
    this.queue = []; this.active = null; this.worker = null;
    this.writes = Promise.resolve(); this.lifecycle = Promise.resolve();
    this.lastSendAt = -Infinity; this.storageFault = false;
  }
  status() {
    return { running: this.running, endpoint: this.running ? this.endpoint : '',
      queued: this.queue.length, sending: Boolean(this.active),
      clients: this.saved.clients.map(({ id, label, revoked }) => ({ id, label, revoked })),
      receipts: this.saved.receipts.slice(-20).reverse().map((value) =>
        ({ clientId: value.clientId, ...publicReceipt(value) })),
      capacity: { clients: this.maxClients, receipts: this.maxReceipts },
      ...(this.storageFault ? { code: 'WECHAT_LOCAL_STORAGE' } : {}) };
  }
  emit() { try { Promise.resolve(this.publish(this.status())).catch(() => {}); } catch {} }
  mutate(operation) {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => {});
    return pending;
  }
  async commit(next) {
    try { await this.storage.write(clone(next)); }
    catch { this.storageFault = true; this.emit(); throw fault('WECHAT_LOCAL_STORAGE'); }
    this.saved = next;
  }
  validateSaved(value) {
    if (!record(value) || value.version !== 1 || !Array.isArray(value.clients)
      || !Array.isArray(value.receipts) || value.clients.length > this.maxClients
      || value.receipts.length > this.maxReceipts) throw fault('WECHAT_LOCAL_STORAGE');
    const ids = new Set(), hashes = new Set(), keys = new Set();
    const clients = value.clients.map((client) => {
      if (!record(client) || typeof client.id !== 'string' || !idPattern.test(client.id) || !validLabel(client.label)
        || !hashPattern.test(client.tokenHash) || typeof client.revoked !== 'boolean'
        || ids.has(client.id) || hashes.has(client.tokenHash)) throw fault('WECHAT_LOCAL_STORAGE');
      ids.add(client.id); hashes.add(client.tokenHash);
      return { id: client.id, label: client.label.trim(), tokenHash: client.tokenHash, revoked: client.revoked };
    });
    const receipts = value.receipts.map((receipt) => {
      const key = `${receipt?.clientId}/${receipt?.id}`;
      if (!record(receipt) || !ids.has(receipt.clientId) || typeof receipt.id !== 'string' || !idPattern.test(receipt.id)
        || !hashPattern.test(receipt.hash) || !receiptStates.has(receipt.state)
        || !codeSet.has(receipt.code) || typeof receipt.at !== 'string'
        || !Number.isFinite(Date.parse(receipt.at)) || keys.has(key)) throw fault('WECHAT_LOCAL_STORAGE');
      keys.add(key);
      return { clientId: receipt.clientId, id: receipt.id, hash: receipt.hash,
        state: receipt.state === 'pending' ? 'unknown' : receipt.state,
        code: receipt.state === 'pending' ? 'WECHAT_UNKNOWN' : receipt.code, at: receipt.at };
    });
    return { version: 1, clients, receipts };
  }
  start() {
    const pending = this.lifecycle.then(() => this.startNow());
    this.lifecycle = pending.catch(() => {});
    return pending;
  }
  async startNow() {
    if (this.running) return this.status();
    await this.writes;
    this.storageFault = false;
    let saved;
    try { saved = await this.storage.read(); }
    catch { throw fault('WECHAT_LOCAL_STORAGE'); }
    const recovered = saved ? this.validateSaved(saved) : { version: 1, clients: [], receipts: [] };
    await this.commit(recovered);
    const server = createServer((request, response) => { this.handle(request, response).catch(() => {
      this.respond(response, 500, { state: 'unknown', code: 'WECHAT_UNKNOWN' });
    }); });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
    server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    try {
      await new Promise((resolve, reject) => {
        const failed = () => reject(fault('WECHAT_LOCAL_OFFLINE'));
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
      });
      // Later errors are kept out of logs, which could otherwise echo URLs.
      server.on('error', () => {});
      this.server = server;
      this.endpoint = `http://127.0.0.1:${server.address().port}`;
      const temporary = `${this.discoveryPath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.discoveryPath), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ version: 1, endpoint: this.endpoint }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.discoveryPath);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.running = true; this.emit(); return this.status();
    } catch {
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      this.server = null; this.endpoint = ''; throw fault('WECHAT_LOCAL_OFFLINE');
    }
  }
  stop() {
    const pending = this.lifecycle.then(() => this.stopNow());
    this.lifecycle = pending.catch(() => {});
    return pending;
  }
  reset() {
    const pending = this.lifecycle.then(async () => {
      await this.stopNow();
      // Explicit binding removal invalidates every old capability. No ordinary
      // capacity management deletes receipts or their idempotency protection.
      await this.mutate(() => this.commit({ version: 1, clients: [], receipts: [] }));
      this.storageFault = false; this.emit(); return this.status();
    });
    this.lifecycle = pending.catch(() => {});
    return pending;
  }
  async stopNow() {
    this.running = false;
    // An admission may be awaiting its durable write when stop is requested.
    // Wait until it has installed its queue item before draining the queue.
    await this.writes;
    await rm(this.discoveryPath, { force: true }).catch(() => {});
    const waiting = this.queue.splice(0);
    for (const job of waiting) await this.finish(job, 'unsent', 'WECHAT_LOCAL_OFFLINE');
    this.active?.abort.abort();
    await this.worker;
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.server = null; this.endpoint = ''; this.emit();
  }
  async addClient(label) {
    if (!validLabel(label)) throw fault('WECHAT_LOCAL_INVALID');
    return this.mutate(async () => {
      if (!this.running) throw fault('WECHAT_LOCAL_OFFLINE');
      if (this.storageFault) throw fault('WECHAT_LOCAL_STORAGE');
      if (this.saved.clients.length >= this.maxClients) throw fault('WECHAT_LOCAL_CAPACITY');
      const token = randomBytes(32).toString('base64url'), clientId = randomUUID();
      const next = clone(this.saved);
      next.clients.push({ id: clientId, label: label.trim(), tokenHash: digest(token), revoked: false });
      await this.commit(next); this.emit();
      return { version: 1, kind: 'wechat-local-client', clientId, token, discoveryPath: this.discoveryPath };
    });
  }
  async revokeClient(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw fault('WECHAT_LOCAL_INVALID');
    await this.mutate(async () => {
      if (!this.running) throw fault('WECHAT_LOCAL_OFFLINE');
      if (this.storageFault) throw fault('WECHAT_LOCAL_STORAGE');
      const next = clone(this.saved), client = next.clients.find((value) => value.id === id);
      if (!client) throw fault('WECHAT_LOCAL_NOT_FOUND');
      client.revoked = true; await this.commit(next); this.emit();
    });
    if (this.active?.clientId === id) this.active.abort.abort();
    return this.status();
  }
  authenticate(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
      || request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1) return null;
    const candidate = Buffer.from(digest(authorization.slice(7)), 'hex');
    return this.saved.clients.find((client) => !client.revoked
      && timingSafeEqual(candidate, Buffer.from(client.tokenHash, 'hex'))) || null;
  }
  respond(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    response.end(JSON.stringify(body));
  }
  async readBody(request) {
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
      throw fault('WECHAT_LOCAL_TOO_LARGE');
    if (typeof request.headers['content-type'] !== 'string'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']))
      throw fault('WECHAT_LOCAL_INVALID');
    let length = 0; const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) throw fault('WECHAT_LOCAL_TOO_LARGE');
      chunks.push(chunk);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw fault('WECHAT_LOCAL_INVALID'); }
  }
  async handle(request, response) {
    const reject = (status, code) => this.respond(response, status, { state: 'unsent', code, unsent: true });
    if (!this.running) return reject(503, 'WECHAT_LOCAL_OFFLINE');
    if (Object.hasOwn(request.headers, 'origin')) return reject(403, 'WECHAT_LOCAL_ORIGIN');
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== this.endpoint.slice(7)
      || request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1)
      return reject(403, 'WECHAT_LOCAL_HOST');
    const client = this.authenticate(request);
    if (!client) return reject(401, 'WECHAT_LOCAL_UNAUTHORIZED');
    if (request.url === '/v1/status') {
      if (request.method !== 'GET') return reject(405, 'WECHAT_LOCAL_METHOD');
      return this.respond(response, 200, { state: 'status', code: 'WECHAT_LOCAL_STATUS',
        running: this.running, queued: this.queue.length, sending: Boolean(this.active),
        client: { id: client.id, label: client.label },
        receipts: this.saved.receipts.filter((value) => value.clientId === client.id).slice(-20).reverse().map(publicReceipt),
        capacity: { clients: this.maxClients, receipts: this.maxReceipts } });
    }
    if (request.url !== '/v1/notify') return reject(404, 'WECHAT_LOCAL_NOT_FOUND');
    if (request.method !== 'POST') return reject(405, 'WECHAT_LOCAL_METHOD');
    let payload;
    try { payload = safePayload(await this.readBody(request), client.label); }
    catch (error) { return reject(error.code === 'WECHAT_LOCAL_TOO_LARGE' ? 413 : 400,
      error.code === 'WECHAT_LOCAL_TOO_LARGE' ? error.code : 'WECHAT_LOCAL_INVALID'); }
    let admission;
    try { admission = await this.admit(client.id, payload); }
    catch (error) {
      const code = codeSet.has(error.code) ? error.code : 'WECHAT_LOCAL_STORAGE';
      return reject(code === 'WECHAT_LOCAL_CONFLICT' ? 409
        : ['WECHAT_LOCAL_BUSY', 'WECHAT_LOCAL_COOLDOWN', 'WECHAT_LOCAL_CAPACITY'].includes(code) ? 429
          : code === 'WECHAT_LOCAL_REVOKED' ? 401 : 503, code);
    }
    if (admission.receipt) return this.respond(response, admission.receipt.state === 'pending' ? 202 : 200, publicReceipt(admission.receipt));
    const receipt = await admission.completion;
    this.respond(response, receipt.state === 'unsent' ? 503 : 200, publicReceipt(receipt));
  }
  admit(clientId, payload) {
    return this.mutate(async () => {
      if (!this.running) throw fault('WECHAT_LOCAL_OFFLINE');
      if (this.storageFault) throw fault('WECHAT_LOCAL_STORAGE');
      const client = this.saved.clients.find((value) => value.id === clientId && !value.revoked);
      if (!client) throw fault('WECHAT_LOCAL_REVOKED');
      const previous = this.saved.receipts.find((value) => value.clientId === clientId && value.id === payload.id);
      if (previous && previous.hash !== payload.hash) throw fault('WECHAT_LOCAL_CONFLICT');
      if (previous && previous.state !== 'unsent') return { receipt: { ...previous } };
      if (this.now() - this.lastSendAt < this.cooldownMs) throw fault('WECHAT_LOCAL_COOLDOWN');
      if (this.queue.length >= this.maxQueue + (this.active ? 0 : 1)) throw fault('WECHAT_LOCAL_BUSY');
      if (!previous && this.saved.receipts.length >= this.maxReceipts) throw fault('WECHAT_LOCAL_CAPACITY');
      const receipt = { clientId, id: payload.id, hash: payload.hash,
        state: 'pending', code: 'WECHAT_LOCAL_PENDING', at: new Date(this.now()).toISOString() };
      const next = clone(this.saved);
      if (previous) next.receipts[next.receipts.findIndex((value) => value.clientId === clientId && value.id === payload.id)] = receipt;
      else next.receipts.push(receipt);
      await this.commit(next);
      let resolve;
      const completion = new Promise((done) => { resolve = done; });
      this.queue.push({ clientId, id: payload.id, text: payload.text, resolve, abort: new AbortController() });
      this.emit(); this.pump(); return { completion };
    });
  }
  pump() {
    if (this.worker || !this.running || !this.queue.length) return;
    this.worker = this.runQueue().finally(() => {
      this.worker = null; this.active = null; this.emit(); this.pump();
    });
  }
  async runQueue() {
    while (this.running && this.queue.length) {
      const job = this.queue.shift(); this.active = job; this.emit();
      if (!this.saved.clients.some((client) => client.id === job.clientId && !client.revoked)) {
        await this.finish(job, 'unsent', 'WECHAT_LOCAL_REVOKED'); this.active = null; continue;
      }
      if (this.storageFault) {
        await this.finish(job, 'unsent', 'WECHAT_LOCAL_STORAGE'); this.active = null; continue;
      }
      if (this.now() - this.lastSendAt < this.cooldownMs) {
        await this.finish(job, 'unsent', 'WECHAT_LOCAL_COOLDOWN'); this.active = null; continue;
      }
      // Pending is already durable. From this point cancellation can be uncertain.
      this.lastSendAt = this.now();
      let timer, onAbort;
      const interrupted = new Promise((_resolve, reject) => {
        onAbort = () => reject(fault('WECHAT_UNKNOWN'));
        job.abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => job.abort.abort(), this.sendTimeoutMs);
      });
      let settled = false;
      const transport = Promise.resolve().then(() => this.sendText(job.text, { signal: job.abort.signal }))
        .finally(() => { settled = true; });
      transport.catch(() => {});
      try {
        const result = await Promise.race([transport, interrupted]);
        await this.finish(job, result?.confirmation === 'accepted' ? 'accepted' : 'unknown',
          result?.confirmation === 'accepted' ? 'WECHAT_ACCEPTED' : 'WECHAT_UNKNOWN');
      } catch (error) {
        if (error?.unsent === true) {
          // The trusted adapter guarantees no provider request was made.
          await this.finish(job, 'unsent', codeSet.has(error.code) ? error.code : 'WECHAT_LOCAL_UNSENT');
          this.lastSendAt = -Infinity;
        } else if (['WECHAT_REJECTED', 'WECHAT_SESSION_EXPIRED'].includes(error?.code)) {
          await this.finish(job, 'rejected', error.code);
        } else await this.finish(job, 'unknown', 'WECHAT_UNKNOWN');
      } finally {
        clearTimeout(timer); job.abort.signal.removeEventListener('abort', onAbort);
        job.text = ''; if (settled || !this.running) this.active = null; this.emit();
      }
      // A non-cooperative timed-out sender may still be running. Do not start
      // another send concurrently, but allow stop() to settle without waiting.
      if (!settled && this.running) {
        await Promise.race([transport.catch(() => {}), new Promise((resolve) => {
          const stopCheck = setInterval(() => { if (!this.running) { clearInterval(stopCheck); resolve(); } }, 25);
          transport.finally(() => { clearInterval(stopCheck); resolve(); }).catch(() => {});
        })]);
      }
      this.active = null; this.emit();
    }
  }
  async finish(job, state, code) {
    let finalReceipt;
    await this.mutate(async () => {
      const next = clone(this.saved);
      const receipt = next.receipts.find((value) => value.clientId === job.clientId && value.id === job.id);
      if (!receipt) throw fault('WECHAT_LOCAL_STORAGE');
      receipt.state = state; receipt.code = code;
      try { await this.commit(next); finalReceipt = receipt; }
      catch {
        // Keep a conservative in-memory result; the durable pending receipt is
        // recovered as unknown after restart. Never retry an uncertain send.
        receipt.state = state === 'unsent' ? 'unsent' : 'unknown';
        receipt.code = 'WECHAT_LOCAL_STORAGE'; this.saved = next; finalReceipt = receipt;
      }
      this.emit();
    });
    job.resolve(finalReceipt); return finalReceipt;
  }
}
