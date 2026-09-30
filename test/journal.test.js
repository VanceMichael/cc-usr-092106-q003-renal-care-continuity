import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseJournal, appendFact } from '../src/journal.js';

const load = async (name) => parseJournal(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

test('两份样例日志均可解析', async () => {
  const a = await load('journal.patient-0427.json');
  const b = await load('journal.patient-0913.json');
  assert.equal(a.patient_code, 'P-REN-0427');
  assert.equal(b.patient_code, 'P-REN-0913');
});

test('seq 必须从 1 连续递增', async () => {
  const j = await load('journal.patient-0427.json');
  j.facts[1].seq = 99;
  assert.throws(() => parseJournal(JSON.stringify(j)), /seq 必须从 1 连续递增/);
});

test('fact_id 不允许重复', async () => {
  const j = await load('journal.patient-0913.json');
  j.facts[1].fact_id = j.facts[0].fact_id;
  assert.throws(() => parseJournal(JSON.stringify(j)), /fact_id 重复/);
});

test('遗传信息与完整病历必须标记 restricted，反之不允许滥用', async () => {
  const j = await load('journal.patient-0913.json');
  const genetic = j.facts.find((f) => f.type === 'genetic_result');
  genetic.sensitivity = 'ordinary';
  assert.throws(() => parseJournal(JSON.stringify(j)), /必须标记为 restricted/);

  const j2 = await load('journal.patient-0913.json');
  const dp = j2.facts.find((f) => f.type === 'dispense');
  dp.sensitivity = 'restricted';
  assert.throws(() => parseJournal(JSON.stringify(j2)), /仅遗传信息与完整病历可标记为 restricted/);
});

test('缺药替代例外必须经人工确认并记录确认人', async () => {
  const j = await load('journal.patient-0427.json');
  const ex = j.facts.find((f) => f.fact_id === 'f-0427-23');
  delete ex.data.manually_confirmed;
  assert.throws(() => parseJournal(JSON.stringify(j)), /必须经人工确认/);

  const j2 = await load('journal.patient-0427.json');
  delete j2.facts.find((f) => f.fact_id === 'f-0427-23').data.confirmed_by;
  assert.throws(() => parseJournal(JSON.stringify(j2)), /必须记录确认人/);
});

test('例外必须附证据且有效期合法', async () => {
  const j = await load('journal.patient-0427.json');
  const ex = j.facts.find((f) => f.fact_id === 'f-0427-18');
  ex.data.evidence = [];
  assert.throws(() => parseJournal(JSON.stringify(j)), /至少一项证据/);

  const j2 = await load('journal.patient-0427.json');
  const ex2 = j2.facts.find((f) => f.fact_id === 'f-0427-18');
  ex2.data.valid_to = '2026-09-17';
  assert.throws(() => parseJournal(JSON.stringify(j2)), /valid_to 早于 valid_from/);
});

test('撤销/补传必须引用存在的事实', async () => {
  const j = await load('journal.patient-0427.json');
  j.facts.find((f) => f.fact_id === 'f-0427-28').data.target_fact_id = 'f-NOPE';
  assert.throws(() => parseJournal(JSON.stringify(j)), /引用了不存在的事实/);
});

test('解除限制必须指向已登记的临时限制', async () => {
  const j = await load('journal.patient-0427.json');
  j.facts.find((f) => f.fact_id === 'f-0427-16').data.hold_id = 'HOLD-NOPE';
  assert.throws(() => parseJournal(JSON.stringify(j)), /解除了不存在的临时限制/);
});

test('appendFact 只追加：自动分配 seq、不修改原日志、原事实不可变', async () => {
  const j = await load('journal.patient-0913.json');
  const before = JSON.stringify(j);
  const next = appendFact(j, {
    fact_id: 'f-0913-15',
    type: 'review',
    at: '2026-09-26T16:00:00+08:00',
    recorded_by: { actor_code: 'REG-7', role: 'regulator' },
    sensitivity: 'ordinary',
    data: {
      review_id: 'REV-0913-01',
      conflict_refs: ['same_day_duplicate:ESA'],
      decision: 'refer_investigation',
      reviewer_code: 'REG-7',
      rationale: '同日多院重复取药且例外已过期，转调查。',
    },
  });
  assert.equal(next.facts.length, j.facts.length + 1);
  assert.equal(next.facts.at(-1).seq, j.facts.length + 1);
  assert.equal(JSON.stringify(j), before, '原日志对象未被修改');
});

test('appendFact 拒绝重复 fact_id', async () => {
  const j = await load('journal.patient-0913.json');
  assert.throws(
    () => appendFact(j, {
      fact_id: 'f-0913-01',
      type: 'review',
      at: '2026-09-26T16:00:00+08:00',
      recorded_by: { actor_code: 'REG-7', role: 'regulator' },
      sensitivity: 'ordinary',
      data: {
        review_id: 'REV-X',
        conflict_refs: ['same_day_duplicate:ESA'],
        decision: 'refer_investigation',
        reviewer_code: 'REG-7',
        rationale: 'x',
      },
    }),
    /fact_id 重复/,
  );
});
