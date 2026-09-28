// 系统自启和本地配置必须一起成功；失败时不向界面报告“已保存”。
export async function commitPreferences({ previousAutoStart, nextAutoStart, setAutoStart, write }) {
  const changed = previousAutoStart !== nextAutoStart;
  if (changed) {
    const applied = await setAutoStart(nextAutoStart);
    if (applied !== nextAutoStart) throw new Error('系统尚未接受自启设置，请检查系统的登录项权限后重试');
  }
  try { await write(); }
  catch (error) {
    if (changed) {
      try {
        if (await setAutoStart(previousAutoStart) !== previousAutoStart) throw new Error('系统未接受恢复设置');
      } catch {
        throw new Error('提醒设置未保存，且登录自启未能恢复。请重新检查系统登录项。', { cause: error });
      }
    }
    throw error;
  }
}
