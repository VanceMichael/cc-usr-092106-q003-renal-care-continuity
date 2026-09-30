// 时间线折叠：把只追加的事实流还原成某患者在某日的用药连续性状态。
//
// 折叠是纯函数：同样的事实集合永远得到同样的结果；
// 撤销、更正、复核都通过“后出现的事实改变当前状态”，旧事实保留可审计。

import { FACT_TYPES, EXCEPTION_REASONS } from './facts.js';
import { addDays, daysBetween, covers, toIsoDate } from './dates.js';

function sortByDate(list, dateKey) {
  return list.slice().sort((a, b) => {
    const d = a[dateKey] < b[dateKey] ? -1 : a[dateKey] > b[dateKey] ? 1 : 0;
    return d !== 0 ? d : a.__seq - b.__seq;
  });
}

function groupByPatient(facts) {
  const map = new Map();
  for (const f of facts) {
    const code = f.payload.patient_code;
    if (!code) continue; // 入册前的技术性事实在此模型中不存在
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(f);
  }
  return map;
}

// 在 asOf 日生效的“区间版本”中最新的一条（effective_from <= asOf）。
function versionAt(versions, asOf, fromKey = 'effective_from') {
  let current = null;
  for (const v of versions) {
    if (v[fromKey] <= asOf) {
      if (!current || v[fromKey] >= current[fromKey] || v.__seq > current.__seq) current = v;
    }
  }
  return current;
}

// 按药品模拟库存：每次领取补充 supply_days 天，两次领取之间逐日消耗。
function simulateSupply(dispenseEvents, asOf) {
  const byDrug = new Map();
  for (const ev of sortByDate(dispenseEvents, 'dispensed_on')) {
    const drug = ev.drug_code;
    if (!byDrug.has(drug)) {
      byDrug.set(drug, { events: [], runout: null, stockDays: 0, lastDate: null });
    }
    const state = byDrug.get(drug);
    if (state.lastDate != null) {
      state.stockDays = Math.max(0, state.stockDays - daysBetween(state.lastDate, ev.dispensed_on));
    }
    // 本次领取时仍有旧库存 → 与上次覆盖期重叠的天数（提前取药强度）。
    const overlapDays = state.stockDays;
    const supplyDays = ev.supply_days;
    state.stockDays += supplyDays;
    state.runout = addDays(ev.dispensed_on, state.stockDays);
    state.lastDate = ev.dispensed_on;
    state.events.push({ ...ev, overlap_days: overlapDays, supply_days: supplyDays });
  }

  const result = new Map();
  for (const [drug, state] of byDrug) {
    let availableDays = 0;
    if (state.runout != null) availableDays = Math.max(0, daysBetween(asOf, state.runout));
    result.set(drug, {
      drug_code: drug,
      events: state.events,
      projected_runout: state.runout,
      available_days_as_of: availableDays,
    });
  }
  return result;
}

// 构建区域内所有患者的折叠视图，返回 Map<patient_code, timeline>。
export function buildTimelines(ledger, asOf = '2026-09-30') {
  toIsoDate(asOf);
  const out = new Map();
  const grouped = groupByPatient(ledger.facts());
  for (const [patientCode, facts] of grouped) {
    out.set(patientCode, buildOne(patientCode, facts, asOf));
  }
  return out;
}

export function buildTimeline(ledger, patientCode, asOf = '2026-09-30') {
  const facts = ledger.facts().filter(f => f.payload.patient_code === patientCode);
  if (facts.length === 0) throw new Error(`台账中没有患者 ${patientCode} 的事实`);
  return buildOne(patientCode, facts, asOf);
}

function buildOne(patientCode, facts, asOf) {
  const regimens = [];
  const schedules = [];
  const episodes = [];
  const prescriptions = [];
  const dispenses = [];
  const voids = [];
  const notes = [];
  const corrections = [];
  const supplements = [];
  const grants = [];
  const substitutions = [];
  const holds = [];
  const releases = [];
  const reviews = [];

  for (const f of facts) {
    const p = { ...f.payload, __seq: f.seq, __actor: f.actor };
    switch (f.type) {
      case FACT_TYPES.REGIMEN_VERSION: regimens.push(p); break;
      case FACT_TYPES.DIALYSIS_SCHEDULE: schedules.push(p); break;
      case FACT_TYPES.CARE_EPISODE: episodes.push(p); break;
      case FACT_TYPES.PRESCRIPTION: prescriptions.push(p); break;
      case FACT_TYPES.DISPENSE: dispenses.push(p); break;
      case FACT_TYPES.PRESCRIPTION_VOID: voids.push(p); break;
      case FACT_TYPES.CLINICIAN_NOTE: notes.push(p); break;
      case FACT_TYPES.PATIENT_CORRECTION: corrections.push(p); break;
      case FACT_TYPES.HOSPITAL_SUPPLEMENT: supplements.push(p); break;
      case FACT_TYPES.EXCEPTION_GRANT: grants.push(p); break;
      case FACT_TYPES.SHORTAGE_SUBSTITUTION: substitutions.push(p); break;
      case FACT_TYPES.TEMP_HOLD: holds.push(p); break;
      case FACT_TYPES.TEMP_HOLD_RELEASE: releases.push(p); break;
      case FACT_TYPES.REVIEW_DECISION: reviews.push(p); break;
      default: break;
    }
  }

  // 处方撤销：以撤销日为界（撤销前已领取的记录仍是事实）。
  const voidById = new Map();
  for (const v of sortByDate(voids, 'voided_on')) voidById.set(v.prescription_id, v);
  const prescriptionsView = sortByDate(prescriptions, 'issued_on').map(rx => {
    const v = voidById.get(rx.prescription_id);
    return { ...rx, voided_on: v ? v.voided_on : null, void_reason: v ? v.reason : null };
  });
  const rxById = new Map(prescriptionsView.map(rx => [rx.prescription_id, rx]));

  // 领取事件的覆盖天数优先按其处方剂量计算；找不到处方时回退当日方案剂量。
  const activeRegimen = versionAt(sortByDate(regimens, 'effective_from'), asOf);
  const dispenseEvents = sortByDate(dispenses, 'dispensed_on').map(d => {
    const rx = rxById.get(d.prescription_id);
    let dailyDose = d.daily_dose ?? rx?.daily_dose;
    if (!dailyDose) {
      const regThen = versionAt(regimens, d.dispensed_on);
      const item = regThen?.items.find(i => i.drug_code === d.drug_code);
      dailyDose = item?.daily_dose;
    }
    if (!dailyDose || dailyDose <= 0) {
      throw new Error(`领取 ${d.prescription_id} 无法确定日剂量，不能计算覆盖天数`);
    }
    return {
      patient_code: patientCode,
      prescription_id: d.prescription_id,
      site_code: d.site_code,
      drug_code: d.drug_code,
      unit: d.unit,
      quantity: d.quantity,
      daily_dose: dailyDose,
      dispensed_on: d.dispensed_on,
      supply_days: Math.floor(d.quantity / dailyDose),
      prescription_voided_on: rx?.voided_on ?? null,
      __seq: d.__seq,
    };
  });

  // 例外窗口：统一成 {reason, drugCodes, start, end, source} 便于命中判定。
  const exceptionWindows = [];
  for (const g of grants) {
    exceptionWindows.push({
      reason: g.reason,
      drug_codes: Array.isArray(g.drug_codes) ? g.drug_codes : null,
      start: g.valid_from,
      end: g.valid_to,
      source: `grant:${g.grant_id}`,
      confirmed_by: g.confirmed_by ?? null,
    });
  }
  for (const s of substitutions) {
    exceptionWindows.push({
      reason: EXCEPTION_REASONS.SHORTAGE,
      drug_codes: [s.drug_code],
      start: s.valid_from,
      end: s.valid_to,
      source: `substitution:${s.substitution_id}`,
      confirmed_by: s.confirmed_by,
      site_code: s.site_code,
    });
  }

  // 临时限制：存在未解除（或解除日晚于 asOf）的 hold 即视为当前受限。
  const releaseByHold = new Map();
  for (const r of releases) releaseByHold.set(r.hold_id, r);
  const holdsView = sortByDate(holds, 'held_on').map(h => {
    const r = releaseByHold.get(h.hold_id);
    return {
      hold_id: h.hold_id,
      reason: h.reason,
      held_on: h.held_on,
      released_on: r ? r.released_on : null,
      release_reason: r ? r.release_reason : null,
      released_by: r ? r.__actor : null,
      active: h.held_on <= asOf && (!r || r.released_on > asOf),
    };
  });
  const activeHold = [...holdsView].reverse().find(h => h.active) || null;

  // 复核裁定：每个冲突只保留最新一条裁定（旧裁定仍在事实流中可追溯）。
  const reviewByConflict = new Map();
  for (const r of sortByDate(reviews, 'decided_on')) reviewByConflict.set(r.conflict_id, r);

  const currentSchedule = versionAt(sortByDate(schedules, 'effective_from'), asOf);
  const currentEpisode = sortByDate(episodes, 'admitted_on')
    .reverse()
    .find(e => e.admitted_on <= asOf && (!e.transferred_out_on || e.transferred_out_on > asOf)) || null;

  const regimenItems = activeRegimen ? activeRegimen.items.map(i => ({
    ...i,
    near_label_max: i.daily_max != null && i.daily_dose >= i.daily_max,
  })) : [];

  return {
    patient_code: patientCode,
    as_of: asOf,
    dialysis: currentSchedule ? {
      site_code: currentSchedule.site_code,
      schedule: currentSchedule.schedule,
      effective_from: currentSchedule.effective_from,
      effective_to: currentSchedule.effective_to ?? null,
      versions: sortByDate(schedules, 'effective_from').map(s => ({
        site_code: s.site_code, schedule: s.schedule,
        effective_from: s.effective_from, effective_to: s.effective_to ?? null,
      })),
    } : null,
    current_site: currentEpisode ? {
      site_code: currentEpisode.site_code,
      episode_id: currentEpisode.episode_id,
      admitted_on: currentEpisode.admitted_on,
      transferred_out_on: currentEpisode.transferred_out_on ?? null,
    } : null,
    episodes: sortByDate(episodes, 'admitted_on').map(e => ({
      episode_id: e.episode_id, site_code: e.site_code,
      admitted_on: e.admitted_on, transferred_out_on: e.transferred_out_on ?? null,
      kind: e.kind ?? 'routine',
    })),
    regimen: activeRegimen ? {
      version: activeRegimen.version,
      effective_from: activeRegimen.effective_from,
      items: regimenItems,
    } : null,
    prescriptions: prescriptionsView,
    supply: simulateSupply(dispenseEvents, asOf),
    exceptions: exceptionWindows
      .map(w => ({ ...w, active_as_of: covers(w.start, w.end, asOf) }))
      .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
    holds: holdsView,
    active_hold: activeHold,
    notes: sortByDate(notes, 'noted_on').map(n => ({
      note_id: n.note_id, text: n.text, noted_on: n.noted_on, by: n.__actor.id,
      links: n.links ?? null,
      related_prescription_ids: n.related_prescription_ids ?? null,
    })),
    corrections: sortByDate(corrections, 'submitted_on').map(c => ({
      correction_id: c.correction_id, text: c.text, submitted_on: c.submitted_on,
      links: c.links ?? null,
      related_prescription_ids: c.related_prescription_ids ?? null,
    })),
    supplements: sortByDate(supplements, 'submitted_on').map(s => ({
      supplement_id: s.supplement_id, site_code: s.site_code, text: s.text,
      submitted_on: s.submitted_on,
      links: s.links ?? null,
      related_prescription_ids: s.related_prescription_ids ?? null,
    })),
    reviews: reviewByConflict,
    // 供检测器使用的全量材料（视图层可决定不展示）。
    _internal: { dispenseEvents, exceptionWindows, regimens, substitutions },
  };
}

// 判断某冲突（发生日 eventDate、药种 drug、涉及机构 sites）是否命中有效例外。
// 缺药替代窗口限定在替代机构（该机构出现在冲突涉及机构中即可）；
// 转院/急诊授予不按机构收窄。
export function matchingExceptions(timeline, eventDate, drugCode, sites = null) {
  const siteList = sites == null ? [] : (Array.isArray(sites) ? sites : [sites]);
  return timeline._internal.exceptionWindows.filter(w =>
    covers(w.start, w.end, eventDate)
    && (w.drug_codes == null || w.drug_codes.includes(drugCode))
    && (!w.site_code || siteList.length === 0 || siteList.includes(w.site_code)),
  );
}
