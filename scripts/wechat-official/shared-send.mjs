// Shared notifications reuse the probe's single transport, lock and cooldown.
// Arbitrary message text stays in memory and is never added to probe records.
export function createSharedWechatSender(probe, { canSend = () => true } = {}) {
  return async (text, { signal, clientId } = {}) => {
    const unsent = (message, code = 'PROBE_STATE') => Object.assign(new Error(message), { code, unsent: true });
    const unknown = () => Object.assign(new Error('发送结果未知，请先查看手机微信。'), { code: 'WECHAT_UNKNOWN' });
    if (signal?.aborted) throw unsent('共享通知已取消。', 'WECHAT_CANCELLED');
    if (!canSend()) throw unsent('请先完成窗口中的当前操作。');
    try { probe.available(); }
    catch { throw unsent('微信连接正忙或已关闭，请稍后再提交。', 'GATEWAY_BUSY'); }
    if (!probe.session || probe.phase !== 'bound') throw unsent('请先恢复有效的微信连接。');
    if (typeof text !== 'string' || !text.trim()) throw unsent('共享通知内容无效。');
    if (probe.now() - probe.lastSendAt < probe.cooldownMs) throw unsent('发送间隔不足，请稍后再提交。', 'GATEWAY_BUSY');

    const session = probe.session, generation = probe.generation, contextToken = probe.contextToken;
    const contextMessage = '微信尚未建立会话，请在手机 ClawBot 发送“验证”后再试。';
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    // Reserve synchronously, before publishing status or entering the network.
    probe.busy = true; probe.sendAbort = abort;
    let transported = false;
    try {
      if (!contextToken) probe.message = contextMessage;
      try { await probe.emit(); }
      catch { throw unsent('本机共享状态无法保存，本次未发送。'); }
      if (probe.closed || generation !== probe.generation || session !== probe.session || abort.signal.aborted)
        throw unsent('共享通知已取消。', 'WECHAT_CANCELLED');
      if (!contextToken) throw unsent(contextMessage);
      probe.lastSendAt = probe.now(); transported = true;
      const result = await probe.client.sendText(session, {
        text, contextToken, clientId, signal: abort.signal,
      });
      if (probe.closed || generation !== probe.generation || session !== probe.session) throw unknown();
      if (result?.confirmation !== 'accepted') throw unknown();
      probe.message = '微信已接受共享通知，请在手机核对。';
      return { confirmation: 'accepted' };
    } catch (error) {
      if (!transported) throw error?.unsent ? error : unsent('共享通知未发送，请查看本机连接状态。');
      const known = ['WECHAT_REJECTED', 'WECHAT_SESSION_EXPIRED', 'WECHAT_CONFIGURATION'].includes(error?.code);
      if (generation === probe.generation && !probe.closed) {
        probe.message = known ? '微信拒绝共享通知，请核对连接状态。' : '共享通知结果未知，已停止补发，请先查看手机微信。';
        if (error?.code === 'WECHAT_SESSION_EXPIRED') {
          probe.phase = 'expired';
          await probe.cancelSchedule().catch(() => {});
        }
      }
      if (known) throw Object.assign(new Error('微信拒绝共享通知。'), { code: error.code });
      throw unknown();
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (probe.sendAbort === abort) { probe.busy = false; probe.sendAbort = null; }
      if (generation === probe.generation) await probe.emit().catch(() => {});
    }
  };
}
