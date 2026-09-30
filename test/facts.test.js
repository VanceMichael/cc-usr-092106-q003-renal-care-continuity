import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger, FACT_TYPES, EXCEPTION_REASONS, ROLES,
} from '../src/facts.js';

const op = { id: 'op-1', role: ROLES.HOSPITAL_OPERATOR };
const clinician = { id: 'dr-1', role: ROLES.CLINICIAN };
const regulator = { id: 'reg-1', role: ROLES.REGULATOR };
const authorizer = { id: 'auth-1', role: ROLES.AUTHORIZER };
const patient = { id: 'P-1', role: ROLES.PATIENT };

function alias(ledger, code = 'P-9001') {
  return ledger.append(FACT_TYPES.PATIENT_ALIAS, { patient_code: code }, op);
}

test('事实只能追加：同一处方的撤销是新事实，旧事实保留', () => {
  const ledger = createLedger();
  alias(ledger);
  ledger.append(FACT_TYPES.PRESCRIPTION, {
    patient_code: 'P-9001', prescription_id: 'RX-1', site_code: 'S1',
    drug_code: 'D1', daily_dose: 2, unit: '片', quantity: 60, issued_on: '2026-09-01',
  }, clinician);
  ledger.append(FACT_TYPES.PRESCRIPTION_VOID, {
    patient_code: 'P-9001', prescription_id: 'RX-1', voided_on: '2026-09-02', reason: '重复开具',
  }, op);

  const facts = ledger.facts();
  assert.equal(facts.length, 3);
  assert.equal(facts[1].type, FACT_TYPES.PRESCRIPTION);
  assert.equal(facts[2].type, FACT_TYPES.PRESCRIPTION_VOID);
  // 追加返回的事实对象不可变更。
  assert.throws(() => { facts[1].payload.quantity = 1; }, TypeError);
});

test('角色授权：患者只能更正，监管只能追加复核裁定', () => {
  const ledger = createLedger();
  alias(ledger);
  assert.throws(
    () => ledger.append(FACT_TYPES.PRESCRIPTION, {
      patient_code: 'P-9001', prescription_id: 'X', site_code: 'S1',
      drug_code: 'D1', daily_dose: 2, unit: '片', quantity: 10, issued_on: '2026-09-01',
    }, patient),
    /无权追加/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.DISPENSE, {
      patient_code: 'P-9001', prescription_id: 'X', site_code: 'S1',
      drug_code: 'D1', quantity: 10, unit: '片', dispensed_on: '2026-09-01',
    }, regulator),
    /无权追加/,
  );
  ledger.append(FACT_TYPES.PATIENT_CORRECTION, {
    patient_code: 'P-9001', correction_id: 'C1', text: '当日确实取药', submitted_on: '2026-09-03',
  }, patient);
  assert.equal(ledger.size(), 2);
});

test('只有授权人员能解除临时限制，且必须指向已存在的限制', () => {
  const ledger = createLedger();
  alias(ledger);
  ledger.append(FACT_TYPES.TEMP_HOLD, {
    patient_code: 'P-9001', hold_id: 'H1', reason: '同日多院', held_on: '2026-09-10',
  }, op);

  assert.throws(
    () => ledger.append(FACT_TYPES.TEMP_HOLD_RELEASE, {
      patient_code: 'P-9001', hold_id: 'H1', released_on: '2026-09-11', release_reason: '误报',
    }, regulator),
    /无权追加/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.TEMP_HOLD_RELEASE, {
      patient_code: 'P-9001', hold_id: 'H404', released_on: '2026-09-11', release_reason: '误报',
    }, authorizer),
    /必须指向已存在的临时限制/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.TEMP_HOLD_RELEASE, {
      patient_code: 'P-9001', hold_id: 'H1', released_on: '2026-09-09', release_reason: '追溯',
    }, authorizer),
    /不得早于限制生效日期/,
  );
  ledger.append(FACT_TYPES.TEMP_HOLD_RELEASE, {
    patient_code: 'P-9001', hold_id: 'H1', released_on: '2026-09-11', release_reason: '材料齐备',
  }, authorizer);
  assert.equal(ledger.size(), 3);
});

test('撤销必须指向已存在处方，且日期不得早于开具日', () => {
  const ledger = createLedger();
  alias(ledger);
  assert.throws(
    () => ledger.append(FACT_TYPES.PRESCRIPTION_VOID, {
      patient_code: 'P-9001', prescription_id: 'GHOST', voided_on: '2026-09-02', reason: 'x',
    }, op),
    /必须指向已存在的处方/,
  );
});

test('遗传信息与完整病历以任何命名方式夹带都在入口拒收', () => {
  const ledger = createLedger();
  alias(ledger);
  assert.throws(
    () => ledger.append(FACT_TYPES.HOSPITAL_SUPPLEMENT, {
      patient_code: 'P-9001', supplement_id: 'S1', site_code: 'S1',
      text: '补传', submitted_on: '2026-09-03', genetic_info: 'XX',
    }, op),
    /遗传信息/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.CLINICIAN_NOTE, {
      patient_code: 'P-9001', note_id: 'N1', noted_on: '2026-09-03',
      text: '说明', attachment: { complete_chart: { secret: true } },
    }, clinician),
    /完整病历/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.PATIENT_CORRECTION, {
      patient_code: 'P-9001', correction_id: 'C1', submitted_on: '2026-09-03',
      text: '更正', id_card_no: '110101...',
    }, patient),
    /身份信息/,
  );
});

test('例外必须有期限；缺药例外必须人工确认；日剂量不得超方案上限', () => {
  const ledger = createLedger();
  alias(ledger);
  assert.throws(
    () => ledger.append(FACT_TYPES.EXCEPTION_GRANT, {
      patient_code: 'P-9001', grant_id: 'G1', reason: EXCEPTION_REASONS.TRANSFER,
      valid_from: '2026-09-10', valid_to: '2026-09-10',
    }, op),
    /正区间/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.EXCEPTION_GRANT, {
      patient_code: 'P-9001', grant_id: 'G2', reason: EXCEPTION_REASONS.SHORTAGE,
      valid_from: '2026-09-10', valid_to: '2026-09-20',
    }, op),
    /人工确认/,
  );
  assert.throws(
    () => ledger.append(FACT_TYPES.REGIMEN_VERSION, {
      patient_code: 'P-9001', version: 1, effective_from: '2026-01-01',
      items: [{ drug_code: 'D1', daily_dose: 9, daily_max: 6, unit: '片' }],
    }, clinician),
    /daily_max/,
  );
});

test('历史事实可冻结封存，冻结不影响继续追加新事实', () => {
  const ledger = createLedger();
  const f1 = alias(ledger);
  ledger.freezeUpTo(f1.seq);
  assert.equal(ledger.isFrozen(f1.seq), true);
  const f2 = ledger.append(FACT_TYPES.PATIENT_CORRECTION, {
    patient_code: 'P-9001', correction_id: 'C1', text: '更正', submitted_on: '2026-09-03',
  }, patient);
  assert.equal(ledger.isFrozen(f2.seq), false);
});

test('非法日期与缺失字段被拒绝', () => {
  const ledger = createLedger();
  alias(ledger);
  assert.throws(
    () => ledger.append(FACT_TYPES.DISPENSE, {
      patient_code: 'P-9001', prescription_id: 'RX-1', site_code: 'S1',
      drug_code: 'D1', quantity: 10, unit: '片', dispensed_on: '2026-02-30',
    }, op),
    /非法日历日期/,
  );
});
