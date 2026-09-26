// 只保存可操作的错误分类。外部 CLI 错误可能包含 URL、令牌或配置值。
export function safeDeliveryFailure(error, channel) {
  const message = String(error?.message || '');
  if (/timed? ?out|超时|ETIMEDOUT/i.test(message)) return {
    code: 'timeout', text: '发送超时；服务端可能已接收，补发会复用同一消息幂等键。',
  };
  if (/ECONN|ENOTFOUND|网络|连接失败|offline/i.test(message)) return {
    code: 'network', text: '网络连接失败；检查网络后可重试。',
  };
  if (/权限|认证|授权|forbidden|unauthori[sz]ed|token|credential/i.test(message)) return {
    code: 'auth', text: '认证或权限失败；请检查提醒设置中的渠道连接。',
  };
  if (/缺少消息编号/.test(message)) return {
    code: 'missing_message_id', text: '飞书未返回消息编号；请检查飞书连接，补发会复用同一幂等键。',
  };
  if (/未配置|缺少|无效/.test(message)) return {
    code: 'configuration', text: '渠道配置不完整或无效；请在提醒设置中检查。',
  };
  return { code: 'send_failed', text: channel === 'desktop'
    ? '桌面弹窗失败；请在提醒设置中测试桌面弹窗。'
    : '发送未成功确认；请检查渠道连接后重试。' };
}
