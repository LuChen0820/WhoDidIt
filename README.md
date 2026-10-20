# 谁在干活 WhoDidIt

![check](https://github.com/LuChen0820/WhoDidIt/actions/workflows/ci.yml/badge.svg)

小组作业贡献结算台。**不互评、只认真实协作痕迹**，把「谁在干活」从吵架题变成算术题。

## 问题

小组作业的激励结构是坏的：收益共享，成本私有。期末互评时组长只能凭印象填平均分配；
更糟的是活是某人干的、但最后合并 PR 的是另一个人，于是唯一的记录挂在了别人名下，
做的人连自证的手段都没有。

现有协作工具都不缺 —— Trello、飞书、GitHub 都更完善。它们共同缺的是一层：
**把已经发生的协作痕迹，换算成一个可以被第三方采信的结论。**

## 三条机制

1. **不设自评、不设互评。** 熟人小组里任何互评都会退化成人情分。
2. **每个百分比都能下钻到原始时间线。** 可信度不来自算法先进，来自可复核。
3. **结算必须能翻案。** 仲裁用追加事件，原始痕迹一行不改 —— 不能申诉的度量系统没有合法性。

## 技术主张

> **AI 负责解释，规则负责裁决。**

贡献值计算刻意不用模型：度量必须可解释、可复算。AI 只做痕迹归因、证据比对与文书生成。

数据脊梁是**只追加的事件流 → 派生账本**：`events` 表不可改不可删不可清空，
`ledger` 任何时刻可以删掉从事件流重放出逐字节一致的结果。
占比不是被写出来的，是被算出来的。

## 仓库结构

| 路径 | 是什么 |
|---|---|
| [`server/`](server/README.md) | 真实可用的系统：Node + Postgres 事件流账本 + 零构建前端 |
| [`index.html`](index.html) | 课程交付的可点击原型（模拟数据，但结算计算逻辑真实） |
| [`proposal.md`](proposal.md) | 立项书与需求说明书 |
| [`tech-design.md`](tech-design.md) | 产品级技术方案 |
| [`demo-script.md`](demo-script.md) ｜ [`cue-card.md`](cue-card.md) ｜ [`script-plain.md`](script-plain.md) | 课堂演示材料 |

## 快速开始

```bash
cd server && npm install
PORT=8790 node src/server.ts     # 打开 http://127.0.0.1:8790
```

四层检查：

```bash
npm test          # 39 条不变量测试
npm run probe     # 攻击面 + 视觉可达性自检
bash scripts/smoke.sh   # 41 项真 HTTP 端到端冒烟
npm run e2e       # 10 项 Playwright 浏览器测试
```
