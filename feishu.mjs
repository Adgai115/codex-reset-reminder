import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getSnoozeOptions } from './later.mjs';
import { larkCommand } from './native-bin.mjs';

export async function callFeishuCli(config, args) {
  const command = larkCommand(config);
  const result = await new Promise((done, fail) => {
    const child = spawn(command.executable, [...command.prefix, ...args], { windowsHide: true,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    let detail = '飞书 CLI 请求失败';
    try { detail = JSON.parse(result.stderr).error?.message || detail; } catch { /* Do not log raw CLI output. */ }
    throw new Error(detail);
  }
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw new Error('飞书 CLI 返回了无法识别的结果'); }
  if (envelope.ok !== true) throw new Error('飞书 CLI 未确认操作成功');
  return envelope;
}

export function buildFeishuCard(card, days, { state = 'available', nextDays = null, simulation = false,
  notice = null, statusInfo = null, currentAvailableCount = null, syncedAt = null,
  snoozeTargetAt = null } = {}) {
  const expiryDate = new Date(card.expiresAt * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const expires = `${expiryDate.getFullYear()}/${pad(expiryDate.getMonth() + 1)}/${pad(expiryDate.getDate())} ${pad(expiryDate.getHours())}:${pad(expiryDate.getMinutes())}`;
  const localDay = (time) => {
    const date = new Date(time);
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  };
  const remainingDays = Math.max(0, localDay(card.expiresAt * 1000) - localDay(Date.now()));
  const plain = (content, text_size = 'normal', text_color, text_align = 'left') => ({ tag: 'div', text: {
    tag: 'plain_text', content: String(content), text_size,
    text_align,
    ...(text_color ? { text_color } : {}),
  } });
  const isActive = state === 'available';
  const stateTitle = state === 'used' ? '重置卡已使用'
    : state === 'snoozed' ? '已安排稍后提醒'
      : state === 'choosing' ? '选择稍后提醒时间'
        : state === 'pending_verification' ? '已记录使用，等待核实'
      : state === 'unavailable' ? '重置卡已不可用' : 'Codex 重置卡即将到期';
  const theme = state === 'used' ? 'green' : state === 'unavailable' ? 'grey'
    : state === 'pending_verification' ? 'blue' : 'orange';
  const focusDays = state === 'snoozed' && Number.isFinite(nextDays) ? nextDays
    : Number.isFinite(Number(days)) ? Number(days) : remainingDays;
  const focus = state === 'used' ? '已使用'
    : state === 'snoozed' ? (snoozeTargetAt
      ? `将在 ${new Date(snoozeTargetAt * 1000).toLocaleString('zh-CN', { hour12: false })} 提醒`
      : nextDays === null ? '已延后提醒' : nextDays === 0 ? '到期当天再提醒' : `到期前 ${nextDays} 天再提醒`)
      : state === 'choosing' ? '选择提醒时间'
        : state === 'pending_verification' ? '等待 Codex 核实'
      : state === 'unavailable' ? '已不可用' : focusDays === 0 ? '今天到期' : `${focusDays} 天后到期`;
  const heroNumber = state === 'available' && focusDays > 0 ? String(focusDays)
    : state === 'available' ? '0' : '';
  const snoozeOptions = getSnoozeOptions(card);
  const awaitingVerification = card.source === 'codex' && Boolean(card.reportedUsedAt);
  const primaryAction = awaitingVerification ? 'refresh' : card.source === 'codex' ? 'consume' : 'use';
  const primaryText = awaitingVerification ? '核实状态' : card.source === 'codex' ? '立即使用' : '标记已使用';
  const actions = isActive && !simulation ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button',
        text: { tag: 'plain_text', content: primaryText },
        type: 'primary_filled', width: 'fill',
        behaviors: [{ type: 'callback', value: { action: primaryAction } }],
        ...(!awaitingVerification ? { confirm: {
          title: { tag: 'plain_text', content: card.source === 'codex'
            ? `确认立即使用 ${card.title.slice(0, 65)}？`
            : `确认标记 ${card.title.slice(0, 65)} 为已使用？` },
          text: { tag: 'plain_text', content: card.source === 'manual'
            ? '确认后只会把手动录入的卡片标记为已使用。'
            : '确认后会立即向 Codex 发起正式用卡请求。成功使用后无法撤销；如果当前没有符合条件的用量窗口，卡片不会消耗。' },
        } } : {}),
      }] },
      ...(snoozeOptions.length ? [{ tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button',
        text: { tag: 'plain_text', content: '稍后提醒' }, type: 'default', width: 'fill',
        behaviors: [{ type: 'callback', value: { action: 'later' } }],
      }] }] : []),
    ] }] : state === 'choosing' && snoozeOptions.length ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
    columns: snoozeOptions.map((choice) => ({ tag: 'column', width: 'weighted', weight: 1,
      elements: [{ tag: 'button', text: { tag: 'plain_text', content: choice.label },
        type: 'default', width: 'fill', behaviors: [{ type: 'callback',
          value: { action: 'snooze', option: choice.option } }] }] })) }]
    : (state === 'used' || state === 'pending_verification') && card.source === 'codex' ? [{ tag: 'button',
    text: { tag: 'plain_text', content: state === 'used' ? '刷新 Codex 用量' : '刷新核实状态' }, type: 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { action: 'refresh' } }],
  }] : [];
  const footer = notice || (simulation ? '仿真卡片 · 按钮不可操作，不会使用真实重置卡。'
    : state === 'used' ? card.source === 'manual'
      ? '手动卡片已在本地标记为已使用；后续到期提醒已停止。'
      : 'Codex 已确认用卡；此卡后续到期提醒已停止。'
      : state === 'snoozed' ? '到达选定时间时会再次通知；官方到期时间不变。'
        : state === 'choosing' ? '请选择一个时间；到期时间不会改变。'
          : state === 'pending_verification' ? '已记录使用反馈。Codex 尚未确认，后续提醒暂时保留。'
        : state === 'unavailable' ? '这张卡片无法继续使用。'
          : snoozeTargetAt ? '这是你设定的延期提醒；官方到期时间不变。'
            : awaitingVerification ? '此前已反馈使用，但 Codex 最近同步仍显示可用；可点「核实状态」。'
            : card.source === 'codex'
              ? `提前 ${days} 天提醒 · 点击「立即使用」并二次确认后，会请求 Codex 正式用卡。`
              : `提前 ${days} 天提醒 · 手动卡片只更新本地状态。`);
  const body = [
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', columns: [
      { tag: 'column', width: 'auto', vertical_align: 'center', elements: [
        plain(heroNumber || '—', 'heading-0', state === 'available' ? 'orange-700' : 'grey-700'),
      ] },
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [
        plain(state === 'available' ? '天后到期' : focus, 'heading-1', 'default'),
      ] },
    ] },
    plain(card.title, 'heading-3', 'default'),
    ...(card.source === 'codex' && Number.isInteger(currentAvailableCount)
      ? [plain(`Codex 最近同步可用 ${currentAvailableCount} 张`, 'normal', 'grey-500')] : []),
    ...(card.source === 'codex' && Number.isInteger(syncedAt)
      ? [plain(`最近核对：${new Date(syncedAt * 1000).toLocaleString('zh-CN', { hour12: false })}${Date.now() / 1000 - syncedAt > 86400 ? ' · 数据可能已过时' : ''}`,
        'notation', 'grey-500')] : []),
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px',
      background_style: 'grey-50', columns: [
        { tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '4px', elements: [
          plain('到期时间', 'notation', 'grey-500'),
          plain(expires, 'heading-4', 'default'),
        ] },
        { tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '4px', elements: [
          plain('卡片编号', 'notation', 'grey-500'),
          plain(card.id, 'heading-4', 'default'),
        ] },
      ] },
    { tag: 'hr', margin: '4px 0' },
    plain(footer, 'normal', 'grey-500'),
    ...actions,
  ];
  if (state === 'used' && statusInfo) {
    const lines = [];
    if (Number.isInteger(statusInfo.remaining)) lines.push(`剩余重置卡 ${statusInfo.remaining} 张`);
    for (const window of [statusInfo.primary, statusInfo.secondary]) {
      if (!Number.isFinite(window?.usedPercent)) continue;
      const label = window.durationMins === 300 ? '5 小时' : window.durationMins === 10080 ? '7 天'
        : Number.isFinite(window.durationMins) ? `${window.durationMins} 分钟` : '额度';
      lines.push(`${label}已用 ${window.usedPercent}%`);
    }
    const checked = new Date(statusInfo.checkedAt * 1000);
    const checkedText = Number.isFinite(checked.getTime())
      ? `${pad(checked.getHours())}:${pad(checked.getMinutes())}:${pad(checked.getSeconds())}` : '刚刚';
    body.splice(3, 0, { tag: 'column_set', flex_mode: 'none', background_style: 'grey-50', columns: [
      { tag: 'column', width: 'weighted', weight: 1, padding: '12px', elements: [
        plain(`Codex 最新用量 · ${checkedText}`, 'notation', 'grey-500'),
        plain(lines.length ? lines.join(' · ') : '已读取 Codex 用量', 'normal', 'green-700'),
      ] },
    ] });
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default',
      summary: { content: `${card.title} 将于 ${expires} 到期` } },
    header: {
      title: { tag: 'plain_text', content: stateTitle },
      template: theme,
      icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'orange' },
      text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: state === 'used' ? '已使用'
        : state === 'snoozed' ? '稍后提醒' : state === 'choosing' ? '选择时间'
          : state === 'pending_verification' ? '待核实' : state === 'unavailable' ? '不可用' : '待处理' },
      color: state === 'used' ? 'green' : state === 'unavailable' ? 'neutral'
        : state === 'pending_verification' ? 'blue' : 'orange' }],
    },
    body: { direction: 'vertical', padding: '16px 16px 20px 16px', vertical_spacing: '12px', elements: body },
  };
}

export async function sendFeishuReminder(config, card, days, { dryRun = false, simulation = false,
  currentAvailableCount = null, syncedAt = null, snoozeTargetAt = null } = {}) {
  const channel = config.feishu;
  if (!channel?.enabled) return false;
  if (!['bot', 'user'].includes(channel.as)) throw new Error('飞书发送身份未配置');
  if (Boolean(channel.chatId) === Boolean(channel.userId)) throw new Error('飞书必须配置一个群聊 ID 或用户 ID');

  const idempotencyKey = createHash('sha256')
    .update(`${card.id}:${card.expiresAt}:${snoozeTargetAt ?? `${days}d`}:feishu`).digest('hex').slice(0, 48);
  const args = ['im', '+messages-send', '--profile', channel.profile || 'codex-reset-monitor', '--as', channel.as,
    channel.chatId ? '--chat-id' : '--user-id', channel.chatId || channel.userId,
    '--msg-type', 'interactive', '--content', JSON.stringify(buildFeishuCard(card, days,
      { simulation, currentAvailableCount, syncedAt, snoozeTargetAt })),
    '--idempotency-key', idempotencyKey, '--json',
    ...(dryRun ? ['--dry-run'] : [])];
  const envelope = await callFeishuCli(config, args);
  const messageId = envelope.data?.message_id;
  if (!dryRun && !/^om_/.test(messageId || '')) throw new Error('飞书已返回成功但缺少消息编号，无法安全处理卡片按钮');
  return { messageId: messageId || null };
}

export async function updateFeishuCard(config, token, card, days, state, nextDays = null, notice = null,
  statusInfo = null, displayOptions = {}) {
  if (!token) throw new Error('缺少飞书卡片更新令牌');
  return callFeishuCli(config, ['api', 'POST', '/open-apis/interactive/v1/card/update',
    '--profile', config.feishu.profile || 'codex-reset-monitor', '--as', 'bot',
    '--data', JSON.stringify({ token, card: buildFeishuCard(card, days,
      { state, nextDays, notice, statusInfo, ...displayOptions }) }), '--json']);
}

export async function patchFeishuCard(config, messageId, card, days, state,
  nextDays = null, notice = null, statusInfo = null, displayOptions = {}) {
  if (!/^om_/.test(messageId || '')) throw new Error('缺少飞书卡片消息编号');
  const content = JSON.stringify(buildFeishuCard(card, days,
    { state, nextDays, notice, statusInfo, ...displayOptions }));
  return callFeishuCli(config, ['im', 'messages', 'patch', '--profile', config.feishu.profile || 'codex-reset-monitor',
    '--as', 'bot', '--message-id', messageId, '--data', JSON.stringify({ content }), '--json']);
}
