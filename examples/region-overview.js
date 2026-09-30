// 读取虚构样例事实流，折叠时间线并打印区域复核概览。
// 运行：node examples/region-overview.mjs
import { readFile } from 'node:fs/promises';
import {
  createLedger, ingest, evaluateRegion,
} from '../src/index.js';

const raw = await readFile(new URL('../fixtures/timeline.json', import.meta.url), 'utf8');
const data = JSON.parse(raw);

const ledger = createLedger();
ingest(ledger, data.records);
const region = evaluateRegion(ledger, data.as_of);

const view = region.regulatorView();
console.log(`区域复核概览（截至 ${view.summary.as_of}）`);
console.log(`连续性证据充分 ${view.summary.buckets.continuity_supported} 人，`
  + `尚待说明 ${view.summary.buckets.needs_explanation} 人，`
  + `转入调查 ${view.summary.buckets.investigation} 人`);
for (const p of view.patients) {
  console.log(`- ${p.patient_code}：${p.bucket}`
    + `${p.under_active_hold ? '（临时限制生效中）' : ''}，冲突 ${p.conflicts.length} 条`);
}

// 医患视图示例：1001 患者能看到尚待处理冲突与处理结果。
const pv = region.patientView('P-CKD-1001');
console.log(`\n患者 ${pv.patient_code} 视图：当前透析机构 ${pv.dialysis.site_code}，`
  + `冲突 ${pv.conflicts.length} 条（状态：${pv.conflicts.map(c => c.status).join('、')}）`);
