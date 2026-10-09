/**
 * Page wording in Chinese and English, following DSH's language setting live. `{name}` in a
 * string is replaced from the values passed to t(). Any non-Chinese locale falls back to English.
 */
import React from 'react';

export const DICT = {
  zh: {
    panel: '用量', title: '用量',
    range_today: '今天', range_7d: '7 天', range_30d: '30 天', range_90d: '90 天', range_all: '全部',
    rangeLong_today: '今天', rangeLong_7d: '最近 7 天', rangeLong_30d: '最近 30 天', rangeLong_90d: '最近 90 天', rangeLong_all: '全部时间',
    heroLabel: '{range}消耗的 Token', vsPrev: '较上一个同长周期',
    fCalls: '次模型调用', fCache: '缓存命中', fCacheHint: '缓存读 {cr} / 全部输入 {all}', fOutput: '输出 Token', fLatency: '平均耗时',
    fLatencyHint: '首字 {ttft} · P95 {p95}', fTools: '次工具调用', fErrors: '次失败',
    fWork: 'Agent 工作时长', fWorkHint: '模型生成 {model} · 工具执行 {tools}（另有 {wait} 在等你回答，不计入）',
    speed: '{n} tok/s', speedHint: '输出速度：首字之后每秒生成的 Token', ttftShort: '首字 {d}',
    ctx: '上下文 {first} → {peak}', ctxHint: '第一次调用和最大一次调用携带的上下文。越大，每次调用重读的 Token 越多',
    noteContext: '「{session}」的上下文从 {first} 涨到了 {peak}，{calls} 次调用每次都要重读。', noteContextOthers: '另有 {n} 个会话超过 40 万。',
    noteContextTip: '长任务适时压缩（/compact）或另开会话，最省 Token。',
    noteCache: '有 {n} 次在空闲超过 5 分钟后缓存过期，重新写入了 {tokens} Token（占缓存写入的 {share}）。', noteCacheTip: '缓存只保留几分钟，离开久了再回来就要整段重写。',
    noteFail: '{tool} 因「{reason}」失败了 {n} 次。',
    code_FS_STALE_VERSION: '文件已被改动', code_FS_STALE_VERSION_tip: 'Agent 在基于旧内容编辑，通常是它读完文件后文件又被改了。',
    code_FS_NOT_OBSERVED: '没先读文件', code_WEB_PROVIDER_ERROR: '搜索服务出错', code_UNKNOWN_TOOL: '工具不存在', unknownReason: '未知原因',
    activity: 'Token 活跃度', board_daily: '按天', board_weekly: '按周', board_cumulative: '累计', untilDay: '截至 {day}',
    loading: '加载中…', loadFailed: '加载失败：{error}', clearFilter: '显示全部模型',
    trend: '趋势', other: '其他', idle: '没有调用',
    models: '模型', sessions: '会话', tools: '工具', recent: '最近调用',
    nCalls: '{n} 次', nFailed: '{n} 次失败', hitShort: '命中 {p}', avgTime: '平均 {d}', ioShort: '输入 {in} · 缓存 {cr} · 输出 {out}',
    subagent: '子代理', noSessions: '这段时间没有会话', noTools: '这段时间没有工具调用',
    showMore: '显示更多', showLess: '收起',
    purpose_chat: '对话', purpose_compaction: '压缩', 'purpose_session-title': '标题', purpose_other: '其他',
    status_stop: '完成', 'status_tool-calls': '工具', 'status_max-tokens': '截断', status_aborted: '中止', status_error: '失败',
    empty: '这段时间还没有模型调用', emptyHint: '开始对话后，每一次模型请求都会记录在这里。',
    importing: '正在从会话日志导入历史用量… {done}/{total}', importFailed: '导入历史失败：{error}',
    imported: '数据只保存在本机，{date} 之前的 {calls} 次调用从 {files} 个会话日志导入。', reimport: '重新导入',
    local: '数据只保存在本机。',
    today: '今天', yesterday: '昨天', monthDay: '{m}月{d}日', weekOf: '{m}月{d}日这周',
    ms: '{n} 毫秒', s: '{n} 秒', min: '{n} 分钟', h: '{n} 小时',
  },
  en: {
    panel: 'Usage', title: 'Usage',
    range_today: 'Today', range_7d: '7D', range_30d: '30D', range_90d: '90D', range_all: 'All',
    rangeLong_today: 'today', rangeLong_7d: 'in the last 7 days', rangeLong_30d: 'in the last 30 days', rangeLong_90d: 'in the last 90 days', rangeLong_all: 'all time',
    heroLabel: 'Tokens used {range}', vsPrev: 'vs the previous period',
    fCalls: 'model calls', fCache: 'cache hits', fCacheHint: 'Cache reads {cr} / all input {all}', fOutput: 'output tokens', fLatency: 'avg duration',
    fLatencyHint: 'First token {ttft} · p95 {p95}', fTools: 'tool calls', fErrors: 'failed',
    fWork: 'agent working time', fWorkHint: 'Model {model} · tools {tools} (plus {wait} waiting for your answers, not counted)',
    speed: '{n} tok/s', speedHint: 'Output speed: tokens per second after the first token', ttftShort: 'first token {d}',
    ctx: 'context {first} → {peak}', ctxHint: 'Context carried by the first and the largest call. The larger it is, the more every call re-reads',
    noteContext: 'The context of “{session}” grew from {first} to {peak}; each of its {calls} calls re-reads it.', noteContextOthers: ' {n} more sessions passed 400K.',
    noteContextTip: 'Compacting long tasks (/compact) or starting a fresh session saves the most tokens.',
    noteCache: '{n} times the cache expired after more than 5 idle minutes, re-writing {tokens} tokens ({share} of cache writes).', noteCacheTip: 'The cache lives only minutes; coming back after a break re-writes the whole context.',
    noteFail: '{tool} failed {n} times: {reason}.',
    code_FS_STALE_VERSION: 'file changed since read', code_FS_STALE_VERSION_tip: 'The agent was editing from stale content, usually because the file changed after it read it.',
    code_FS_NOT_OBSERVED: 'file not read first', code_WEB_PROVIDER_ERROR: 'search provider error', code_UNKNOWN_TOOL: 'unknown tool', unknownReason: 'unknown reason',
    activity: 'Token activity', board_daily: 'Daily', board_weekly: 'Weekly', board_cumulative: 'Cumulative', untilDay: 'Through {day}',
    loading: 'Loading…', loadFailed: 'Failed to load: {error}', clearFilter: 'Show all models',
    trend: 'Trend', other: 'Other', idle: 'No calls',
    models: 'Models', sessions: 'Sessions', tools: 'Tools', recent: 'Recent calls',
    nCalls: '{n} calls', nFailed: '{n} failed', hitShort: '{p} cached', avgTime: 'avg {d}', ioShort: 'in {in} · cached {cr} · out {out}',
    subagent: 'subagent', noSessions: 'No sessions in this period', noTools: 'No tool calls in this period',
    showMore: 'Show more', showLess: 'Show less',
    purpose_chat: 'Chat', purpose_compaction: 'Compaction', 'purpose_session-title': 'Title', purpose_other: 'Other',
    status_stop: 'Done', 'status_tool-calls': 'Tools', 'status_max-tokens': 'Truncated', status_aborted: 'Aborted', status_error: 'Failed',
    empty: 'No model calls in this period yet', emptyHint: 'Every model request is recorded here once you start chatting.',
    importing: 'Importing past usage from session logs… {done}/{total}', importFailed: 'History import failed: {error}',
    imported: 'Stored on this machine only. {calls} calls before {date} were imported from {files} session logs.', reimport: 'Re-import',
    local: 'Stored on this machine only.',
    today: 'Today', yesterday: 'Yesterday', monthDay: '{mon} {d}', weekOf: 'Week of {mon} {d}',
    ms: '{n} ms', s: '{n}s', min: '{n} min', h: '{n} h',
  },
};

export const langOf = (active) => (String(active ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

export function translator(lang) {
  const dict = DICT[lang] ?? DICT.en;
  return (key, values = {}) => String(dict[key] ?? DICT.zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (values[name] ?? ''));
}

const I18n = React.createContext({ lang: 'zh', t: translator('zh') });

/** Wrap a tree so it re-renders when DSH's language changes. `locale` is ctx.locale (may be absent in tests). */
export function withI18n(locale, Component) {
  const subscribe = (fn) => locale?.subscribe?.(fn) ?? (() => {});
  // Subscribe to the locale id itself: a string compares by value, so a new snapshot object never loops.
  const snapshot = () => (locale?.getSnapshot?.() ?? locale?.getLocale?.())?.active ?? '';
  return function Localized(props) {
    const lang = langOf(React.useSyncExternalStore(subscribe, snapshot));
    const value = React.useMemo(() => ({ lang, t: translator(lang) }), [lang]);
    return <I18n.Provider value={value}><Component {...props} /></I18n.Provider>;
  };
}

export const useI18n = () => React.useContext(I18n);
