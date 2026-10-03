// Only public account errors cross the process boundary; vendor messages may
// contain private paths or authorization URLs.
export function accountErrorPayload(error) {
  const code = /^ACCOUNT_[A-Z_]{1,48}$/.test(error?.code || '') ? error.code : undefined;
  return { error: '账号连接失败，请重新登录或稍后重试',
    afterRequest: error?.afterRequest === true, ...(code ? { code } : {}) };
}

export function restoreCoreError(payload) {
  const error = new Error(payload.error);
  error.afterRequest = payload.afterRequest === true;
  if (/^(?:ACCOUNT|PUSHPLUS|WECHAT)_[A-Z_]{1,48}$/.test(payload.code || '')) error.code = payload.code;
  return error;
}

export function resetFailureResult(error) {
  return { outcome: /^ACCOUNT_[A-Z_]{1,48}$/.test(error?.code || '') && error?.afterRequest !== true
    ? 'blocked' : 'unconfirmed', message: error.message };
}
