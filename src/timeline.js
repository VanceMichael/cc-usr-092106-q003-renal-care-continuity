// 把只追加事实流投影为用药时间线：
// 透析安排、诊疗机构、方案版本、领取记录、已领取数量与预计可用天数。
// 投影是只读的；撤销只标记出处方状态，既往领取事实仍然保留。

function dayOf(timestamp) {
  return timestamp.slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// asOf 默认真实日志中的最后登记日；测试可显式传入（YYYY-MM-DD）。
export function buildTimeline(journal, options = {}) {
  const facts = [...journal.facts].sort((a, b) => a.seq - b.seq);
  const asOf = options.asOf ?? dayOf(facts[facts.length - 1].at);

  const drugs = new Map(); // drug_code -> catalog entry
  const classes = new Map(); // class_code -> catalog entry
  const sites = [];
  const dialysis = [];
  const regimenVersions = [];
  const prescriptions = new Map();
  const dispenses = [];
  const notes = [];
  const exceptions = [];
  const holds = new Map();
  const annotations = new Map(); // fact_id -> 追加的更正/补传信息

  for (const fact of facts) {
    const d = fact.data;
    switch (fact.type) {
      case 'drug_catalog':
        for (const drug of d.drugs ?? []) drugs.set(drug.drug_code, drug);
        break;
      case 'drug_class_catalog':
        for (const cls of d.classes ?? []) classes.set(cls.class_code, cls);
        break;
      case 'site_enrollment':
        sites.push({ org_id: d.org_id, site_role: d.site_role, effective_from: d.effective_from });
        break;
      case 'dialysis_schedule':
        dialysis.push({
          facility_org_id: d.facility_org_id,
          pattern: d.pattern,
          effective_from: d.effective_from,
        });
        break;
      case 'regimen_version':
        regimenVersions.push({ ...d });
        break;
      case 'prescription':
        prescriptions.set(d.prescription_id, {
          ...d,
          fact_id: fact.fact_id,
          at: fact.at,
          voided: false,
          void_record: null,
        });
        break;
      case 'dispense':
        dispenses.push({ ...d, at: fact.at, fact_id: fact.fact_id });
        break;
      case 'clinician_note':
        notes.push({ ...d, at: fact.at });
        break;
      case 'exception_grant':
        exceptions.push({ ...d, granted_at: fact.at });
        break;
      case 'temporary_restriction':
        holds.set(d.hold_id, { hold_id: d.hold_id, scope_prescription_id: d.scope_prescription_id, reason: d.reason, at: fact.at, lifted: false, lift: null });
        break;
      case 'restriction_lift': {
        const hold = holds.get(d.hold_id);
        if (hold) {
          hold.lifted = true;
          hold.lift = { at: fact.at, by: fact.recorded_by.actor_code, reason: d.reason };
        }
        break;
      }
      case 'correction':
      case 'supplement':
        annotations.set(d.target_fact_id, { ...annotations.get(d.target_fact_id), [fact.type]: d, at: fact.at });
        break;
      case 'void': {
        // target_fact_id 指向被撤销处方事实的 fact_id（兼容直接填写处方号）。
        const target = prescriptions.get(d.target_fact_id)
          ?? [...prescriptions.values()].find((p) => p.fact_id === d.target_fact_id || p.prescription_id === d.target_fact_id);
        if (target) {
          target.voided = true;
          target.void_record = { at: fact.at, by: fact.recorded_by.actor_code, reason: d.reason };
        }
        break;
      }
      default:
        break;
    }
  }

  const currentDialysis = [...dialysis].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;
  const activeRegimen = [...regimenVersions]
    .filter((r) => r.active_from <= asOf)
    .sort((a, b) => (a.active_from < b.active_from ? 1 : a.version < b.version ? 1 : -1))[0] ?? null;

  const dispenseRows = dispenses
    .map((dp) => {
      const drug = drugs.get(dp.drug_code);
      const rx = prescriptions.get(dp.prescription_id);
      const note = annotations.get(dp.fact_id) ?? annotations.get(dp.dispense_id) ?? {};
      const supplement = note.supplement;
      const date = dayOf(dp.at);
      // 住院部现场给药（经补传确认）不计入患者带回家的库存覆盖。
      const inpatient = supplement?.inpatient_administration === true;
      return {
        dispense_id: dp.dispense_id,
        prescription_id: dp.prescription_id,
        date,
        org_id: dp.org_id,
        drug_code: dp.drug_code,
        class_code: drug?.class_code ?? null,
        quantity: dp.quantity,
        unit: dp.unit,
        daily_dose: dp.daily_dose,
        days_supply: dp.days_supply,
        covers_from: date,
        covers_until: addDays(date, dp.days_supply),
        take_home: !inpatient,
        inpatient_administration: inpatient,
        prescription_voided: rx?.voided === true,
        regimen_version: rx?.regimen_version ?? null,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date === b.date ? a.dispense_id.localeCompare(b.dispense_id) : 1));

  // 按治疗类别合并带回家库存的覆盖区间（D001/D002 同属 ESA，互为接续）。
  const coverageByClass = new Map();
  for (const row of dispenseRows.filter((r) => r.take_home && !r.prescription_voided)) {
    if (!row.class_code) continue;
    const list = coverageByClass.get(row.class_code) ?? [];
    list.push([row.covers_from, row.covers_until]);
    coverageByClass.set(row.class_code, list);
  }
  const coverage = [...coverageByClass.entries()].map(([class_code, intervals]) => {
    const merged = mergeIntervals(intervals);
    const coveringNow = merged.find(([s, e]) => s <= asOf && asOf < e);
    return {
      class_code,
      intervals: merged.map(([s, e]) => ({ from: s, until: e })),
      predicted_available_days: coveringNow ? daysBetween(asOf, coveringNow[1]) : 0,
      available_until: coveringNow ? coveringNow[1] : null,
    };
  });

  const totalsByDrug = new Map();
  for (const row of dispenseRows) {
    const entry = totalsByDrug.get(row.drug_code) ?? { drug_code: row.drug_code, class_code: row.class_code, unit: row.unit, total_quantity: 0, total_days_supply: 0, take_home_quantity: 0 };
    entry.total_quantity += row.quantity;
    entry.total_days_supply += row.days_supply;
    if (row.take_home) entry.take_home_quantity += row.quantity;
    totalsByDrug.set(row.drug_code, entry);
  }

  return {
    patient_code: journal.patient_code,
    as_of: asOf,
    catalog: {
      drugs: [...drugs.values()],
      classes: [...classes.values()],
    },
    sites,
    dialysis_current: currentDialysis,
    dialysis_history: dialysis,
    regimen_current: activeRegimen,
    regimen_versions: regimenVersions.sort((a, b) => a.version - b.version),
    prescriptions: [...prescriptions.values()],
    dispense_rows: dispenseRows,
    totals_by_drug: [...totalsByDrug.values()],
    coverage,
    clinician_notes: notes,
    exceptions: exceptions.map((ex) => ({
      exception_id: ex.exception_id,
      kind: ex.kind,
      valid_from: ex.valid_from,
      valid_to: ex.valid_to,
      active: ex.valid_from <= asOf && asOf <= ex.valid_to,
      expired: asOf > ex.valid_to,
      evidence: ex.evidence,
      reason: ex.reason,
      linked_orgs: ex.linked_orgs ?? [],
      manually_confirmed: ex.manually_confirmed === true,
      granted_by: ex.granted_by.actor_code,
    })),
    holds: [...holds.values()].map((h) => ({
      hold_id: h.hold_id,
      scope_prescription_id: h.scope_prescription_id,
      reason: h.reason,
      at: h.at,
      lifted: h.lifted,
      lift: h.lift,
    })),
  };
}
