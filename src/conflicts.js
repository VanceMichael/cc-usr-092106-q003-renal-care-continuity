// 冲突检测：同日重复、间隔异常、剂量重叠，以及接近说明书上限提示。
// 检测只产出"待说明的冲突"；有效期限内的转院/急诊/人工确认缺药替代
// 作为有期限例外把冲突标记为 excepted，而不是删除冲突。

const DEFAULT_OPTIONS = {
  min_interval_days: 14, // 同类药两次取药间隔低于该天数视为间隔异常
  near_label_ratio: 0.9, // 达到说明书类别上限 90% 给出提示
};

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function classMax(timeline, classCode) {
  return timeline.catalog.classes.find((c) => c.class_code === classCode)?.daily_dose_max
    ?? timeline.catalog.drugs.filter((d) => d.class_code === classCode).reduce((m, d) => Math.max(m, d.daily_dose_max ?? 0), 0)
    ?? null;
}

function drugMax(timeline, drugCode) {
  return timeline.catalog.drugs.find((d) => d.drug_code === drugCode)?.daily_dose_max ?? null;
}

// 例外是否覆盖该冲突：以冲突发生日是否落在有效期限内为准
// （例外可以已到期——它仍解释窗口内发生过的事实，但不能覆盖窗口外的新事件）。
export function exceptionCovers(exception, conflict) {
  const inWindow = conflict.dates.some((date) => date >= exception.valid_from && date <= exception.valid_to);
  if (!inWindow) return false;
  if (exception.kind === 'shortage_substitution' && !exception.manually_confirmed) return false;
  if (exception.linked_orgs.length > 0) {
    const scoped = conflict.orgs.every((org) => exception.linked_orgs.includes(org));
    if (!scoped) return false;
  }
  return true;
}

function makeConflict(rule, severity, subject, payload) {
  const refKey = `${rule}:${subject}`;
  const { dedupe, ...rest } = payload;
  const suffix = dedupe ?? (payload.dispense_ids.join('|') || payload.prescription_ids.join('|'));
  return {
    conflict_id: `${refKey}@${payload.dates[0]}:${suffix}`,
    ref: refKey,
    rule,
    severity,
    ...rest,
    matched_exceptions: [],
    status: 'open', // open -> excepted | reviewed | flagged
    review: null,
  };
}

export function detectConflicts(timeline, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rows = timeline.dispense_rows.filter((r) => r.take_home && !r.prescription_voided);
  const byClass = new Map();
  for (const row of rows) {
    if (!row.class_code) continue;
    const list = byClass.get(row.class_code) ?? [];
    list.push(row);
    byClass.set(row.class_code, list);
  }

  const conflicts = [];

  for (const [classCode, list] of byClass) {
    // 1) 同日重复：同一治疗类别同日在不同机构领取。
    const byDate = new Map();
    for (const row of list) {
      const day = byDate.get(row.date) ?? [];
      day.push(row);
      byDate.set(row.date, day);
    }
    for (const [date, sameDay] of byDate) {
      const orgs = [...new Set(sameDay.map((r) => r.org_id))];
      if (sameDay.length > 1 && orgs.length > 1) {
        conflicts.push(makeConflict('same_day_duplicate', 'high', classCode, {
          class_code: classCode,
          dates: [date],
          dispense_ids: sameDay.map((r) => r.dispense_id),
          prescription_ids: [...new Set(sameDay.map((r) => r.prescription_id))],
          orgs,
          details: {
            message: `同日在 ${orgs.length} 家机构领取同类药物 ${classCode}`,
            quantities: sameDay.map((r) => ({ dispense_id: r.dispense_id, org_id: r.org_id, quantity: r.quantity, unit: r.unit })),
          },
        }));
      }
    }

    // 2) 间隔异常：按时间排序的相邻领取间隔过短（上一份覆盖期内再次取药）。
    const ordered = [...list].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      const gap = daysBetween(prev.date, cur.date);
      const coverageRemaining = prev.days_supply - gap;
      if (gap < opts.min_interval_days && coverageRemaining > 0 && prev.org_id !== cur.org_id) {
        conflicts.push(makeConflict('interval_anomaly', 'high', classCode, {
          class_code: classCode,
          dates: [cur.date],
          dispense_ids: [prev.dispense_id, cur.dispense_id],
          prescription_ids: [...new Set([prev.prescription_id, cur.prescription_id])],
          orgs: [...new Set([prev.org_id, cur.org_id])],
          details: {
            message: `距上次同类取药仅 ${gap} 天，上一份预计尚余 ${coverageRemaining} 天`,
            gap_days: gap,
            prior_days_supply: prev.days_supply,
            coverage_remaining_days: coverageRemaining,
          },
        }));
      }
    }
  }

  // 3) 剂量重叠：某日多家机构的同类有效处方日剂量合计超过类别上限。
  // 处方即使日后被撤销，其在历史当日形成的重叠仍需保留（撤销事实另行留痕）。
  const allRx = timeline.prescriptions;
  const overlapDates = new Set();
  for (const row of rows) {
    if (row.class_code) overlapDates.add(`${row.class_code}|${row.date}`);
  }
  for (const key of overlapDates) {
    const [classCode, date] = key.split('|');
    const max = classMax(timeline, classCode);
    if (max == null) continue;
    const activeThatDay = allRx.filter((rx) => {
      const rxClass = timeline.catalog.drugs.find((d) => d.drug_code === rx.drug_code)?.class_code;
      if (rxClass !== classCode) return false;
      const rxStart = rx.at.slice(0, 10);
      const rxEnd = addDaysLocal(rxStart, rx.prescribed_for_days ?? 0);
      return date >= rxStart && date < rxEnd;
    });
    // 同一机构当日多张处方取最大日剂量，避免同院续方重复累计。
    const perOrg = new Map();
    const rxIds = [];
    for (const rx of activeThatDay) {
      perOrg.set(rx.org_id, Math.max(perOrg.get(rx.org_id) ?? 0, rx.daily_dose));
      rxIds.push(rx.prescription_id);
    }
    if (perOrg.size > 1) {
      const combined = [...perOrg.values()].reduce((a, b) => a + b, 0);
      if (combined > max) {
        conflicts.push(makeConflict('dose_overlap', 'high', classCode, {
          class_code: classCode,
          dates: [date],
          dispense_ids: rows.filter((r) => r.class_code === classCode && r.date === date).map((r) => r.dispense_id),
          prescription_ids: [...new Set(rxIds)],
          orgs: [...perOrg.keys()],
          details: {
            message: `${date} 多机构同类处方合计日剂量 ${combined} 超过类别上限 ${max}`,
            combined_daily_dose: combined,
            daily_dose_max: max,
            per_org: [...perOrg.entries()].map(([org_id, daily_dose]) => ({ org_id, daily_dose })),
            later_voided_prescription_ids: activeThatDay.filter((rx) => rx.voided).map((rx) => rx.prescription_id),
          },
          dedupe: rxIds.slice().sort().join('|'),
        }));
      }
    }
  }

  // 4) 接近说明书上限：单张处方日剂量达到类别/药品上限阈值（提示而非硬冲突）。
  for (const rx of allRx) {
    const drug = timeline.catalog.drugs.find((d) => d.drug_code === rx.drug_code);
    const max = drug?.daily_dose_max ?? (drug?.class_code ? classMax(timeline, drug.class_code) : null);
    if (max == null) continue;
    if (rx.daily_dose >= max * opts.near_label_ratio) {
      const subject = rx.drug_code;
      conflicts.push({
        conflict_id: `near_label_max:${subject}@${rx.at.slice(0, 10)}:${rx.prescription_id}`,
        ref: `near_label_max:${subject}`,
        rule: 'near_label_max',
        severity: 'advisory',
        drug_code: rx.drug_code,
        class_code: drug?.class_code ?? null,
        dates: [rx.at.slice(0, 10)],
        dispense_ids: [],
        prescription_ids: [rx.prescription_id],
        orgs: [rx.org_id],
        details: {
          message: `处方日剂量 ${rx.daily_dose} 达到说明书上限 ${max} 的 ${Math.round((rx.daily_dose / max) * 100)}%`,
          daily_dose: rx.daily_dose,
          daily_dose_max: max,
          regimen_version: rx.regimen_version,
        },
        matched_exceptions: [],
        status: 'open',
        review: null,
      });
    }
  }

  attachExceptions(conflicts, timeline);
  attachReviews(conflicts, timeline);
  return conflicts.sort((a, b) => (a.conflict_id < b.conflict_id ? -1 : 1));
}

function addDaysLocal(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function attachExceptions(conflicts, timeline) {
  for (const conflict of conflicts) {
    const matched = timeline.exceptions
      .filter((ex) => exceptionCovers(ex, conflict))
      .map((ex) => ({
        exception_id: ex.exception_id,
        kind: ex.kind,
        valid_from: ex.valid_from,
        valid_to: ex.valid_to,
        reason: ex.reason,
        evidence: ex.evidence,
        manually_confirmed: ex.manually_confirmed,
      }));
    conflict.matched_exceptions = matched;
    if (matched.length > 0 && conflict.status === 'open') conflict.status = 'excepted';
  }
}

function attachReviews(conflicts, timeline) {
  // review 事实不在 timeline 对象里直接暴露，由调用方通过原始日志注入更稳妥；
  // 这里兼容 timeline.reviews（由 analyzeJournal 预填）。
  for (const review of timeline.reviews ?? []) {
    for (const conflict of conflicts) {
      const cited = review.conflict_refs.some(
        (ref) => ref === conflict.conflict_id || ref === conflict.ref
          || ref === `${conflict.rule}:${conflict.drug_code ?? conflict.class_code}`,
      );
      if (!cited) continue;
      conflict.review = {
        review_id: review.review_id,
        decision: review.decision,
        reviewer_code: review.reviewer_code,
        rationale: review.rationale,
        at: review.at,
      };
      if (review.decision === 'evidence_sufficient') conflict.status = 'reviewed';
      if (review.decision === 'refer_investigation') conflict.status = 'flagged';
    }
  }
}

// 监管分流：区分治疗连续性证据充分与需要转入调查的记录。
export function triage(timeline, conflicts) {
  const open = conflicts.filter((c) => c.status === 'open' && c.severity !== 'advisory');
  const openAdvisories = conflicts.filter((c) => c.status === 'open' && c.severity === 'advisory');
  const flagged = conflicts.filter((c) => c.status === 'flagged');
  const explained = conflicts.filter((c) => c.status === 'excepted' || c.status === 'reviewed');
  const activeHolds = timeline.holds.filter((h) => !h.lifted);

  let disposition;
  if (flagged.length > 0 || open.length > 0) {
    disposition = 'refer_investigation';
  } else if (activeHolds.length > 0) {
    disposition = 'pending_explanation';
  } else {
    disposition = 'evidence_sufficient';
  }

  return {
    patient_code: timeline.patient_code,
    as_of: timeline.as_of,
    disposition,
    evidence: {
      continuity_conflicts: explained.map((c) => ({ conflict_id: c.conflict_id, rule: c.rule, status: c.status, matched_exceptions: c.matched_exceptions, review: c.review })),
      unresolved_conflicts: [...flagged, ...open].map((c) => ({ conflict_id: c.conflict_id, rule: c.rule, severity: c.severity, message: c.details.message })),
      advisories: openAdvisories.map((c) => ({ conflict_id: c.conflict_id, rule: c.rule, message: c.details.message })),
      active_holds: activeHolds.map((h) => h.hold_id),
      lifted_holds: timeline.holds.filter((h) => h.lifted).map((h) => ({ hold_id: h.hold_id, lift: h.lift })),
      exceptions: timeline.exceptions.map((e) => ({
        exception_id: e.exception_id,
        kind: e.kind,
        active: e.active,
        expired: e.expired,
        valid_from: e.valid_from,
        valid_to: e.valid_to,
      })),
    },
  };
}
