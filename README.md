# 慢性肾病跨院用药连续性

区域医联体用药连续性后台的领域资料与规则原型：把患者代号、透析安排、诊疗机构、
治疗方案版本、已领取数量、预计可用天数和医生说明串成时间线；提示同日重复、
间隔异常与剂量重叠，同时把转院、急诊与经人工确认的缺药替代作为**有期限例外**保留，
支持监管区分"治疗连续性证据充分"与"需要转入调查"。

所有数据均为虚构，不含真实个人信息；代码为零依赖的 ESM 模块，可被业务服务直接复用。

## 设计要点

- **只追加事实日志**：患者更正、医院补传、处方撤销、监管复核全部是新事实
  （`correction` / `supplement` / `void` / `review`），`seq` 连续递增，既有事实不可改删。
- **有期限例外**：`exception_grant` 含 `valid_from`/`valid_to`、证据清单与机构范围；
  缺药替代必须 `manually_confirmed` 并记录确认人。例外只在窗口内解释冲突，过期不再覆盖新事件。
- **冲突检测**（`src/conflicts.js`）：
  - `same_day_duplicate` 同日多院同类药领取；
  - `interval_anomaly` 上一份覆盖期未结束即跨院再次取药；
  - `dose_overlap` 多机构同类处方日剂量合计超过说明书类别上限；
  - `near_label_max` 单药日剂量接近上限（建议级，不单独触发调查）。
- **临时限制**：风险模型可挂起处方，**只有授权人员**（`authorized_officer`）
  能以追加 `restriction_lift` 的方式解除并留痕。
- **数据最小化**：遗传信息与完整病历只能以 `restricted` 密封引用登记，
  不进入时间线投影与普通监管视图；普通监管视图也不含医生说明原文。
- **分流结论**：`evidence_sufficient`（冲突均被有效例外或复核闭环）、
  `pending_explanation`（仍有未解除限制）、`refer_investigation`（存在未解释的硬冲突或复核转调查）。

## 目录

| 路径 | 说明 |
| --- | --- |
| `contracts/context.schema.json` | 基础领域资料格式 |
| `contracts/journal.schema.json` | 只追加事实日志契约（事实类型、角色、敏感级别、例外、复核） |
| `fixtures/context.json` | 基础领域事实样例 |
| `fixtures/journal.patient-0427.json` | 证据充分病例：转院+急诊+缺药替代+补传+撤销+复核闭环 |
| `fixtures/journal.patient-0913.json` | 需调查病例：例外过期后同日三院重复取药 |
| `src/journal.js` | 日志解析、结构/交叉引用校验、`appendFact` 追加 |
| `src/timeline.js` | 时间线投影：透析、机构、方案版本、领取量、按类别合并的覆盖天数 |
| `src/conflicts.js` | 冲突检测、例外窗口匹配、监管分流 |
| `src/restrictions.js` | 临时限制与授权解除 |
| `src/views.js` | 患者 / 医生 / 普通监管三种角色视图 |
| `src/analyze.js` | 编排：日志 → 时间线 → 冲突 → 分流 |

## 使用示例

```js
import { readFile } from 'node:fs/promises';
import { parseJournal } from './src/journal.js';
import { analyzeJournal } from './src/analyze.js';
import { buildRegulatorView } from './src/views.js';
import { liftHold } from './src/restrictions.js';

const journal = parseJournal(await readFile('fixtures/journal.patient-0427.json', 'utf8'));
const analysis = analyzeJournal(journal);
analysis.disposition;            // 'evidence_sufficient'
analysis.conflicts;              // 每条冲突带 status 与 matched_exceptions
const regulatorView = buildRegulatorView(analysis);

// 仅授权人员可解除临时限制（返回追加后的新日志，原对象不变）
const next = liftHold(journal, 'HOLD-0913-01',
  { actor_code: 'AUTH-09', role: 'authorized_officer' }, '补充材料核验通过');
```

## 本地校验

```bash
npm test
```

测试覆盖：日志不变量（连续 seq、唯一 fact_id、交叉引用、restricted 标记约束、
缺药人工确认）、追加不可变、时间线投影与住院给药排除、三类冲突检测、
例外窗口与机构范围、授权解除、角色视图脱敏，以及两份样例的最终分流。
