import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseJournal } from '../src/journal.js';
import { buildTimeline } from '../src/timeline.js';
import { analyzeJournal } from '../src/analyze.js';

const load = async (name) => parseJournal(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

test('投影当前透析安排与方案版本', async () => {
  const j = await load('journal.patient-0427.json');
  const tl = buildTimeline(j);
  assert.equal(tl.dialysis_current.facility_org_id, 'ORG-YI');
  assert.equal(tl.dialysis_current.pattern, 'MON/WED/FRI');
  assert.equal(tl.regimen_current.version, 2);
  assert.deepEqual(
    tl.regimen_current.drugs.map((d) => d.drug_code).sort(),
    ['D002', 'D101'],
  );
});

test('已领取数量与预计可用天数按治疗类别合并（D001/D002 同属 ESA）', async () => {
  const j = await load('journal.patient-0427.json');
  const tl = buildTimeline(j, { asOf: '2026-09-28' });
  const esa = tl.coverage.find((c) => c.class_code === 'ESA');
  assert.ok(esa, '应有 ESA 覆盖');
  assert.equal(esa.available_until, '2026-10-17');
  assert.equal(esa.predicted_available_days, 19);
  assert.equal(esa.intervals[0].from, '2026-09-15');
});

test('医院补传的住院现场给药不计入带回家库存', async () => {
  const j = await load('journal.patient-0427.json');
  const tl = buildTimeline(j, { asOf: '2026-09-28' });
  const dp = tl.dispense_rows.find((r) => r.dispense_id === 'DP-0427-03');
  assert.equal(dp.inpatient_administration, true);
  assert.equal(dp.take_home, false);
});

test('处方撤销后保留历史，但被撤销处方的领取不再计入覆盖区间', async () => {
  const j = await load('journal.patient-0427.json');
  const tl = buildTimeline(j, { asOf: '2026-09-28' });
  const rx = tl.prescriptions.find((p) => p.prescription_id === 'RX-0427-01');
  assert.equal(rx.voided, true);
  assert.ok(rx.void_record.reason.includes('转出'));
  const first = tl.dispense_rows.find((r) => r.dispense_id === 'DP-0427-01');
  assert.equal(first.prescription_voided, true);
  const esa = tl.coverage.find((c) => c.class_code === 'ESA');
  assert.equal(esa.intervals[0].from, '2026-09-15', '9月1日被撤销处方不产生覆盖区间起点');
});

test('restricted 事实存在但内容不进入投影（遗传/病历只留密封引用）', async () => {
  const j = await load('journal.patient-0427.json');
  const tl = buildTimeline(j);
  const restricted = j.facts.filter((f) => f.sensitivity === 'restricted');
  assert.ok(restricted.length >= 2);
  assert.ok(!('genetic_result' in tl), '时间线中不应有遗传信息字段');
  assert.ok(!('full_record_import' in tl), '时间线中不应有完整病历字段');
  assert.ok(tl.dispense_rows.length > 0);
});

test('0913：同日两家医院取 ESA 触发同日重复', async () => {
  const j = await load('journal.patient-0913.json');
  const a = analyzeJournal(j);
  const dup = a.conflicts.filter((c) => c.rule === 'same_day_duplicate');
  assert.equal(dup.length, 1);
  assert.deepEqual([...dup[0].orgs].sort(), ['ORG-BING', 'ORG-DING']);
  assert.equal(dup[0].status, 'open');
});

test('0913：间隔异常（5天/0天）均无例外覆盖', async () => {
  const j = await load('journal.patient-0913.json');
  const a = analyzeJournal(j);
  const gaps = a.conflicts.filter((c) => c.rule === 'interval_anomaly');
  assert.equal(gaps.length, 2);
  assert.ok(gaps.every((c) => c.matched_exceptions.length === 0));
});

test('0913：剂量重叠合并同院取最大，三家机构合计 12000 > 上限 4000', async () => {
  const j = await load('journal.patient-0913.json');
  const a = analyzeJournal(j);
  const overlap = a.conflicts.filter((c) => c.rule === 'dose_overlap');
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].details.combined_daily_dose, 12000);
  assert.equal(overlap[0].details.daily_dose_max, 4000);
  assert.equal(overlap[0].orgs.length, 3);
});

test('0427：9月15日的剂量重叠被转院例外覆盖并经复核闭环', async () => {
  const j = await load('journal.patient-0427.json');
  const a = analyzeJournal(j);
  const c = a.conflicts.find((c) => c.conflict_id.startsWith('dose_overlap:ESA@2026-09-15'));
  assert.ok(c);
  assert.ok(c.matched_exceptions.some((e) => e.kind === 'transfer'));
  assert.equal(c.status, 'reviewed');
  assert.equal(c.review.decision, 'evidence_sufficient');
});

test('0427：9月22日间隔异常被人工确认的缺药替代例外覆盖（复核后闭环）', async () => {
  const j = await load('journal.patient-0427.json');
  const a = analyzeJournal(j);
  const c = a.conflicts.find((c) => c.conflict_id.startsWith('interval_anomaly:ESA@2026-09-22'));
  assert.ok(c);
  assert.ok(c.matched_exceptions.some((e) => e.kind === 'shortage_substitution'));
  assert.ok(['excepted', 'reviewed'].includes(c.status));
});

test('0913：8月转院例外有效期不含 9月25日，不构成覆盖', async () => {
  const j = await load('journal.patient-0913.json');
  const a = analyzeJournal(j);
  assert.ok(a.timeline.exceptions[0].expired);
  assert.ok(a.conflicts.every((c) => c.matched_exceptions.length === 0));
});

test('急诊补救剂量（4000）产生近上限提示并被急诊例外+复核闭环', async () => {
  const j = await load('journal.patient-0427.json');
  const a = analyzeJournal(j);
  const adv = a.conflicts.find((c) => c.conflict_id.includes('RX-0427-03'));
  assert.equal(adv.rule, 'near_label_max');
  assert.ok(adv.matched_exceptions.some((e) => e.kind === 'emergency'));
  assert.equal(adv.status, 'reviewed');
});
