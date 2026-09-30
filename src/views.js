// 角色视图：患者、医生、普通监管人员看到的内容各不相同。
// 普通监管视图不包含遗传信息与完整病历（restricted 事实在投影阶段即不进入分析数据），
// 也不展示医生说明原文，仅给出例外类型、证据编号与复核结论用于分流判断。

function compactConflict(conflict, { withDetails }) {
  const base = {
    conflict_id: conflict.conflict_id,
    rule: conflict.rule,
    severity: conflict.severity,
    status: conflict.status,
    dates: conflict.dates,
    orgs: conflict.orgs,
    message: conflict.details.message,
    matched_exceptions: conflict.matched_exceptions.map((e) => ({
      exception_id: e.exception_id,
      kind: e.kind,
      valid_from: e.valid_from,
      valid_to: e.valid_to,
      reason: e.reason,
    })),
    review_outcome: conflict.review
      ? { decision: conflict.review.decision, rationale: conflict.review.rationale, review_id: conflict.review.review_id }
      : null,
  };
  if (withDetails) {
    base.details = conflict.details;
    base.prescription_ids = conflict.prescription_ids;
    base.dispense_ids = conflict.dispense_ids;
  }
  return base;
}

// 患者视图：尚待说明的冲突、期限例外与处理结果，不暴露内部调查标记细节。
export function buildPatientView(analysis) {
  const { timeline, conflicts, disposition } = analysis;
  return {
    view: 'patient',
    patient_code: timeline.patient_code,
    as_of: timeline.as_of,
    dialysis: timeline.dialysis_current
      ? { facility_org_id: timeline.dialysis_current.facility_org_id, pattern: timeline.dialysis_current.pattern, effective_from: timeline.dialysis_current.effective_from }
      : null,
    current_regimen: timeline.regimen_current
      ? { regimen_id: timeline.regimen_current.regimen_id, version: timeline.regimen_current.version, drugs: timeline.regimen_current.drugs }
      : null,
    medication_coverage: timeline.coverage.map((c) => ({
      class_code: c.class_code,
      available_until: c.available_until,
      predicted_available_days: c.predicted_available_days,
    })),
    conflicts_awaiting_explanation: conflicts
      .filter((c) => c.status === 'open')
      .map((c) => compactConflict(c, { withDetails: false })),
    explained_conflicts: conflicts
      .filter((c) => c.status === 'excepted' || c.status === 'reviewed')
      .map((c) => compactConflict(c, { withDetails: false })),
    holds: timeline.holds.map((h) => ({
      hold_id: h.hold_id,
      lifted: h.lifted,
      reason: h.reason,
      lifted_reason: h.lift?.reason ?? null,
    })),
    outcome: {
      disposition,
      message: disposition === 'evidence_sufficient'
        ? '跨院取药的治疗连续性证据充分，相关提示已闭环。'
        : disposition === 'pending_explanation'
          ? '仍有临时限制等待授权人员核实解除。'
          : '存在尚待说明的取药冲突，监管可能要求补充材料。',
    },
  };
}

// 医生视图：完整时间线、剂量/间隔细节、证据清单与医生说明原文，便于临床解释。
export function buildClinicianView(analysis) {
  const { timeline, conflicts, disposition } = analysis;
  return {
    view: 'clinician',
    patient_code: timeline.patient_code,
    as_of: timeline.as_of,
    dialysis_history: timeline.dialysis_history,
    sites: timeline.sites,
    regimen_versions: timeline.regimen_versions,
    dispense_rows: timeline.dispense_rows,
    medication_coverage: timeline.coverage,
    totals_by_drug: timeline.totals_by_drug,
    clinician_notes: timeline.clinician_notes,
    exceptions: timeline.exceptions,
    holds: timeline.holds,
    conflicts: conflicts.map((c) => compactConflict(c, { withDetails: true })),
    outcome: { disposition },
  };
}

// 普通监管视图：可用于分流的最小必要信息，无遗传/病历内容、无医生说明原文。
export function buildRegulatorView(analysis) {
  const { timeline, conflicts, disposition, evidence } = analysis;
  return {
    view: 'regulator',
    patient_code: timeline.patient_code,
    as_of: timeline.as_of,
    dialysis_site: timeline.dialysis_current?.facility_org_id ?? null,
    regimen_versions: timeline.regimen_versions.map((r) => ({
      regimen_id: r.regimen_id,
      version: r.version,
      org_id: r.org_id,
      active_from: r.active_from,
      drug_codes: r.drugs.map((d) => d.drug_code),
    })),
    dispense_rows: timeline.dispense_rows.map((r) => ({
      dispense_id: r.dispense_id,
      date: r.date,
      org_id: r.org_id,
      drug_code: r.drug_code,
      class_code: r.class_code,
      quantity: r.quantity,
      unit: r.unit,
      daily_dose: r.daily_dose,
      days_supply: r.days_supply,
      take_home: r.take_home,
      prescription_voided: r.prescription_voided,
    })),
    medication_coverage: timeline.coverage,
    conflicts: conflicts.map((c) => compactConflict(c, { withDetails: true })),
    exceptions: timeline.exceptions.map((e) => ({
      exception_id: e.exception_id,
      kind: e.kind,
      active: e.active,
      expired: e.expired,
      valid_from: e.valid_from,
      valid_to: e.valid_to,
      reason: e.reason,
      evidence_count: e.evidence.length,
      evidence_refs: e.evidence,
      manually_confirmed: e.manually_confirmed,
    })),
    holds: timeline.holds,
    triage: { disposition, evidence },
  };
}
