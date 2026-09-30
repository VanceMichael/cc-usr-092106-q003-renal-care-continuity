// 分析编排：日志 -> 时间线 -> 冲突 -> 分流。
// review 事实从原始日志注入时间线，供冲突模块匹配处理结果。

import { buildTimeline } from './timeline.js';
import { detectConflicts, triage } from './conflicts.js';

export function analyzeJournal(journal, options = {}) {
  const timeline = buildTimeline(journal, options);
  timeline.reviews = journal.facts
    .filter((f) => f.type === 'review')
    .map((f) => ({ ...f.data, at: f.at, by: f.recorded_by.actor_code }));

  const conflicts = detectConflicts(timeline, options);
  const result = triage(timeline, conflicts);
  return { timeline, conflicts, ...result };
}
