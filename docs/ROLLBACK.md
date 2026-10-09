# 回滚预案 — documents-activity-tracker 工程化重构

> 本文件记录重构前的基线副本与回滚步骤。`backups/` 目录已被 `.gitignore` 忽略，
> 因此**副本的 md5 与来源记录在此文件中**，以便校验本地副本是否被改动。

## 一、Phase 0 冻结基线（2026-09-15，时间戳 1789465241 / 1789465234）

| 内容 | 副本路径（`backups/`，未入库） | md5 | 大小 |
|---|---|---|---|
| **A 版源码**（工程目录旧版，单体 `ReadTimeEngine`） | `main.js.a-version-1789465234` | `6e9a6312a747eadd85a3fea873a6298c` | 298,191 B |
| **B 版源码**（vault 已安装版，Redux 架构，重构起点） | `vault-main.js.b-version-1789465241` | `f20373605744066915f41fa01745ca04` | 233,602 B |
| **真实数据文件**（活跃使用，`version: 2`，138 事件） | `readTimeHistory.json.pre-ts-1789465241` | `88b76e629ed91030040c8f52db755a58` | 26,980 B |
| 插件目录 `data.json`（过期副本） | `vault-data.json.pre-ts-1789465241` | `09f33a711e5a7f9d42eea490b43e019b` | 32,164 B |
| `styles.css`（两版一致，拆分前的唯一权威版本） | 见 vault 插件目录 / 工程目录 | `d15dfb090e8fb907527dba913edf353c` | 35,720 B |
| CDP 只读基线快照 | `baseline-1789465249.json` | — | — |

### 关键路径

```
真实数据文件   <old-vault>/Components/History/readTimeHistory.json
vault 插件目录 <old-vault>/.obsidian/plugins/documents-activity-tracker/
工程目录       <repo>/
```

## 二、回滚步骤

**唯一的安全回滚窗口是「插件启用后、新版本第一次落盘之前」。**
一旦新版本写盘，`readTimeHistory.json` 的 `version` 已变为 `3`。

```bash
VAULT="<old-vault>/.obsidian/plugins/documents-activity-tracker"
DATA="<old-vault>/Components/History/readTimeHistory.json"
TS=1789465241

# 1. 在 Obsidian 中禁用 documents-activity-tracker（设置 → 第三方插件）
#    插件当前本就处于禁用状态，若已启用需先禁用

# 2. 还原数据文件
cp "<repo>/backups/readTimeHistory.json.pre-ts-$TS" "$DATA"

# 3. 还原插件产物
cp "<repo>/backups/vault-main.js.b-version-$TS" "$VAULT/main.js"

# 4. 在 Obsidian 中重新启用插件
```

### 校验副本未被改动

```bash
cd <repo>/backups
md5sum readTimeHistory.json.pre-ts-1789465241   # 应为 88b76e629ed91030040c8f52db755a58
md5sum vault-main.js.b-version-1789465241       # 应为 f20373605744066915f41fa01745ca04
```

## 三、已知的数据迁移风险（重构前）

重构前的 `migrateDataV2ToV3` 白名单为
`['start','pause','resume','save','auto-save','discard']`，
而真实数据中另有 `blur`(19) / `focus`(14) / `switch`(8) 共 **41 个事件不在白名单**，
且 `reason` / `from` / `to` 字段会被丢弃。

**本次重构的第一优先级修复项**即是将迁移改为非破坏性（白名单扩容 + 保留附加字段），
并以 `tests/migration.spec.ts` 硬断言 `timeline.length === 138` 且幂等。

## 四、已知的样式异常（勿修）

`styles.css` 在第 1400-1402 行存在一段孤立声明（丢失了选择器行），
导致文件整体 brace depth 收于 `-1`：

```
1399: }                              ← .rtt-timeline-duration 正常闭合
1400:     color: var(--text-normal);  ← 孤立声明
1401:     font-size: 12px;
1402: }                              ← 多余的右括号
```

CSS 错误恢复在每个规则边界重新同步，视觉上未暴露问题。
**这是既有状态，本次重构必须原样保留**：CSS 拆分为逐字节拼接，
产物 md5 必须仍为 `d15dfb090e8fb907527dba913edf353c`。如需修复请单开一次改动。
