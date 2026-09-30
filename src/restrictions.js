// 临时限制的授权管理：只有授权人员（authorized_officer）能解除。
// 解除动作同样以追加 restriction_lift 事实的方式留痕，不删除原限制。

import { appendFact } from './journal.js';

export function canLiftHold(actor) {
  return actor?.role === 'authorized_officer';
}

export function activeHolds(journal) {
  const lifted = new Set(
    journal.facts.filter((f) => f.type === 'restriction_lift').map((f) => f.data.hold_id),
  );
  return journal.facts
    .filter((f) => f.type === 'temporary_restriction' && !lifted.has(f.data.hold_id))
    .map((f) => ({ hold_id: f.data.hold_id, scope_prescription_id: f.data.scope_prescription_id, reason: f.data.reason, at: f.at }));
}

// 追加一条解除事实。非授权角色、重复解除、引用不存在的限制都会抛错。
export function liftHold(journal, holdId, actor, reason, params = {}) {
  if (!canLiftHold(actor)) {
    throw new Error(`角色 ${actor?.role ?? '未知'} 无权解除临时限制，仅授权人员可操作`);
  }
  const hold = journal.facts.find((f) => f.type === 'temporary_restriction' && f.data.hold_id === holdId);
  if (!hold) throw new Error(`临时限制不存在: ${holdId}`);
  const already = journal.facts.some((f) => f.type === 'restriction_lift' && f.data.hold_id === holdId);
  if (already) throw new Error(`临时限制 ${holdId} 已解除，不能重复解除`);
  if (!reason) throw new Error('解除限制必须填写理由');

  const fact = {
    fact_id: params.fact_id ?? `lift-${holdId}`,
    type: 'restriction_lift',
    at: params.at ?? new Date().toISOString(),
    recorded_by: { actor_code: actor.actor_code, role: actor.role, ...(actor.org_id ? { org_id: actor.org_id } : {}) },
    sensitivity: 'ordinary',
    data: { hold_id: holdId, reason },
  };
  return appendFact(journal, fact);
}
