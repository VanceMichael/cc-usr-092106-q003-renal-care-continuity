import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createLedger, ingest, evaluateRegion,
  FACT_TYPES, EXCEPTION_REASONS, ROLES,
  CONFLICT_TYPES, CONFLICT_STATUS, REGULATOR_BUCKETS,
} from '../src/index.js';

const op = { id: 'op-1', role: ROLES.HOSPITAL_OPERATOR };
const clinician = { id: 'dr-1', role: ROLES.CLINICIAN };
const regulator = { id: 'reg-1', role: ROLES.REGULATOR };
const authorizer = { id: 'auth-1', role: ROLES.AUTHORIZER };

let fixture;
async function loadFixtureRegion(asOf = '2026-09-30') {
  if (!fixture) {
    const raw = await readFile(new URL('../fixtures/timeline.json', import.meta.url), 'utf8');
    fixture = JSON.parse(raw);
  }
  const ledger = createLedger();
  ingest(ledger, fixture.records);
  return evaluateRegion(ledger, asOf);
}

function byType(conflicts, type) {
  return conflicts.filter(c => c.type === type);
}

test('虚构样例可整体重放：三位患者、事实只追加', async () => {
  const region = await loadFixtureRegion();
  assert.equal(region.timelines.size, 3);
  for (const code of ['P-CKD-1001', 'P-CKD-1002', 'P-CKD-1003']) {
    assert.ok(region.timelines.has(code));
  }
});

test('预计可用天数：按库存模拟计算，跨院领取计入同一条药品线', async () => {
  const region = await loadFixtureRegion();
  const t = region.timelines.get('P-CKD-1001');
  const esa = t.supply.get('ESA-ALFA');
  // 07-21 领 30 天 → 08-20 当日恰好用完再领 30 天 →
  // 09-01 距上次 12 天（尚余 18 天）再领 30 天 → 库存 48 天，runout = 10-19。
  assert.equal(esa.projected_runout, '2026-10-19');
  assert.equal(esa.available_days_as_of, 19); // 09-30 距 10-19
  const third = esa.events.find(e => e.dispensed_on === '2026-09-01');
  assert.equal(third.overlap_days, 18);
});

test('转院续药：同日提前取药与剂量重叠被提示，但落入有期限转院例外且有机构变动印证', async () => {
  const region = await loadFixtureRegion();
  const conflicts = region.conflictsByPatient.get('P-CKD-1001');
  for (const c of conflicts) assert.equal(c.status, CONFLICT_STATUS.EXCEPTED);
  const early = byType(conflicts, CONFLICT_TYPES.EARLY_REFILL)[0];
  assert.equal(early.metrics.overlap_days, 18);
  assert.equal(early.exceptions[0].reason, EXCEPTION_REASONS.TRANSFER);
  assert.ok(early.exceptions[0].valid_to === '2026-09-14');
  assert.ok(early.exceptions[0].corroboration.episodes.length >= 1);
  // 医生说明全文在医患视图可见。
  const pv = region.patientView('P-CKD-1001');
  assert.match(pv.explanations.clinician_notes[0].text, /转院衔接/);
});

test('急诊：同日重复经补传+复核后 resolved，限制由授权人员解除', async () => {
  const region = await loadFixtureRegion();
  const t1002 = region.timelines.get('P-CKD-1002');
  assert.equal(t1002.active_hold, null);
  const releasedHold = t1002.holds.find(h => h.hold_id === 'HOLD-1002-01');
  assert.equal(releasedHold.released_by.role, ROLES.AUTHORIZER);

  const dup = byType(region.conflictsByPatient.get('P-CKD-1002'),
    CONFLICT_TYPES.SAME_DAY_DUPLICATE)[0];
  assert.equal(dup.status, CONFLICT_STATUS.RESOLVED);
  assert.equal(dup.sites.sort().join(','), 'SITE-C,SITE-D');
  assert.equal(dup.review.decision, 'resolved');
});

test('缺药替代：人工确认窗口内的跨院调剂算例外；窗口外处方撤销仍是事实', async () => {
  const region = await loadFixtureRegion();
  const conflicts = region.conflictsByPatient.get('P-CKD-1002');
  const shortageOverlap = conflicts.find(c =>
    c.type === CONFLICT_TYPES.DOSE_OVERLAP && c.event_date === '2026-09-18');
  assert.equal(shortageOverlap.status, CONFLICT_STATUS.EXCEPTED);
  assert.equal(shortageOverlap.exceptions[0].reason, EXCEPTION_REASONS.SHORTAGE);
  assert.equal(shortageOverlap.exceptions[0].confirmed_by, 'pharmacist-e-05');

  const t = region.timelines.get('P-CKD-1002');
  const voidRx = t.prescriptions.find(rx => rx.prescription_id === 'RX-1002-06');
  assert.equal(voidRx.voided_on, '2026-09-21');
  // 窗口已过期但历史事件状态不被翻案。
  const window = t.exceptions.find(e => e.source === 'substitution:SUB-1002-01');
  assert.equal(window.active_as_of, false);
});

test('无连续性证据的高频跨院行为：同日重复转入调查，患者保持受限', async () => {
  const region = await loadFixtureRegion();
  const t = region.timelines.get('P-CKD-1003');
  assert.equal(t.active_hold.hold_id, 'HOLD-1003-01');
  const dup = byType(region.conflictsByPatient.get('P-CKD-1003'),
    CONFLICT_TYPES.SAME_DAY_DUPLICATE)[0];
  assert.equal(dup.status, CONFLICT_STATUS.INVESTIGATION);
  // 患者更正让另一条冲突进入“已说明待复核”，但不改变调查分类。
  const early = byType(region.conflictsByPatient.get('P-CKD-1003'),
    CONFLICT_TYPES.EARLY_REFILL)[0];
  assert.equal(early.status, CONFLICT_STATUS.EXPLAINED);
  assert.equal(early.explanations[0].kind, 'patient_correction');
});

test('监管视图：证据充分与转入调查分流，且不暴露说明全文/剂量配方细节', async () => {
  const region = await loadFixtureRegion();
  const view = region.regulatorView();
  assert.equal(view.summary.buckets[REGULATOR_BUCKETS.CONTINUITY_SUPPORTED], 2);
  assert.equal(view.summary.buckets[REGULATOR_BUCKETS.INVESTIGATION], 1);

  const byCode = Object.fromEntries(view.patients.map(p => [p.patient_code, p]));
  assert.equal(byCode['P-CKD-1001'].bucket, REGULATOR_BUCKETS.CONTINUITY_SUPPORTED);
  assert.equal(byCode['P-CKD-1002'].bucket, REGULATOR_BUCKETS.CONTINUITY_SUPPORTED);
  assert.equal(byCode['P-CKD-1003'].bucket, REGULATOR_BUCKETS.INVESTIGATION);
  assert.equal(byCode['P-CKD-1003'].under_active_hold, true);

  // 白名单：监管视图不得出现自由文本说明与方案明细字段。
  const { redaction, ...body } = view;
  assert.match(redaction, /遗传信息与完整病历在事实入口拒收/); // 声明头存在
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('完整病历'));
  for (const p of body.patients) {
    for (const c of p.conflicts) {
      for (const e of c.explanations) {
        assert.equal('text' in e, false);
      }
    }
  }
  // 仅见代号，不见真实姓名字段。
  assert.ok(!raw.includes('identity_name'));
});

test('监管复核追加新裁定可改变冲突状态，但旧事实仍在', async () => {
  const raw = await readFile(new URL('../fixtures/timeline.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);
  const ledger = createLedger();
  ingest(ledger, data.records);
  const before = ledger.size();

  // 对 1001 的一条转院例外冲突追加 upheld 裁定（仅监管可做）。
  ledger.append(FACT_TYPES.REVIEW_DECISION, {
    patient_code: 'P-CKD-1001', review_id: 'REV-NEW-01',
    conflict_id: 'P-CKD-1001:early_refill:ESA-ALFA|2026-08-20|2026-09-01',
    decision: 'upheld', decided_on: '2026-09-23', rationale: '复核后认定异常成立',
  }, regulator);
  assert.equal(ledger.size(), before + 1);

  const region = evaluateRegion(ledger, '2026-09-30');
  const c = region.conflictsByPatient.get('P-CKD-1001')
    .find(x => x.conflict_id === 'P-CKD-1001:early_refill:ESA-ALFA|2026-08-20|2026-09-01');
  assert.equal(c.status, CONFLICT_STATUS.UPHELD);
});

test('处方撤销截断覆盖区间：撤销后不再报与后开处方的剂量重叠', async () => {
  const ledger = createLedger();
  ledger.append(FACT_TYPES.PATIENT_ALIAS, { patient_code: 'P-X' }, op);
  ledger.append(FACT_TYPES.REGIMEN_VERSION, {
    patient_code: 'P-X', version: 1, effective_from: '2026-09-01',
    items: [{ drug_code: 'D1', daily_dose: 2, daily_max: 4, unit: '片' }],
  }, clinician);
  ledger.append(FACT_TYPES.PRESCRIPTION, {
    patient_code: 'P-X', prescription_id: 'A', site_code: 'S1', drug_code: 'D1',
    daily_dose: 2, unit: '片', quantity: 60, issued_on: '2026-09-01',
  }, clinician);
  ledger.append(FACT_TYPES.PRESCRIPTION, {
    patient_code: 'P-X', prescription_id: 'B', site_code: 'S2', drug_code: 'D1',
    daily_dose: 2, unit: '片', quantity: 60, issued_on: '2026-09-20',
  }, clinician);
  ledger.append(FACT_TYPES.PRESCRIPTION_VOID, {
    patient_code: 'P-X', prescription_id: 'A', voided_on: '2026-09-05', reason: '作废',
  }, op);
  const region = evaluateRegion(ledger, '2026-09-30');
  const overlaps = byType(region.conflictsByPatient.get('P-X'), CONFLICT_TYPES.DOSE_OVERLAP);
  // A 覆盖区间 [09-01, 09-05) 与 B 的 [09-20,...) 不相交。
  assert.equal(overlaps.length, 0);
});

test('授权角色边界：监管不能解除限制，授权人不能开药', async () => {
  const ledger = createLedger();
  ledger.append(FACT_TYPES.PATIENT_ALIAS, { patient_code: 'P-X' }, op);
  ledger.append(FACT_TYPES.TEMP_HOLD, {
    patient_code: 'P-X', hold_id: 'H', reason: 'r', held_on: '2026-09-10',
  }, op);
  assert.throws(() => ledger.append(FACT_TYPES.TEMP_HOLD_RELEASE, {
    patient_code: 'P-X', hold_id: 'H', released_on: '2026-09-11', release_reason: 'x',
  }, regulator), /无权追加/);
  assert.throws(() => ledger.append(FACT_TYPES.PRESCRIPTION, {
    patient_code: 'P-X', prescription_id: 'RX', site_code: 'S1', drug_code: 'D1',
    daily_dose: 1, unit: '片', quantity: 10, issued_on: '2026-09-11',
  }, authorizer), /无权追加/);
});
