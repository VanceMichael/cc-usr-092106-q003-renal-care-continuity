import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseJournal } from '../src/journal.js';
import { activeHolds, canLiftHold, liftHold } from '../src/restrictions.js';
import { analyzeJournal } from '../src/analyze.js';
import { buildPatientView, buildClinicianView, buildRegulatorView } from '../src/views.js';

const load0427 = async () => parseJournal(await readFile(new URL('../fixtures/journal.patient-0427.json', import.meta.url), 'utf8'));
const load0913 = async () => parseJournal(await readFile(new URL('../fixtures/journal.patient-0913.json', import.meta.url), 'utf8'));

test('只有授权人员能解除临时限制', () => {
  assert.equal(canLiftHold({ actor_code: 'AUTH-1', role: 'authorized_officer' }), true);
  assert.equal(canLiftHold({ actor_code: 'REG-1', role: 'regulator' }), false);
  assert.equal(canLiftHold({ actor_code: 'DR-X', role: 'clinician' }), false);
  assert.equal(canLiftHold(null), false);
});

test('0427 的限制已被授权人员解除并留痕', async () => {
  const j = await load0427();
  assert.deepEqual(activeHolds(j), []);
  const lift = j.facts.find((f) => f.type === 'restriction_lift');
  assert.equal(lift.recorded_by.role, 'authorized_officer');
  assert.equal(lift.data.hold_id, 'HOLD-0427-01');
});

test('0913 仍有未解除的临时限制', async () => {
  const j = await load0913();
  assert.equal(activeHolds(j).length, 1);
  assert.equal(activeHolds(j)[0].hold_id, 'HOLD-0913-01');
});

test('监管/医生角色尝试解除会被拒绝', async () => {
  const j = await load0913();
  assert.throws(
    () => liftHold(j, 'HOLD-0913-01', { actor_code: 'REG-7', role: 'regulator' }, '复核通过'),
    /无权解除临时限制/,
  );
  assert.throws(
    () => liftHold(j, 'HOLD-0913-01', { actor_code: 'DR-CHEN', role: 'clinician', org_id: 'ORG-JIA' }, '医生要求解除'),
    /无权解除临时限制/,
  );
});

test('授权人员解除后以追加事实留痕，且不可重复解除', async () => {
  const j = await load0913();
  const before = j.facts.length;
  const next = liftHold(
    j,
    'HOLD-0913-01',
    { actor_code: 'AUTH-09', role: 'authorized_officer' },
    '补充材料核验通过',
    { fact_id: 'f-0913-lift', at: '2026-09-26T18:00:00+08:00' },
  );
  assert.equal(next.facts.length, before + 1);
  assert.equal(next.facts.at(-1).type, 'restriction_lift');
  assert.deepEqual(activeHolds(next), []);
  assert.throws(
    () => liftHold(next, 'HOLD-0913-01', { actor_code: 'AUTH-09', role: 'authorized_officer' }, '再次解除'),
    /已解除/,
  );
  assert.equal(j.facts.length, before, '原日志不被修改');
});

test('解除不存在的限制或缺少理由均报错', async () => {
  const j = await load0913();
  const officer = { actor_code: 'AUTH-09', role: 'authorized_officer' };
  assert.throws(() => liftHold(j, 'HOLD-NOPE', officer, '理由'), /临时限制不存在/);
  assert.throws(() => liftHold(j, 'HOLD-0913-01', officer, ''), /必须填写理由/);
});

test('患者视图：可见待说明冲突、期限例外与处理结果', async () => {
  const a = analyzeJournal(await load0427());
  const v = buildPatientView(a);
  assert.equal(v.view, 'patient');
  assert.deepEqual(v.conflicts_awaiting_explanation, []);
  assert.ok(v.explained_conflicts.length >= 4);
  assert.equal(v.holds[0].lifted, true);
  assert.equal(v.outcome.disposition, 'evidence_sufficient');
  assert.ok(v.medication_coverage[0].predicted_available_days > 0);
});

test('患者视图：0913 能看到尚待说明的冲突', async () => {
  const a = analyzeJournal(await load0913());
  const v = buildPatientView(a);
  assert.ok(v.conflicts_awaiting_explanation.length >= 3);
  assert.equal(v.outcome.disposition, 'refer_investigation');
  assert.equal(v.holds[0].lifted, false);
});

test('医生视图：包含方案版本、医生说明原文与完整剂量细节', async () => {
  const a = analyzeJournal(await load0427());
  const v = buildClinicianView(a);
  assert.equal(v.regimen_versions.length, 2);
  assert.ok(v.clinician_notes.some((n) => n.text.includes('血红蛋白骤降')));
  const overlap = v.conflicts.find((c) => c.rule === 'dose_overlap');
  assert.ok(overlap.details.per_org.length >= 2);
});

test('普通监管视图：不含遗传/病历内容与医生说明原文，但保留分流所需证据', async () => {
  const a = analyzeJournal(await load0427());
  const v = buildRegulatorView(a);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('sealed_ref'), '不出现密封遗传/病历引用');
  assert.ok(!raw.includes('血红蛋白骤降'), '不出现医生说明原文');
  assert.ok(!raw.includes('genetic'));
  const transfer = v.exceptions.find((e) => e.kind === 'transfer');
  assert.equal(transfer.evidence_count, 2);
  assert.equal(v.triage.disposition, 'evidence_sufficient');
  assert.ok(v.triage.evidence.continuity_conflicts.length >= 4);
  assert.deepEqual(v.triage.evidence.unresolved_conflicts, []);
});

test('普通监管视图：0913 列为需转入调查，且例外标记为已过期', async () => {
  const a = analyzeJournal(await load0913());
  const v = buildRegulatorView(a);
  assert.equal(v.triage.disposition, 'refer_investigation');
  assert.ok(v.triage.evidence.unresolved_conflicts.length >= 3);
  assert.equal(v.exceptions[0].expired, true);
  assert.equal(v.holds[0].lifted, false);
});
