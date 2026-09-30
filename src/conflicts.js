// 冲突检测与有期限例外。
//
// 检测器只负责“从事实中发现疑点”，不做支付决定：
//   - SAME_DAY_DUPLICATE 同日多院领取同一药品
//   - EARLY_REFILL      上次库存尚未用完即再次领取（间隔异常）
//   - DOSE_OVERLAP      不同机构处方覆盖区间互相重叠（剂量重叠）
// 命中的转院/急诊/缺药替代窗口会让冲突以“例外”状态保留；
// 窗口到期后冲突重新浮出水面，需要新的说明或复核裁定。

import { addDays, daysBetween, covers } from './dates.js';
import { matchingExceptions } from './timeline.js';

export const CONFLICT_TYPES = Object.freeze({
  SAME_DAY_DUPLICATE: 'same_day_duplicate',
  EARLY_REFILL: 'early_refill',
  DOSE_OVERLAP: 'dose_overlap',
});

// 提前取药宽限天数：仍有 ≥3 天库存时再次领取才提示。
export const EARLY_REFILL_GRACE_DAYS = 3;

export const CONFLICT_STATUS = Object.freeze({
  OPEN: 'open',             // 尚待说明
  EXPLAINED: 'explained',   // 已有医生/患者/医院说明，待复核
  EXCEPTED: 'excepted',     // 事件发生日处于有效例外窗口（有期限）
  RESOLVED: 'resolved',     // 监管复核确认治疗连续性
  UPHELD: 'upheld',         // 复核认定异常成立
  INVESTIGATION: 'investigation', // 转入调查
});

function makeId(patientCode, type, parts) {
  return `${patientCode}:${type}:${parts.join('|')}`;
}

// 方案在某日对某药的上限。
function regimenCeiling(regimens, date, drugCode) {
  let current = null;
  for (const r of regimens) {
    if (r.effective_from <= date && (!current || r.effective_from >= current.effective_from)) current = r;
  }
  const item = current?.items.find(i => i.drug_code === drugCode);
  return item && item.daily_max != null
    ? { daily_max: item.daily_max, daily_dose: item.daily_dose, near_label_max: item.daily_dose >= item.daily_max }
    : null;
}

function explanationMatches(explanations, conflictId, prescriptionIds) {
  const hits = [];
  for (const ex of explanations) {
    const links = new Set([...(ex.links ?? []), ...(ex.related_prescription_ids ?? [])]);
    if (links.has(conflictId) || prescriptionIds.some(id => links.has(id))) hits.push(ex);
  }
  return hits;
}

function describeExplanation(e) {
  return {
    kind: e.kind,
    id: e.id,
    on: e.on,
    by: e.by ?? null,
    site_code: e.site_code ?? null,
    text: e.text,
  };
}

// 转院/急诊例外是否与透析安排或诊疗机构变动相互印证（机构需落在冲突涉及机构内）。
function corroboratedByCare(timeline, eventDate, sites) {
  const within = (d) => Math.abs(daysBetween(d, eventDate)) <= 7;
  const dialMoves = (timeline.dialysis?.versions ?? [])
    .filter(v => within(v.effective_from) && (!sites || sites.includes(v.site_code)));
  const episodeMoves = timeline.episodes
    .filter(e => within(e.admitted_on) && (!sites || sites.includes(e.site_code)));
  return dialMoves.length > 0 || episodeMoves.length > 0
    ? { dialysis_versions: dialMoves, episodes: episodeMoves }
    : null;
}

function decorate(timeline, conflict) {
  const eventDate = conflict.event_date;
  const windows = matchingExceptions(timeline, eventDate, conflict.drug_code, conflict.sites ?? null);
  const matched = windows.map(w => ({
    reason: w.reason,
    source: w.source,
    valid_from: w.start,
    valid_to: w.end,
    confirmed_by: w.confirmed_by ?? null,
    active_as_of: covers(w.start, w.end, timeline.as_of),
    corroboration: w.reason === 'transfer'
      ? corroboratedByCare(timeline, eventDate, conflict.sites ?? null)
      : null,
  }));
  conflict.exceptions = matched;

  const explanations = [
    ...timeline.notes.map(n => ({ kind: 'clinician_note', id: n.note_id, on: n.noted_on, text: n.text, by: n.by, links: n.links, related_prescription_ids: n.related_prescription_ids })),
    ...timeline.supplements.map(s => ({ kind: 'hospital_supplement', id: s.supplement_id, on: s.submitted_on, text: s.text, site_code: s.site_code, links: s.links, related_prescription_ids: s.related_prescription_ids })),
    ...timeline.corrections.map(c => ({ kind: 'patient_correction', id: c.correction_id, on: c.submitted_on, text: c.text, links: c.links, related_prescription_ids: c.related_prescription_ids })),
  ];
  const hits = explanationMatches(explanations, conflict.conflict_id, conflict.prescription_ids ?? []);
  conflict.explanations = hits.map(describeExplanation);

  const review = timeline.reviews.get(conflict.conflict_id);
  conflict.review = review ? {
    review_id: review.review_id,
    decision: review.decision,
    decided_on: review.decided_on,
    rationale: review.rationale ?? null,
    by: review.__actor.id,
  } : null;

  // 状态裁定（历史事件不因窗口到期被翻案；到期仅意味着不再覆盖未来的新事件）：
  // 复核结论最优先 → 事件日命中的有期限例外 → 已提交说明 → 尚待说明。
  if (review?.decision === 'resolved') conflict.status = CONFLICT_STATUS.RESOLVED;
  else if (review?.decision === 'escalate_investigation') conflict.status = CONFLICT_STATUS.INVESTIGATION;
  else if (review?.decision === 'upheld') conflict.status = CONFLICT_STATUS.UPHELD;
  else if (matched.length > 0) conflict.status = CONFLICT_STATUS.EXCEPTED;
  else if (hits.length > 0) conflict.status = CONFLICT_STATUS.EXPLAINED;
  else conflict.status = CONFLICT_STATUS.OPEN;

  return conflict;
}

export function detectConflicts(timeline) {
  const conflicts = [];
  const events = timeline._internal.dispenseEvents;

  // 1) 同日重复：同一药品、同一日、≥2 家不同机构领取。
  const byDrugDate = new Map();
  for (const ev of events) {
    const key = `${ev.drug_code}@${ev.dispensed_on}`;
    if (!byDrugDate.has(key)) byDrugDate.set(key, []);
    byDrugDate.get(key).push(ev);
  }
  for (const [key, group] of byDrugDate) {
    const sites = [...new Set(group.map(g => g.site_code))];
    if (sites.length < 2) continue;
    const [drugCode, date] = key.split('@');
    const ceiling = regimenCeiling(timeline._internal.regimens, date, drugCode);
    conflicts.push(decorate(timeline, {
      conflict_id: makeId(timeline.patient_code, CONFLICT_TYPES.SAME_DAY_DUPLICATE, [drugCode, date, sites.join(',')]),
      type: CONFLICT_TYPES.SAME_DAY_DUPLICATE,
      severity: 'high',
      drug_code: drugCode,
      event_date: date,
      site_code: sites[0],
      sites,
      prescription_ids: group.map(g => g.prescription_id),
      metrics: {
        dispense_count: group.length,
        total_quantity: group.reduce((s, g) => s + g.quantity, 0),
        unit: group[0].unit,
        near_label_max_dose: ceiling ? group.some(g => g.daily_dose >= ceiling.daily_max) : false,
      },
    }));
  }

  // 同日重复组涉及的领取不再重复报“间隔异常”。
  const inSameDayDup = new Set();
  for (const group of byDrugDate.values()) {
    if (new Set(group.map(g => g.site_code)).size >= 2) {
      for (const g of group) inSameDayDup.add(`${g.drug_code}@${g.dispensed_on}@${g.prescription_id}`);
    }
  }

  // 2) 间隔异常：本次领取时旧库存按模拟仍可覆盖超过宽限天数。
  for (const [drugCode, supply] of timeline.supply) {
    let prev = null;
    for (const ev of supply.events) {
      if (prev != null) {
        const signature = `${ev.drug_code}@${ev.dispensed_on}@${ev.prescription_id}`;
        if (!inSameDayDup.has(signature) && ev.overlap_days >= EARLY_REFILL_GRACE_DAYS) {
          const gap = daysBetween(prev.dispensed_on, ev.dispensed_on);
          const ceiling = regimenCeiling(timeline._internal.regimens, ev.dispensed_on, drugCode);
          conflicts.push(decorate(timeline, {
            conflict_id: makeId(timeline.patient_code, CONFLICT_TYPES.EARLY_REFILL,
              [drugCode, prev.dispensed_on, ev.dispensed_on]),
            type: CONFLICT_TYPES.EARLY_REFILL,
            severity: ev.overlap_days >= 7 ? 'high' : 'warning',
            drug_code: drugCode,
            event_date: ev.dispensed_on,
            site_code: ev.site_code,
            sites: [...new Set([prev.site_code, ev.site_code])],
            prescription_ids: [prev.prescription_id, ev.prescription_id],
            metrics: {
              gap_days: gap,
              prior_supply_days: prev.supply_days,
              overlap_days: ev.overlap_days,
              near_label_max_dose: ceiling ? ev.daily_dose >= ceiling.daily_max : false,
            },
          }));
        }
      }
      prev = ev;
    }
  }

  // 3) 剂量重叠：不同机构、同一药品的处方覆盖区间相交（撤销日截断覆盖区间）。
  const rxList = timeline.prescriptions.map(rx => ({
      prescription_id: rx.prescription_id,
      site_code: rx.site_code,
      drug_code: rx.drug_code,
      daily_dose: rx.daily_dose,
      unit: rx.unit,
      cover_from: rx.issued_on,
      cover_to: addDays(rx.issued_on, Math.floor(rx.quantity / rx.daily_dose)),
      voided_on: rx.voided_on,
    }));
  for (let i = 0; i < rxList.length; i++) {
    for (let j = i + 1; j < rxList.length; j++) {
      const a = rxList[i];
      const b = rxList[j];
      if (a.drug_code !== b.drug_code || a.site_code === b.site_code) continue;
      const aEnd = a.voided_on && a.voided_on < a.cover_to ? a.voided_on : a.cover_to;
      const bEnd = b.voided_on && b.voided_on < b.cover_to ? b.voided_on : b.cover_to;
      const overlapFrom = a.cover_from < b.cover_from ? b.cover_from : a.cover_from;
      const overlapTo = aEnd < bEnd ? aEnd : bEnd;
      if (overlapFrom >= overlapTo) continue;
      const ceiling = regimenCeiling(timeline._internal.regimens, overlapFrom, a.drug_code);
      conflicts.push(decorate(timeline, {
        conflict_id: makeId(timeline.patient_code, CONFLICT_TYPES.DOSE_OVERLAP,
          [a.drug_code, a.prescription_id, b.prescription_id]),
        type: CONFLICT_TYPES.DOSE_OVERLAP,
        severity: 'high',
        drug_code: a.drug_code,
        event_date: overlapFrom,
        site_code: a.site_code,
        sites: [a.site_code, b.site_code],
        prescription_ids: [a.prescription_id, b.prescription_id],
        metrics: {
          overlap_from: overlapFrom,
          overlap_to: overlapTo,
          overlap_days: daysBetween(overlapFrom, overlapTo),
          combined_daily_dose: a.daily_dose + b.daily_dose,
          unit: a.unit,
          exceeds_label_max: ceiling ? a.daily_dose + b.daily_dose > ceiling.daily_max : null,
        },
      }));
    }
  }

  conflicts.sort((a, b) => a.event_date < b.event_date ? -1
    : a.event_date > b.event_date ? 1
    : a.conflict_id < b.conflict_id ? -1 : 1);
  return conflicts;
}
