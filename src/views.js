// 视图层：同一事实流向不同身份呈现不同内容。
//
// - 医患视图：本人/经治医生可见完整连续性材料、说明全文与处理结果。
// - 普通监管视图：白名单字段，只见患者代号与用药连续性证据；
//   遗传信息、完整病历、剂量配方细节不在其中（入口已拒收，视图再做白名单兜底）。

import { CONFLICT_STATUS } from './conflicts.js';
import { ROLES } from './facts.js';

// 监管视图允许出现的冲突字段白名单。
const REGULATOR_CONFLICT_KEYS = [
  'conflict_id', 'type', 'severity', 'status', 'drug_code', 'event_date',
  'sites', 'metrics', 'exceptions', 'explanations', 'review', 'evidence',
];

// 监管视图可见的证据充分性判定。
// 充分性针对“事件发生日”：当时命中的有期限例外只要被机构变动/人工确认印证，
// 治疗连续性证据即成立；窗口是否仍在 asOf 开启只作信息展示（到期后不再覆盖新事件）。
function evidenceFor(conflict, timeline) {
  const transferWindows = conflict.exceptions.filter(e => e.reason === 'transfer');
  const emergencyWindows = conflict.exceptions.filter(e => e.reason === 'emergency');
  const shortageWindows = conflict.exceptions.filter(e => e.reason === 'shortage');
  const transferCorroborated = transferWindows.some(
    e => e.corroboration &&
      (e.corroboration.dialysis_versions.length > 0 || e.corroboration.episodes.length > 0),
  );
  const shortageConfirmed = shortageWindows.some(e => e.confirmed_by);
  const hasClinicianExplanation = conflict.explanations.some(e => e.kind === 'clinician_note');
  const hasHospitalExplanation = conflict.explanations.some(e => e.kind === 'hospital_supplement');

  let sufficient = false;
  let basis = [];
  if (conflict.status === CONFLICT_STATUS.RESOLVED) {
    sufficient = true;
    basis.push('监管复核确认治疗连续性');
  }
  if (transferWindows.length > 0) {
    if (transferCorroborated) {
      sufficient = true;
      basis.push('转院例外在事件发生日有效，且与透析/诊疗机构变动相互印证');
    } else {
      basis.push('转院例外在事件发生日有效，但缺少机构变动印证');
    }
  }
  if (emergencyWindows.length > 0) {
    sufficient = true;
    basis.push('急诊例外在事件发生日有效');
  }
  if (shortageWindows.length > 0) {
    if (shortageConfirmed) {
      sufficient = true;
      basis.push('缺药替代经人工确认且在事件发生日有效');
    } else {
      basis.push('缺药替代缺少人工确认');
    }
  }
  if (conflict.status === CONFLICT_STATUS.EXPLAINED && (hasClinicianExplanation || hasHospitalExplanation)) {
    basis.push('已有医生/医院说明，等待监管复核');
  }
  return {
    sufficient,
    basis,
    matched_exceptions: conflict.exceptions.map(e => ({
      reason: e.reason,
      valid_from: e.valid_from,
      valid_to: e.valid_to,
      window_active_as_of: e.active_as_of,
      confirmed_by: e.confirmed_by,
    })),
    transfer_corroborated: transferCorroborated,
    shortage_confirmed: shortageConfirmed,
    explanation_count: conflict.explanations.length,
    as_of: timeline.as_of,
  };
}

// 医患视图：一个患者的完整连续性时间线与冲突处理结果。
export function patientView(timeline, conflicts) {
  return {
    viewer: 'patient_or_clinician',
    patient_code: timeline.patient_code,
    as_of: timeline.as_of,
    dialysis: timeline.dialysis,
    current_site: timeline.current_site,
    episodes: timeline.episodes,
    regimen: timeline.regimen,
    prescriptions: timeline.prescriptions.map(rx => ({
      prescription_id: rx.prescription_id,
      site_code: rx.site_code,
      drug_code: rx.drug_code,
      daily_dose: rx.daily_dose,
      unit: rx.unit,
      quantity: rx.quantity,
      issued_on: rx.issued_on,
      voided_on: rx.voided_on,
      void_reason: rx.void_reason,
    })),
    supply: [...timeline.supply.values()].map(s => ({
      drug_code: s.drug_code,
      projected_runout: s.projected_runout,
      available_days_as_of: s.available_days_as_of,
      history: s.events.map(e => ({
        dispensed_on: e.dispensed_on,
        site_code: e.site_code,
        prescription_id: e.prescription_id,
        quantity: e.quantity,
        daily_dose: e.daily_dose,
        supply_days: e.supply_days,
        overlap_days_with_prior: e.overlap_days,
        prescription_voided_on: e.prescription_voided_on,
      })),
    })),
    exceptions: timeline.exceptions,
    holds: timeline.holds,
    active_hold: timeline.active_hold,
    explanations: {
      clinician_notes: timeline.notes,
      patient_corrections: timeline.corrections,
      hospital_supplements: timeline.supplements,
    },
    conflicts: conflicts.map(c => ({
      ...c,
      evidence: evidenceFor(c, timeline),
      awaiting_patient: c.status === CONFLICT_STATUS.OPEN,
      exception_window_active_as_of: c.exceptions.some(e => e.active_as_of),
    })),
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// 监管分类：治疗连续性证据充分 / 尚待说明 / 转入调查。
export const REGULATOR_BUCKETS = Object.freeze({
  CONTINUITY_SUPPORTED: 'continuity_supported',
  NEEDS_EXPLANATION: 'needs_explanation',
  INVESTIGATION: 'investigation',
});

const PENDING_STATUSES = new Set([
  CONFLICT_STATUS.OPEN,
  CONFLICT_STATUS.EXPLAINED,
  CONFLICT_STATUS.UPHELD,
]);

export function classifyPatient(conflicts) {
  if (conflicts.length === 0) return REGULATOR_BUCKETS.CONTINUITY_SUPPORTED;
  if (conflicts.some(c =>
    c.status === CONFLICT_STATUS.INVESTIGATION || c.status === CONFLICT_STATUS.UPHELD)) {
    return REGULATOR_BUCKETS.INVESTIGATION;
  }
  if (conflicts.some(c => PENDING_STATUSES.has(c.status))) {
    return REGULATOR_BUCKETS.NEEDS_EXPLANATION;
  }
  // 剩余全部为 resolved / excepted：要求每条证据充分才算连续性成立。
  return conflicts.every(c => c.evidence?.sufficient)
    ? REGULATOR_BUCKETS.CONTINUITY_SUPPORTED
    : REGULATOR_BUCKETS.NEEDS_EXPLANATION;
}

// 普通监管视图：跨患者汇总，白名单脱敏。
export function regulatorView(timelines, conflictsByPatient) {
  const patients = [];
  for (const timeline of timelines.values()) {
    const conflicts = conflictsByPatient.get(timeline.patient_code) ?? [];
    const withEvidence = conflicts.map(c => ({ ...c, evidence: evidenceFor(c, timeline) }));
    const bucket = classifyPatient(withEvidence);

    // 白名单裁剪：不携带治疗方案全文与说明自由文本；
    // 说明仅暴露类型/来源/日期，证据充分性由印证关系与人工确认字段计算。
    const visibleConflicts = withEvidence.map(c => {
      const whitelisted = pick(c, REGULATOR_CONFLICT_KEYS);
      whitelisted.explanations = c.explanations.map(e => ({
        kind: e.kind, id: e.id, on: e.on, site_code: e.site_code ?? null,
      }));
      return whitelisted;
    });

    patients.push({
      patient_code: timeline.patient_code, // 代号本身就是化名
      bucket,
      current_site_code: timeline.current_site?.site_code ?? null,
      dialysis_site_code: timeline.dialysis?.site_code ?? null,
      under_active_hold: timeline.active_hold != null,
      drug_codes: [...new Set([...timeline.supply.keys()])],
      available_days: [...timeline.supply.values()].map(s => ({
        drug_code: s.drug_code,
        available_days_as_of: s.available_days_as_of,
        projected_runout: s.projected_runout,
      })),
      conflicts: visibleConflicts,
    });
  }

  const summary = {
    as_of: timelines.values().next().value?.as_of ?? null,
    total_patients: patients.length,
    buckets: {
      [REGULATOR_BUCKETS.CONTINUITY_SUPPORTED]: 0,
      [REGULATOR_BUCKETS.NEEDS_EXPLANATION]: 0,
      [REGULATOR_BUCKETS.INVESTIGATION]: 0,
    },
  };
  for (const p of patients) summary.buckets[p.bucket] += 1;

  return {
    viewer: 'regulator',
    redaction: '患者代号化；遗传信息与完整病历在事实入口拒收；本视图仅展示白名单字段',
    summary,
    patients: patients.sort((a, b) => {
      const order = { investigation: 0, needs_explanation: 1, continuity_supported: 2 };
      return order[a.bucket] - order[b.bucket] || a.patient_code.localeCompare(b.patient_code);
    }),
  };
}

// 限制解除审计视图：证明每次临时限制都只能由授权人员解除。
export function holdAuditView(timeline) {
  return timeline.holds.map(h => ({
    patient_code: timeline.patient_code,
    ...h,
    release_authorized: !h.released_on || h.released_by?.role === ROLES.AUTHORIZER,
  }));
}
