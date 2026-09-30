// 用药连续性后台入口：事实台账 → 时间线 → 冲突 → 角色视图。

export {
  createLedger,
  ingest,
  FACT_TYPES,
  EXCEPTION_REASONS,
  ROLES,
} from './facts.js';
export { buildTimeline, buildTimelines } from './timeline.js';
export {
  detectConflicts,
  CONFLICT_TYPES,
  CONFLICT_STATUS,
  EARLY_REFILL_GRACE_DAYS,
} from './conflicts.js';
export {
  patientView,
  regulatorView,
  holdAuditView,
  classifyPatient,
  REGULATOR_BUCKETS,
} from './views.js';
export * as dates from './dates.js';

import { buildTimelines } from './timeline.js';
import { detectConflicts } from './conflicts.js';
import { patientView, regulatorView } from './views.js';

// 一次折叠出区域内全部患者的时间线（冲突检测在同一 asOf 下进行）。
export function evaluateRegion(ledger, asOf = '2026-09-30') {
  const timelines = buildTimelines(ledger, asOf);
  const conflictsByPatient = new Map();
  for (const [code, timeline] of timelines) {
    conflictsByPatient.set(code, detectConflicts(timeline));
  }
  return {
    as_of: asOf,
    timelines,
    conflictsByPatient,
    patientView(code) {
      const timeline = timelines.get(code);
      if (!timeline) throw new Error(`未知患者代号：${code}`);
      return patientView(timeline, conflictsByPatient.get(code));
    },
    regulatorView() {
      return regulatorView(timelines, conflictsByPatient);
    },
  };
}
