// 只追加事实日志的解析、结构校验与追加。
// 任何更正、补传、撤销、复核都通过 appendFact 追加新事实完成，
// 既有事实不可修改、不可删除。

export const DOMAIN = 'renal-care-continuity';

const FACT_TYPES = new Set([
  'drug_catalog',
  'drug_class_catalog',
  'dialysis_schedule',
  'site_enrollment',
  'regimen_version',
  'prescription',
  'dispense',
  'clinician_note',
  'exception_grant',
  'correction',
  'supplement',
  'void',
  'review',
  'temporary_restriction',
  'restriction_lift',
  'genetic_result',
  'full_record_import',
]);

const ROLES = new Set([
  'patient',
  'clinician',
  'hospital_pharmacy',
  'regulator',
  'authorized_officer',
  'system',
]);

const RESTRICTED_TYPES = new Set(['genetic_result', 'full_record_import']);
const TARGET_REF_TYPES = new Set(['correction', 'supplement', 'void']);

function fail(message) {
  throw new Error(message);
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isValidTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateActor(actor, path) {
  if (!actor || typeof actor !== 'object') fail(`${path} 缺少记录人`);
  if (!actor.actor_code) fail(`${path} 缺少 actor_code`);
  if (!ROLES.has(actor.role)) fail(`${path} 角色非法: ${actor.role}`);
}

function validateException(data, path) {
  if (!data.exception_id) fail(`${path} 例外缺少 exception_id`);
  if (!['transfer', 'emergency', 'shortage_substitution'].includes(data.kind)) {
    fail(`${path} 例外类型非法: ${data.kind}`);
  }
  if (!isValidDate(data.valid_from) || !isValidDate(data.valid_to)) {
    fail(`${path} 例外有效期不是合法日期`);
  }
  if (data.valid_to < data.valid_from) {
    fail(`${path} 例外 valid_to 早于 valid_from`);
  }
  if (!Array.isArray(data.evidence) || data.evidence.length === 0) {
    fail(`${path} 例外必须附带至少一项证据`);
  }
  validateActor(data.granted_by, `${path}.granted_by`);
  if (data.kind === 'shortage_substitution' && data.manually_confirmed !== true) {
    fail(`${path} 缺药替代必须经人工确认（manually_confirmed=true）`);
  }
  if (data.kind === 'shortage_substitution' && !data.confirmed_by) {
    fail(`${path} 缺药替代必须记录确认人 confirmed_by`);
  }
  if (data.linked_orgs !== undefined && !Array.isArray(data.linked_orgs)) {
    fail(`${path} linked_orgs 必须是机构标识数组`);
  }
}

function validateReview(data, path) {
  for (const key of ['review_id', 'reviewer_code', 'rationale']) {
    if (!data[key]) fail(`${path} 复核缺少 ${key}`);
  }
  if (!Array.isArray(data.conflict_refs) || data.conflict_refs.length === 0) {
    fail(`${path} 复核必须引用至少一个冲突`);
  }
  if (!['evidence_sufficient', 'refer_investigation'].includes(data.decision)) {
    fail(`${path} 复核结论非法: ${data.decision}`);
  }
}

function validateFactShape(fact, index) {
  const path = `facts[${index}]`;
  if (!fact || typeof fact !== 'object') fail(`${path} 不是对象`);
  if (!fact.fact_id) fail(`${path} 缺少 fact_id`);
  if (!Number.isInteger(fact.seq) || fact.seq < 1) fail(`${path} seq 必须是正整数`);
  if (!FACT_TYPES.has(fact.type)) fail(`${path} 事实类型非法: ${fact.type}`);
  if (!isValidTimestamp(fact.at)) fail(`${path} 时间戳非法: ${fact.at}`);
  validateActor(fact.recorded_by, `${path}.recorded_by`);
  if (!['ordinary', 'restricted'].includes(fact.sensitivity)) {
    fail(`${path} 敏感级别非法: ${fact.sensitivity}`);
  }
  if (RESTRICTED_TYPES.has(fact.type) && fact.sensitivity !== 'restricted') {
    fail(`${path} ${fact.type} 必须标记为 restricted`);
  }
  if (!RESTRICTED_TYPES.has(fact.type) && fact.sensitivity === 'restricted') {
    fail(`${path} 仅遗传信息与完整病历可标记为 restricted`);
  }
  if (!fact.data || typeof fact.data !== 'object') fail(`${path} 缺少 data`);

  if (fact.type === 'exception_grant') validateException(fact.data, path);
  if (fact.type === 'review') validateReview(fact.data, path);
  if (fact.type === 'restriction_lift' && !fact.data.hold_id) {
    fail(`${path} 解除限制必须引用 hold_id`);
  }
  if (fact.type === 'temporary_restriction' && !fact.data.hold_id) {
    fail(`${path} 临时限制必须包含 hold_id`);
  }
  if (TARGET_REF_TYPES.has(fact.type) && !fact.data.target_fact_id) {
    fail(`${path} ${fact.type} 必须引用 target_fact_id`);
  }
}

// 解析并整体校验一份日志（结构不变量 + 交叉引用）。
export function parseJournal(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
  if (value.domain !== DOMAIN) fail(`领域标识必须为 ${DOMAIN}`);
  if (!Number.isInteger(value.version) || value.version < 1) fail('version 必须是正整数');
  if (!value.journal_id) fail('缺少 journal_id');
  if (!value.patient_code) fail('缺少 patient_code');
  if (!Array.isArray(value.facts)) fail('facts 必须是数组');

  const seenIds = new Set();
  const seenSeq = new Set();
  value.facts.forEach((fact, i) => {
    validateFactShape(fact, i);
    if (seenIds.has(fact.fact_id)) fail(`fact_id 重复: ${fact.fact_id}`);
    seenIds.add(fact.fact_id);
    if (seenSeq.has(fact.seq)) fail(`seq 重复: ${fact.seq}`);
    seenSeq.add(fact.seq);
  });

  // seq 必须从 1 开始严格递增（允许事实按登记顺序而非事件时间排列）。
  value.facts.forEach((fact, i) => {
    if (fact.seq !== i + 1) fail(`seq 必须从 1 连续递增，facts[${i}] 的 seq 为 ${fact.seq}`);
  });

  // 交叉引用：撤销/更正/补传/解除限制所指对象必须存在。
  for (const fact of value.facts) {
    if (TARGET_REF_TYPES.has(fact.type) && !seenIds.has(fact.data.target_fact_id)) {
      fail(`${fact.fact_id} 引用了不存在的事实: ${fact.data.target_fact_id}`);
    }
    if (fact.type === 'restriction_lift') {
      const hold = value.facts.find(
        (f) => f.type === 'temporary_restriction' && f.data.hold_id === fact.data.hold_id,
      );
      if (!hold) fail(`${fact.fact_id} 解除了不存在的临时限制: ${fact.data.hold_id}`);
    }
  }

  return value;
}

// 以只追加方式登记新事实：自动分配下一个 seq，返回新日志（不修改入参）。
export function appendFact(journal, input) {
  const next = parseJournal(journal);
  const fact = structuredClone(input);
  if (!fact.fact_id) fail('新事实必须提供 fact_id');
  if (next.facts.some((f) => f.fact_id === fact.fact_id)) {
    fail(`fact_id 重复: ${fact.fact_id}`);
  }
  fact.seq = next.facts.length + 1;
  validateFactShape(fact, next.facts.length);

  if (TARGET_REF_TYPES.has(fact.type) && !next.facts.some((f) => f.fact_id === fact.data.target_fact_id)) {
    fail(`${fact.fact_id} 引用了不存在的事实: ${fact.data.target_fact_id}`);
  }
  if (fact.type === 'restriction_lift') {
    const hold = next.facts.find(
      (f) => f.type === 'temporary_restriction' && f.data.hold_id === fact.data.hold_id,
    );
    if (!hold) fail(`${fact.fact_id} 解除了不存在的临时限制: ${fact.data.hold_id}`);
  }

  next.facts.push(fact);
  return next;
}
