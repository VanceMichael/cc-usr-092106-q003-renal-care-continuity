# 慢性肾病跨院用药连续性

慢性肾病透析患者因透析地点调整、临时住院或原医院缺药而跨院取药时，风险模型容易把频繁就医与接近说明书上限的剂量误判为倒药。本仓库实现一套**用药连续性后台**：把患者代号、透析安排、诊疗机构、治疗方案版本、已领取数量、预计可用天数与医生说明串成只追加事实时间线，自动提示同日重复、间隔异常与剂量重叠，同时把转院、急诊和经人工确认的缺药替代作为**有期限例外**保留，让真实治疗不被简单停付中断。

所有代码为零依赖 ESM，运行 `node --test` 即可验证；数据均为虚构。

## 模型要点

### 只追加事实（`src/facts.js`）

- 患者更正、医院补传、处方撤销、监管复核、临时限制与解除**都只追加事实**；撤销/裁定是新事实，旧事实保留可审计，返回的事实对象冻结。
- 角色授权：患者只能追加更正；医生追加方案/处方/说明；医院运营岗可登记透析安排、发药、授予例外、设置临时限制；监管只能追加复核裁定；**只有 `authorizer` 能解除临时限制**。
- **遗传信息与完整病历在事实入口拒收**（按结构化字段名拦截），不是靠展示层遮盖；普通监管视图再走字段白名单兜底。
- 校验内置在追加动作中：日期合法性、引用完整性（解除须指向已有限制、撤销须指向已存处方且日期不倒置）、例外必须为正区间、缺药例外必须有人工确认人、处方日剂量不得高于方案/说明书上限。

### 时间线折叠（`src/timeline.js`）

- 按患者把事实流折叠为：透析安排版本、诊疗区间（转院即新区间）、当前方案版本、处方（含撤销状态）、逐次领取记录。
- **预计可用天数**：同一药品跨院领取计入同一条库存线，按 `覆盖天数 = floor(领取数量 / 日剂量)` 模拟逐日消耗，输出每次领取时的旧库存重叠天数与预计耗尽日。

### 冲突检测与有期限例外（`src/conflicts.js`）

- 三类机器提示：`same_day_duplicate`（同日多院领取同一药品）、`early_refill`（仍有 ≥3 天库存即再次领取，间隔异常）、`dose_overlap`（不同机构同药处方覆盖区间相交，撤销日截断区间）。
- 检测器**只提示、不停付**。冲突状态：`open`（尚待说明）→ `explained`（已有医生/患者/医院说明关联，待复核）→ `excepted`（事件日命中有效例外窗口）/ `resolved` / `upheld` / `investigation`。
- 例外按**事件发生日**命中：转院例外需与 ±7 天内透析/诊疗机构变动相互印证；急诊例外覆盖住院区间；缺药替代须经药师人工确认且限定药种、机构与期限。窗口到期只停止覆盖新事件，**不翻案历史结论**。

### 角色视图（`src/views.js`）

- **医患视图**：完整连续性材料、说明全文、冲突处理结果（含尚待本人说明的冲突）。
- **普通监管视图**：只见患者代号与白名单字段（药种、日期、机构、指标、例外与印证摘要、裁定），不含自由文本说明全文、治疗方案明细与身份字段；患者被分为
  `continuity_supported`（治疗连续性证据充分）/ `needs_explanation`（尚待说明）/ `investigation`（转入调查）。
- 监管只能追加 `review_decision`（`resolved` / `upheld` / `escalate_investigation`），不能改写任何诊疗事实。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/facts.js` | 事实类型、角色授权、入口校验、只追加台账与重放 |
| `src/dates.js` | 纯日期（YYYY-MM-DD）与区间工具 |
| `src/timeline.js` | 患者时间线折叠、库存与预计可用天数模拟 |
| `src/conflicts.js` | 三类冲突检测、例外命中与状态裁定 |
| `src/views.js` | 医患视图、监管脱敏视图、证据充分性分类、限制解除审计 |
| `src/index.js` | 汇总入口：`evaluateRegion(ledger, asOf)` |
| `contracts/context.schema.json` | 基础领域资料格式 |
| `contracts/facts.schema.json` | 事实流记录格式契约 |
| `fixtures/context.json` | 领域基础事实 |
| `fixtures/timeline.json` | 三位虚构患者的完整事实流（见下） |
| `examples/region-overview.js` | 读取样例并打印区域复核概览 |

## 虚构样例中的三位患者

- `P-CKD-1001`：透析地点由 SITE-A 调整至 SITE-B，转院窗口内提前续药并跨院领取；冲突被提示，但转院例外与机构变动、医生说明相互印证 → **连续性证据充分**。
- `P-CKD-1002`：急诊入住 SITE-D 同日多院领取，经医院补传与监管复核确认连续性，临时限制由授权人员解除；其后 SITE-C 缺药、经药师人工确认在 SITE-E 有期限调剂，重复处方作废（撤销事实保留）。
- `P-CKD-1003`：14 天内跨 4 家机构高频领取、剂量贴说明书上限、无任何转院/急诊/缺药事实，仅有患者口头更正；同日重复被监管裁定 `escalate_investigation`，**转入调查且临时限制保持生效**。

## 使用方式

```bash
npm test                       # 运行全部校验（19 个用例）
node examples/region-overview.js   # 打印样例区域复核概览
```

```js
import { readFile } from 'node:fs/promises';
import { createLedger, ingest, evaluateRegion } from './src/index.js';

const data = JSON.parse(await readFile('./fixtures/timeline.json', 'utf8'));
const ledger = createLedger();
ingest(ledger, data.records);                 // 顺序重放，逐事实校验授权与内容

const region = evaluateRegion(ledger, '2026-09-30');
region.regulatorView();                       // 监管脱敏汇总与三分类
region.patientView('P-CKD-1001');             // 医患：完整时间线、说明全文、处理结果
```

所有示例均为虚构数据，不含真实个人信息、遗传信息、完整病历或访问凭据。
