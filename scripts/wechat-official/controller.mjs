import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL, safeWechatBaseUrl } from './client.mjs';
import { safeProbeDiagnostics } from './storage.mjs';

export const SYNTHETIC_TEXT = '模拟到期提醒\n账号：模拟账号\n卡片：模拟重置卡\n到期：模拟到期\n此消息仅用于微信直连验证，不含真实 Codex 资料。';
const errorText = {
  WECHAT_CONFIGURATION: '微信测试连接配置无效，请重新扫码。',
  WECHAT_REJECTED: '微信拒绝此测试请求，请核对连接和会话状态。',
  WECHAT_SESSION_EXPIRED: '微信测试连接已失效，请清除测试连接后重新扫码。',
  WECHAT_HTTP: '微信接口请求失败，请稍后重试。',
  WECHAT_PROTOCOL: '微信接口返回格式不符合预期，未确认成功。',
  WECHAT_NETWORK: '无法连接微信接口，请核对当前网络。',
  WECHAT_TIMEOUT: '微信接口等待超时，请稍后重试。',
  WECHAT_CANCELLED: '测试已取消。',
  WECHAT_UNKNOWN: '发送结果未知，已停止补发，请先查看手机微信。',
};
function problem(message, code = 'PROBE_STATE') { return Object.assign(new Error(message), { code }); }
export function probeErrorMessage(error) {
  return errorText[error?.code] || (error?.code === 'PROBE_STATE' ? error.message : '验证工具操作失败，请稍后重试。');
}
const iso = (value) => new Date(value).toISOString();
function publicTestRecord(test) {
  return { id: test.id, label: test.label, at: test.at, confirmation: test.confirmation,
    ...(typeof test.code === 'string' && Object.hasOwn(errorText, test.code) ? { code: test.code } : {}),
    ...(typeof test.contextAgeMinutes === 'number' ? { contextAgeMinutes: test.contextAgeMinutes } : {}),
    ...safeProbeDiagnostics(test),
  };
}
function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class WechatProbe {
  constructor({ client, storage, renderQr, publish = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, cooldownMs = 15000 }) {
    Object.assign(this, { client, storage, renderQr, publish, now, setTimer, clearTimer, cooldownMs });
    this.phase = 'idle'; this.message = '点击“扫码绑定”开始微信官方直连验证。';
    this.session = null; this.contextToken = ''; this.contextAt = null; this.cursor = '';
    this.tests = []; this.busy = false; this.listening = false; this.qrDataUrl = '';
    this.loginAttempt = null; this.scheduled = null; this.scheduleTimer = null;
    this.listenAbort = null; this.sendAbort = null; this.generation = 0;
    this.closed = false; this.lastSendAt = -Infinity;
  }
  status() {
    return { phase: this.phase, message: this.message, busy: this.busy,
      bound: Boolean(this.session) && this.phase !== 'expired',
      hasContext: Boolean(this.contextToken), contextAt: this.contextAt,
      qrDataUrl: this.qrDataUrl, listening: this.listening,
      scheduled: this.scheduled ? { at: iso(this.scheduled.at) } : null,
      tests: this.tests.map(publicTestRecord),
    };
  }
  async emit() {
    const status = this.status();
    this.publish(status);
    await this.storage.writeStatus?.(status);
  }
  async persist() {
    await this.storage.write({ version: 1, session: this.session, contextToken: this.contextToken,
      contextAt: this.contextAt, cursor: this.cursor, tests: this.tests.map(publicTestRecord) });
  }
  available() {
    if (this.closed) throw problem('验证工具已退出。');
    if (this.busy) throw problem('操作进行中，请稍后重试。');
  }
  async initialize() {
    const saved = await this.storage.read();
    if (saved?.session) {
      const { token, userId, baseUrl } = saved.session;
      if (typeof token !== 'string' || !token || typeof userId !== 'string' || !userId)
        throw problem('保存的测试连接无效，请清除后重新扫码。');
      this.session = { token, userId, baseUrl: safeWechatBaseUrl(baseUrl) };
      this.contextToken = typeof saved.contextToken === 'string' ? saved.contextToken : '';
      this.contextAt = Number.isFinite(Date.parse(saved.contextAt)) ? saved.contextAt : null;
      this.cursor = typeof saved.cursor === 'string' ? saved.cursor : '';
      this.phase = 'bound'; this.message = '已恢复测试连接；不会恢复上次关闭时的定时发送。';
    }
    this.tests = Array.isArray(saved?.tests) ? saved.tests.slice(0, 12).map((test) => publicTestRecord({
      ...test,
      confirmation: test.confirmation === 'pending' ? 'unknown' : test.confirmation,
    })) : [];
    await this.emit();
    if (this.session) this.startListening();
  }
  async login() {
    this.available();
    if (this.session) throw problem('已有测试连接；更换微信前请先清除测试连接。');
    if (this.loginAttempt) throw problem('扫码连接进行中，请使用当前二维码。');
    this.busy = true; this.phase = 'login'; this.message = '正在获取微信官方授权二维码。';
    const attempt = { abort: new AbortController(), baseUrl: DEFAULT_BASE_URL,
      startedAt: this.now(), verifyCode: '', generation: ++this.generation };
    this.loginAttempt = attempt;
    await this.emit();
    try {
      const qr = await this.client.requestQr({ signal: attempt.abort.signal });
      if (attempt.abort.signal.aborted || this.closed) return;
      attempt.qrcode = qr.qrcode;
      this.qrDataUrl = await this.renderQr(qr.qrcode_img_content);
      this.message = '用手机微信扫描二维码并确认授权。';
      this.busy = false; await this.emit();
      this.pollLogin(attempt).catch(() => {});
    } catch (error) {
      this.phase = 'error'; this.message = probeErrorMessage(error);
      this.loginAttempt = null; this.qrDataUrl = ''; throw error;
    } finally { this.busy = false; await this.emit(); }
  }
  async pollLogin(attempt) {
    let redirects = 0;
    try {
      while (!this.closed && this.loginAttempt === attempt && !attempt.abort.signal.aborted) {
        if (this.now() - attempt.startedAt >= 5 * 60000) {
          this.phase = 'idle'; this.message = '二维码已过期，请重新扫码绑定。'; break;
        }
        const response = await this.client.pollQr(attempt.qrcode, {
          baseUrl: attempt.baseUrl, verifyCode: attempt.verifyCode || undefined, signal: attempt.abort.signal,
        });
        if (this.closed || this.loginAttempt !== attempt || attempt.abort.signal.aborted) return;
        if (response.status === 'confirmed') {
          this.busy = true;
          this.session = { token: response.bot_token, userId: response.ilink_user_id,
            baseUrl: safeWechatBaseUrl(response.baseurl || attempt.baseUrl) };
          this.cursor = ''; this.contextToken = ''; this.contextAt = null;
          this.phase = 'bound'; this.message = '扫码绑定成功；请在微信 ClawBot 中发送“验证”。';
          this.qrDataUrl = '';
          try {
            await this.persist();
            if (this.closed || this.loginAttempt !== attempt || attempt.abort.signal.aborted) return;
            this.startListening();
          } catch (error) {
            this.session = null; this.phase = 'error'; throw error;
          } finally { this.busy = false; await this.emit(); }
          return;
        }
        if (response.status === 'need_verifycode') {
          this.phase = 'verify';
          this.message = attempt.verifyCode ? '验证码未通过，请重新输入手机显示的数字。' : '请输入手机微信显示的配对数字。';
          attempt.verifyCode = '';
        } else if (response.status === 'scaned') {
          this.phase = 'login'; this.message = '已扫码，等待微信确认授权。'; attempt.verifyCode = '';
        } else if (response.status === 'scaned_but_redirect') {
          if (++redirects > 3) throw problem('微信授权跳转次数过多，请稍后重新扫码。');
          attempt.baseUrl = response.redirectBaseUrl || safeWechatBaseUrl(`https://${response.redirect_host}`);
        } else if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(response.status)) {
          this.phase = 'idle';
          this.message = response.status === 'binded_redirect'
            ? '微信已有绑定，但此验证工具没有该凭据；请在微信核对绑定后重试。'
            : '二维码过期或验证被限制，请稍后重新扫码。'; break;
        }
        await this.emit();
        await delay(this.phase === 'verify' ? 1500 : 1000, attempt.abort.signal);
      }
    } catch (error) {
      if (!attempt.abort.signal.aborted && !this.closed) {
        this.phase = 'error'; this.message = probeErrorMessage(error);
      }
    } finally {
      if (this.loginAttempt === attempt) { this.loginAttempt = null; this.qrDataUrl = ''; await this.emit(); }
    }
  }
  async verifyCode(code) {
    this.available();
    if (this.phase !== 'verify' || !this.loginAttempt) throw problem('当前无需输入配对数字。');
    if (typeof code !== 'string' || !/^\d{1,10}$/.test(code)) throw problem('请输入手机显示的配对数字。');
    this.loginAttempt.verifyCode = code;
    this.message = '配对数字已提交，等待微信确认。'; await this.emit();
  }
  startListening() {
    this.listenAbort?.abort();
    const session = this.session, generation = this.generation;
    const abort = new AbortController(); this.listenAbort = abort;
    this.listening = true;
    const current = () => !this.closed && !abort.signal.aborted && this.session === session && this.generation === generation;
    (async () => {
      try {
        try { await this.client.notify?.(session, 'start', { signal: abort.signal }); }
        catch (error) {
          if (error.code === 'WECHAT_SESSION_EXPIRED') {
            this.phase = 'expired'; this.message = probeErrorMessage(error); return;
          }
          // Optional lifecycle notification failures do not stop message polling.
        }
        let failures = 0;
        while (current()) {
          try {
            const response = await this.client.getUpdates(session, { cursor: this.cursor, signal: abort.signal });
            if (!current()) break;
            failures = 0;
            let changed = false;
            for (const message of response.msgs) {
              // Bind to the scanning user only. Ignore other senders and media.
              if (message.from_user_id !== session.userId || message.message_type !== 1
                || typeof message.context_token !== 'string' || !message.context_token) continue;
              this.contextToken = message.context_token; this.contextAt = iso(this.now()); changed = true;
            }
            if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) {
              changed ||= response.get_updates_buf !== this.cursor;
              this.cursor = response.get_updates_buf;
            }
            if (changed) {
              await this.persist();
              this.message = '已建立微信会话，可以发送模拟提醒。';
              await this.emit();
            }
            await delay(500, abort.signal);
          } catch (error) {
            if (!current()) break;
            if (error.code === 'WECHAT_SESSION_EXPIRED') {
              this.phase = 'expired'; this.message = probeErrorMessage(error);
              await this.cancelSchedule(); break;
            }
            this.message = probeErrorMessage(error); await this.emit();
            await delay(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)), abort.signal);
          }
        }
      } catch (error) {
        if (current()) { this.message = probeErrorMessage(error); await this.emit(); }
      } finally {
        if (this.listenAbort === abort) { this.listening = false; await this.emit(); }
      }
    })().catch(() => {});
  }
  async send({ omitContext = false, captured = null, label = '' } = {}) {
    this.available();
    if (!this.session || this.phase === 'expired') throw problem('请先扫码绑定微信。');
    if (typeof omitContext !== 'boolean') throw problem('测试参数无效。');
    const contextToken = omitContext ? undefined : (captured ? captured.token : this.contextToken);
    const contextAt = omitContext ? null : (captured ? captured.at : this.contextAt);
    if (!omitContext && !contextToken) throw problem('请先在微信 ClawBot 中发送“验证”。');
    if (this.now() - this.lastSendAt < this.cooldownMs) throw problem('请间隔 15 秒再发下一条测试。');
    this.lastSendAt = this.now(); this.busy = true;
    const generation = this.generation, session = this.session;
    const test = { id: randomUUID(), label: label || (omitContext ? '省略上下文实验' : '即时测试'),
      at: iso(this.now()), confirmation: 'pending',
      ...(contextAt ? { contextAgeMinutes: Math.max(0, Math.floor((this.now() - Date.parse(contextAt)) / 60000)) } : {}),
    };
    this.tests.unshift(test); this.tests = this.tests.slice(0, 12);
    this.sendAbort = new AbortController();
    try {
      // Persist a pending attempt before POST. A crash must never auto-resend.
      await this.persist(); await this.emit();
      const result = await this.client.sendText(session, { text: `${SYNTHETIC_TEXT}\n测试编号：${test.id.slice(0, 8)}`,
        contextToken, clientId: test.id, signal: this.sendAbort.signal });
      if (this.closed || generation !== this.generation) return;
      if (result?.confirmation !== 'accepted') throw problem('发送结果未知，请查看手机微信。', 'WECHAT_UNKNOWN');
      test.confirmation = 'accepted';
      this.message = '微信已接受测试消息，请在手机确认收到后点击“已收到”。';
    } catch (error) {
      if (generation !== this.generation) return;
      const rejected = ['WECHAT_REJECTED', 'WECHAT_SESSION_EXPIRED', 'WECHAT_CONFIGURATION'].includes(error.code);
      test.confirmation = rejected ? 'rejected' : 'unknown';
      test.code = typeof error.code === 'string' && Object.hasOwn(errorText, error.code) ? error.code : 'WECHAT_UNKNOWN';
      Object.assign(test, safeProbeDiagnostics(error));
      this.message = probeErrorMessage(error);
      if (error.code === 'WECHAT_SESSION_EXPIRED') { this.phase = 'expired'; await this.cancelSchedule(); }
    } finally {
      this.busy = false; this.sendAbort = null;
      if (generation === this.generation) { await this.persist(); await this.emit(); }
    }
  }
  async schedule(delayMinutes) {
    this.available();
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 2160) throw problem('测试延迟应为 1 至 2160 分钟。');
    if (!this.session || this.phase === 'expired' || !this.contextToken) throw problem('请先扫码并在微信 ClawBot 中发送“验证”。');
    if (this.scheduled) throw problem('已有延迟测试，请先取消后再安排。');
    // Freeze the current context: later chats cannot refresh this experiment.
    const plan = { at: this.now() + delayMinutes * 60000, captured: { token: this.contextToken, at: this.contextAt } };
    this.scheduled = plan;
    this.scheduleTimer = this.setTimer(async () => {
      if (this.closed || this.scheduled !== plan) return;
      this.scheduled = null; this.scheduleTimer = null;
      try { await this.send({ captured: plan.captured, label: `${delayMinutes} 分钟延迟测试` }); }
      catch (error) { this.message = `延迟测试未发送：${probeErrorMessage(error)}`; await this.emit(); }
    }, delayMinutes * 60000);
    this.message = '延迟测试已安排；请保持电脑在线、工具运行。'; await this.emit();
  }
  async cancelSchedule() {
    if (this.scheduleTimer) this.clearTimer(this.scheduleTimer);
    this.scheduled = null; this.scheduleTimer = null; await this.emit();
  }
  async confirm(testId) {
    this.available();
    const test = this.tests.find((item) => item.id === testId);
    if (!test || !['accepted', 'unknown'].includes(test.confirmation)) throw problem('该条测试还不能确认收到。');
    test.confirmation = 'received'; await this.persist();
    this.message = '已记录你在手机微信确认收到这条测试消息。'; await this.emit();
  }
  async forget() {
    this.available(); ++this.generation;
    this.loginAttempt?.abort.abort(); this.loginAttempt = null;
    this.listenAbort?.abort(); this.listenAbort = null;
    await this.cancelSchedule();
    this.session = null; this.contextToken = ''; this.contextAt = null; this.cursor = '';
    this.qrDataUrl = ''; this.tests = []; this.listening = false; this.phase = 'idle';
    await this.storage.remove();
    this.message = '本机测试连接已清除；微信侧解绑请在微信 ClawBot 中操作。'; await this.emit();
  }
  async stop() {
    this.closed = true; ++this.generation;
    this.loginAttempt?.abort.abort(); this.loginAttempt = null;
    this.listenAbort?.abort(); this.sendAbort?.abort();
    if (this.scheduleTimer) this.clearTimer(this.scheduleTimer);
    this.scheduleTimer = null; this.scheduled = null; this.qrDataUrl = ''; this.listening = false;
    await this.emit();
  }
}
