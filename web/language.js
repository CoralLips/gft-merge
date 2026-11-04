// Interface text only. Session titles, pool names and conversation contents belong to the user.
const mergeLanguage = (() => {
  const storageKey = 'gft-merge:lang';
  const root = document.documentElement;
  let initial = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'zh' || saved === 'en') initial = saved;
  } catch {}
  root.lang = initial === 'zh' ? 'zh-CN' : 'en';

  const pick = (zh, en) => root.lang === 'en' ? en : zh;
  const labels = {
    rail: ['各工具的会话（按住桶之间的空隙左右拖动）', 'Sessions by tool (drag the gaps to scroll sideways)'],
    pools: ['池子', 'Pools'],
    workspace: ['工作区', 'Workspace'],
    newPool: ['＋ 新池子', '＋ New pool'],
    drag: ['拖进中间＝融合 · 往上拖＝注入 · 拖到左边的池子＝移过去', 'Drop on a ball to merge · Drag up to start a session · Drop on a pool to move'],
    remove: ['松手即移出池子', 'Release to remove from pool'],
    settings: ['设置', 'Settings'],
    language: ['语言', 'Language'],
    appearance: ['外观', 'Appearance'],
    tools: ['连接的工具', 'Connected tools'],
    processor: ['处理工具', 'Compression tool'],
    processorLabel: ['处理工具（压缩用哪个工具的哪个模型）', 'Compression tool and model'],
  };
  function applyStatic() {
    for (const [attribute, target] of [['data-copy', 'textContent'], ['data-label', 'ariaLabel'], ['data-title', 'title']]) {
      for (const element of document.querySelectorAll('[' + attribute + ']'))
        element[target] = pick(...labels[element.getAttribute(attribute)]);
    }
  }
  function set(lang) {
    root.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try { localStorage.setItem(storageKey, lang); } catch {}
    applyStatic();
  }
  // Preserve unrecognized diagnostics from the native tools verbatim.
  const englishErrors = new Map([
    ['缺少 Claude Code 读取组件，请在 GFT-Merge 目录运行 npm install。', 'Claude Code support is missing. Run npm install in the GFT-Merge directory.'],
    ['无法启动本机 Codex，请确认已安装 Codex。', 'Could not start Codex. Check that it is installed on this computer.'],
    ['本机 Codex 连接已关闭。', 'The local Codex connection closed.'],
    ['Codex 没有完成这次操作，请稍后再试。', 'Codex could not finish this action. Try again later.'],
    ['Codex 响应超时，请重试。', 'Codex timed out. Try again.'],
    ['Codex 没有给出压缩结果', 'Codex returned no compression result.'],
    ['池子编号无效', 'Invalid pool ID.'], ['池子不存在', 'Pool not found.'],
    ['这段会话不在池子里', 'This session is not in the pool.'],
    ['这个球不在池子里', 'This ball is not in the pool.'],
    ['名字不能为空', 'Enter a name.'],
    ['压缩期间这个球的组成变了，这次压缩作废', 'The ball changed during compression. Try again.'],
    ['未知工具', 'Unknown tool.'],
    ['不知道新会话该在哪个项目里', 'Could not determine the project for the new session.'],
    ['这个球正在压缩', 'This ball is being compressed.'],
    ['这个球里没有内容', 'This ball is empty.'], ['缺少会话', 'Missing session.'],
    ['不支持的操作', 'Unsupported action.'], ['不存在', 'Not found.'],
    ['请求过大', 'The request is too large.'], ['只接受本机页面的请求', 'Only local requests are accepted.'],
    ['出错了', 'Something went wrong.'],
  ]);
  function localizedError(raw) {
    if (root.lang !== 'en') return raw;
    return englishErrors.get(raw) ?? raw
      .replace(/^Claude 没有完成这次发送：/, 'Claude could not start the session: ')
      .replace(/^Claude 没有给出压缩结果：/, 'Claude could not compress the session: ')
      .replace(/没有返回会话$/, 'No session returned.').replace(/没有返回$/, 'No result returned.');
  }
  return { pick, set, applyStatic, localizedError };
})();
