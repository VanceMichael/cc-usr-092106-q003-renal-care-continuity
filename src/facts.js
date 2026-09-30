// 只追加事实层。
//
// 一切变化（患者更正、医院补传、处方撤销、人工复核、临时限制/解除）
// 都以“事实”形式追加；事实一旦接收即不可修改、不可删除。
// 撤销、更正、复核裁定是*新的事实*，在视图折叠时覆盖旧事实的效力。

import { toIsoDate } from './dates.js';

export const FACT_TYPES = Object.freeze({
  PATIENT_ALIAS: 'patient_alias',           // 患者代号入册（仅代号，无身份信息）
  DIALYSIS_SCHEDULE: 'dialysis_schedule',   // 透析安排版本
  CARE_EPISODE: 'care_episode',             // 在某机构的诊疗区间（转院即新区间）
  REGIMEN_VERSION: 'regimen_version',       // 治疗方案版本（药品/日剂量/上限）
  PRESCRIPTION: 'prescription',             // 处方（可被后续撤销事实撤销）
  DISPENSE: 'dispense',                     // 已领取数量
  PRESCRIPTION_VOID: 'prescription_void',   // 处方撤销
  CLINICIAN_NOTE: 'clinician_note',         // 医生说明（可后补）
  PATIENT_CORRECTION: 'patient_correction', // 患者更正（追加陈述，不改旧事实）
  HOSPITAL_SUPPLEMENT: 'hospital_supplement', // 医院补传
  SHORTAGE_SUBSTITUTION: 'shortage_substitution', // 经人工确认的缺药替代（例外）
  EXCEPTION_GRANT: 'exception_grant',       // 有期限例外（转院/急诊/缺药）
  TEMP_HOLD: 'temp_hold',                   // 临时限制
  TEMP_HOLD_RELEASE: 'temp_hold_release',   // 解除临时限制（仅授权人员）
  REVIEW_DECISION: 'review_decision',       // 监管复核裁定（追加）
});

// 例外类别。三类均必须有期限；缺药替代还要求人工确认来源。
export const EXCEPTION_REASONS = Object.freeze({
  TRANSFER: 'transfer', // 转院连续性
  EMERGENCY: 'emergency', // 急诊
  SHORTAGE: 'shortage', // 原院/原渠道缺药替代
});

export const ROLES = Object.freeze({
  PATIENT: 'patient',
  CLINICIAN: 'clinician',
  HOSPITAL_OPERATOR: 'hospital_operator',
  REGULATOR: 'regulator',
  AUTHORIZER: 'authorizer', // 唯一可解除临时限制的角色
});

// 各角色可追加的事实类型。监管复核只能追加裁定，不能改写诊疗事实。
const ROLE_CAN_EMIT = Object.freeze({
  [ROLES.PATIENT]: new Set([FACT_TYPES.PATIENT_CORRECTION]),
  [ROLES.CLINICIAN]: new Set([
    FACT_TYPES.DIALYSIS_SCHEDULE,
    FACT_TYPES.CARE_EPISODE,
    FACT_TYPES.REGIMEN_VERSION,
    FACT_TYPES.PRESCRIPTION,
    FACT_TYPES.CLINICIAN_NOTE,
    FACT_TYPES.SHORTAGE_SUBSTITUTION,
  ]),
  [ROLES.HOSPITAL_OPERATOR]: new Set([
    FACT_TYPES.PATIENT_ALIAS,
    FACT_TYPES.DIALYSIS_SCHEDULE,
    FACT_TYPES.CARE_EPISODE,
    FACT_TYPES.REGIMEN_VERSION,
    FACT_TYPES.PRESCRIPTION,
    FACT_TYPES.DISPENSE,
    FACT_TYPES.PRESCRIPTION_VOID,
    FACT_TYPES.HOSPITAL_SUPPLEMENT,
    FACT_TYPES.SHORTAGE_SUBSTITUTION,
    FACT_TYPES.EXCEPTION_GRANT,
    FACT_TYPES.TEMP_HOLD,
  ]),
  [ROLES.REGULATOR]: new Set([FACT_TYPES.REVIEW_DECISION]),
  [ROLES.AUTHORIZER]: new Set([
    FACT_TYPES.REVIEW_DECISION,
    FACT_TYPES.TEMP_HOLD_RELEASE,
  ]),
});

// 普通监管视图永不接收的字段。遗传信息与完整病历不进入普通监管视图，
// 在事实入口即拒收，而不是靠展示层“遮掉”。
const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'genetic_info', 'genetic_data', 'genome', 'dna',
  'full_record', 'complete_chart', 'entire_chart', 'medical_record_full',
  'identity_name', 'id_card_no',
]);

const FORBIDDEN_KEY_PATTERN = /genetic|genome|dna|full_record|complete_chart|entire_chart|id_card/;

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function requireFields(payload, fields) {
  for (const f of fields) {
    if (payload[f] === undefined || payload[f] === null || payload[f] === '') {
      throw new Error(`事实缺少必要字段：${f}`);
    }
  }
}

function rejectSensitive(payload, path = '') {
  if (payload == null || typeof payload !== 'object') return;
  // 只拦截结构化字段：遗传信息/完整病历不得以命名字段进入台账。
  // 说明性文本（医生说明/患者更正/医院补传）本就是自由文本通道，不做关键词审查。
  for (const key of Object.keys(payload)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key) || FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new Error(`字段 ${here} 属于遗传信息/完整病历/身份信息，禁止进入用药连续性台账`);
    }
    const v = payload[key];
    if (v && typeof v === 'object') rejectSensitive(v, here);
  }
}

function validatePayload(type, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new Error('事实内容必须是对象');
  }
  rejectSensitive(p);
  switch (type) {
    case FACT_TYPES.PATIENT_ALIAS:
      requireFields(p, ['patient_code']);
      nonEmptyString(p.patient_code, 'patient_code');
      break;
    case FACT_TYPES.DIALYSIS_SCHEDULE:
      requireFields(p, ['patient_code', 'site_code', 'schedule', 'effective_from']);
      toIsoDate(p.effective_from);
      if (p.effective_to) toIsoDate(p.effective_to);
      break;
    case FACT_TYPES.CARE_EPISODE:
      requireFields(p, ['patient_code', 'site_code', 'episode_id', 'admitted_on']);
      toIsoDate(p.admitted_on);
      if (p.transferred_out_on) toIsoDate(p.transferred_out_on);
      break;
    case FACT_TYPES.REGIMEN_VERSION:
      requireFields(p, ['patient_code', 'version', 'items', 'effective_from']);
      toIsoDate(p.effective_from);
      if (!Array.isArray(p.items) || p.items.length === 0) {
        throw new Error('治疗方案至少包含一个药品条目');
      }
      for (const item of p.items) {
        requireFields(item, ['drug_code', 'daily_dose', 'unit']);
        if (item.daily_dose <= 0) throw new Error('日剂量必须为正');
        if (item.daily_max != null && item.daily_max < item.daily_dose) {
          throw new Error('日剂量不得高于说明书/方案上限 daily_max');
        }
      }
      break;
    case FACT_TYPES.PRESCRIPTION:
      requireFields(p, ['patient_code', 'prescription_id', 'site_code', 'drug_code',
        'daily_dose', 'unit', 'quantity', 'issued_on']);
      toIsoDate(p.issued_on);
      if (p.daily_dose <= 0 || p.quantity <= 0) throw new Error('剂量与数量必须为正');
      break;
    case FACT_TYPES.DISPENSE:
      requireFields(p, ['patient_code', 'prescription_id', 'site_code', 'drug_code',
        'quantity', 'unit', 'dispensed_on']);
      toIsoDate(p.dispensed_on);
      if (p.quantity <= 0) throw new Error('领取数量必须为正');
      break;
    case FACT_TYPES.PRESCRIPTION_VOID:
      requireFields(p, ['patient_code', 'prescription_id', 'voided_on', 'reason']);
      toIsoDate(p.voided_on);
      break;
    case FACT_TYPES.CLINICIAN_NOTE:
      requireFields(p, ['patient_code', 'note_id', 'text', 'noted_on']);
      toIsoDate(p.noted_on);
      nonEmptyString(p.text, 'text');
      break;
    case FACT_TYPES.PATIENT_CORRECTION:
      requireFields(p, ['patient_code', 'correction_id', 'text', 'submitted_on']);
      toIsoDate(p.submitted_on);
      break;
    case FACT_TYPES.HOSPITAL_SUPPLEMENT:
      requireFields(p, ['patient_code', 'supplement_id', 'site_code', 'text', 'submitted_on']);
      toIsoDate(p.submitted_on);
      break;
    case FACT_TYPES.SHORTAGE_SUBSTITUTION:
      requireFields(p, ['patient_code', 'substitution_id', 'site_code', 'drug_code',
        'confirmed_by', 'confirmed_on', 'valid_from', 'valid_to']);
      toIsoDate(p.confirmed_on);
      toIsoDate(p.valid_from);
      toIsoDate(p.valid_to);
      if (p.valid_to <= p.valid_from) throw new Error('例外有效期必须为正区间');
      nonEmptyString(p.confirmed_by, 'confirmed_by（人工确认人）');
      break;
    case FACT_TYPES.EXCEPTION_GRANT:
      requireFields(p, ['patient_code', 'grant_id', 'reason', 'valid_from', 'valid_to']);
      toIsoDate(p.valid_from);
      toIsoDate(p.valid_to);
      if (p.valid_to <= p.valid_from) throw new Error('例外有效期必须为正区间');
      if (!Object.values(EXCEPTION_REASONS).includes(p.reason)) {
        throw new Error(`例外原因必须是 ${Object.values(EXCEPTION_REASONS).join('/')}`);
      }
      if (p.reason === EXCEPTION_REASONS.SHORTAGE && !p.confirmed_by) {
        throw new Error('缺药例外必须提供人工确认人 confirmed_by');
      }
      if (Array.isArray(p.drug_codes) && p.drug_codes.length === 0) {
        throw new Error('drug_codes 为空时应省略，表示适用于全部药种');
      }
      break;
    case FACT_TYPES.TEMP_HOLD:
      requireFields(p, ['patient_code', 'hold_id', 'reason', 'held_on']);
      toIsoDate(p.held_on);
      break;
    case FACT_TYPES.TEMP_HOLD_RELEASE:
      requireFields(p, ['patient_code', 'hold_id', 'released_on', 'release_reason']);
      toIsoDate(p.released_on);
      break;
    case FACT_TYPES.REVIEW_DECISION:
      requireFields(p, ['patient_code', 'review_id', 'conflict_id', 'decision', 'decided_on']);
      toIsoDate(p.decided_on);
      if (!['upheld', 'resolved', 'escalate_investigation'].includes(p.decision)) {
        throw new Error('裁定必须是 upheld / resolved / escalate_investigation');
      }
      break;
    default:
      throw new Error(`未知事实类型：${type}`);
  }
}

// 创建一个患者台账（或区域多患者共用台账）。
export function createLedger() {
  const facts = [];
  const frozenSeq = new Set();
  let sequence = 0;

  return {
    // 追加一条事实。actor = { id, role }；角色无权追加或内容违规时抛错，不留半成品。
    append(type, payload, actor, { occurredAt = null } = {}) {
      nonEmptyString(type, 'fact type');
      if (!actor || !ROLE_CAN_EMIT[actor.role]) {
        throw new Error('追加人角色未知或无权追加事实');
      }
      if (!ROLE_CAN_EMIT[actor.role].has(type)) {
        throw new Error(`角色 ${actor.role} 无权追加 ${type}`);
      }
      validatePayload(type, payload);
      if (occurredAt) toIsoDate(occurredAt);

      // 引用完整性：解除/撤销必须指向已存在的事实，且不可在被引用事实之前发生。
      if (type === FACT_TYPES.TEMP_HOLD_RELEASE) {
        const hold = facts.find(f =>
          f.type === FACT_TYPES.TEMP_HOLD && f.payload.hold_id === payload.hold_id
          && f.payload.patient_code === payload.patient_code);
        if (!hold) throw new Error('解除事实必须指向已存在的临时限制');
        if (payload.released_on < hold.payload.held_on) {
          throw new Error('解除日期不得早于限制生效日期');
        }
      }
      if (type === FACT_TYPES.PRESCRIPTION_VOID) {
        const rx = facts.find(f =>
          f.type === FACT_TYPES.PRESCRIPTION && f.payload.prescription_id === payload.prescription_id
          && f.payload.patient_code === payload.patient_code);
        if (!rx) throw new Error('撤销事实必须指向已存在的处方');
        if (payload.voided_on < rx.payload.issued_on) {
          throw new Error('撤销日期不得早于处方开具日期');
        }
      }

      const fact = Object.freeze({
        seq: ++sequence,
        ledger_seq: facts.length + 1,
        type,
        payload: Object.freeze(payload),
        actor: Object.freeze({ id: nonEmptyString(actor.id, 'actor.id'), role: actor.role }),
        occurred_at: occurredAt,
        recorded_at: '2026-09-30T00:00:00Z',
      });
      facts.push(fact);
      return fact;
    },

    // 冻结历史：seq 之前（含）的事实被封存，任何代码路径都无法再改动其引用。
    freezeUpTo(seq) {
      let count = 0;
      for (const f of facts) if (f.seq <= seq) { frozenSeq.add(f.seq); count++; }
      return count;
    },

    facts() {
      return facts.slice();
    },

    isFrozen(seq) {
      return frozenSeq.has(seq);
    },

    size() {
      return facts.length;
    },
  };
}

// 从序列化记录流重放构建台账（顺序即追加顺序，会重新执行全部校验与授权检查）。
export function ingest(ledger, records) {
  const emitted = [];
  for (const rec of records) {
    if (!rec || !rec.type || !rec.payload || !rec.actor) {
      throw new Error('记录必须包含 type / payload / actor');
    }
    emitted.push(ledger.append(rec.type, rec.payload, rec.actor,
      rec.occurred_at ? { occurredAt: rec.occurred_at } : {}));
  }
  return emitted;
}
