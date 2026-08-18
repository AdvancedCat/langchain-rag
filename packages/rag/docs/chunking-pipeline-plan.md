# 切分管道（Chunking Pipeline）实施计划：类型识别 + Splitter 插件化 + 统一 Chunk 契约

> **Phase 标记**：`Chunking Pipeline（契约 + MarkdownSplitter）`
> **所属**：`packages/rag` 文档切分管道升级
> **上游文档**：[evaluation-plan.md](./evaluation-plan.md) §5.3（A/B 流程）、[retrieval-strategy-upgrade.md](./retrieval-strategy-upgrade.md)（检索侧背景）
> **状态**：方案定稿，待实施
> **性质**：架构解耦 + 切分质量优化，不引入新依赖（zod 已有，hash 用 node:crypto）

---

## 1. 现状

### 1.1 当前切分链路

切分逻辑内联在 ingestion 里（`src/ingestion/index.ts:84-100`）：

```typescript
const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
});
// 逐文档切分后打 chunkIndex / totalChunks / indexedAt
```

- 纯字符级切分，**完全未利用 markdown 标题结构**（语料是 58 页 langchain docs，标题规范，浪费了层级语义）；
- 只支持 markdown（HTTP 拉取文本），无类型识别、无插件化，PDF / HTML / 图片无从接入；
- 取数（fetch）、切分（split）、入库（embed + upsert）耦合在一个函数里。

### 1.2 chunk 的消费方现状（改动影响面，均已核实）

| 消费方 | 位置 | 现状 |
|---|---|---|
| BM25 索引 | `src/retrieval/retrievers/bm25.ts:84` | 只索引 `pageContent`，metadata 不参与 |
| dense embedding（入库） | `vectorStore.addDocuments` 内部（`@langchain/qdrant` vectorstores.js:53） | 只嵌 `pageContent` |
| rerank 输入 | `src/retrieval/pipeline.ts:61` | 只发 `pageContent` 字符串 |
| MMR 重嵌 | `src/retrieval/pipeline.ts:120-122` | 只嵌 `pageContent` |
| chunk 身份（去重/融合 key） | `src/retrieval/types.ts:13-17` | `docPath#chunkIndex` |
| agent 引用头 | `src/retrieval/index.ts:81` | 只读 `metadata.source` |
| BM25 热启动重建 | `src/vectorStore.ts:212-244` | 从 Qdrant scroll 回读 `payload.content` + `payload.metadata` |

### 1.3 两个已踩明的坑

- **切分改动必须 `--rebuild`**：`npm run index`（`--index-only`）不带 `--rebuild`，走 `ingestion/index.ts:62-69` 复用路径——代码升级后旧索引被静默复用，新切分一行都不会执行。现有守卫只覆盖 embedding 维度不匹配（`vectorStore.ts:108-117`），对切分策略变化无检测。
- **eval golden 不受 chunk 边界影响**：相关性按 `docPath` 匹配（`evals/retrieval/metrics.ts:3-5`），改切分边界不破坏数据集有效性，可直接 A/B。

### 1.4 冻结基线（引用，不重跑）

dense 基线见 `evals/baselines/retrieval/baseline-dense-20260813.json`（dataset v2，44 query，58 页 / 2681 chunks，Hit@4 89.2%）；当前默认策略（hybrid）基线见 `evals/baselines/retrieval/hybrid-*-2026081*.json`。本次 A/B 的对照组为**同策略 + 旧切分**的现网 collection。

---

## 2. 设计

### 2.1 管道分层

```
Loader（取数：text/bytes + source + declaredType + fetchedAt）
  → TypeDetector（识别：declaredType > magic bytes > 文件名/MIME > 文本嗅探，降级 plaintext + warning）
  → SplitterRegistry（策略分发：Map<DocType, Splitter>）
  → XxxSplitter（解析 + 切分，产出 Chunk[]）
  → 管道统一补 id/docId/contentHash → ChunkValidator（契约守门）
  → [ingestion] 组装 embeddingInput → Qdrant upsert + BM25 build
```

要点：

- **接口统一、实现鼓励组合**：`file → Splitter → chunks` 把解析和切分合在插件内（保留 PDF 页码、阅读顺序等拍平即丢的信息）；公共切分核抽成可复用模块（如 HtmlSplitter 提取后复用 markdown header 核）。IR 是插件实现层的共享工具，不是管道层强制约定。
- **ChunkValidator 是"结构一致"的执行者**：契约靠校验器兜底，不靠插件自觉。硬错误（缺必需字段、chunkIndex 不连续、content 为空）失败；软警告（sectionPath 深度跳级、chunk 超预算）记录不阻断。
- **错误隔离**：单文件失败降级为记录 + 跳过，`SplitResult.warnings` 携带诊断。

### 2.2 两个已核实的技术事实（影响实现路径）

| # | 事实 | 结论 |
|---|---|---|
| F1 | JS 版 `@langchain/textsplitters@1.0.1` **没有** `MarkdownHeaderTextSplitter`（那是 Python 独有 API，JS 只有分隔符感知的 `MarkdownTextSplitter`） | header 切分核（h1-h4 栈扫描）需仓库内自研纯函数 |
| F2 | `@langchain/qdrant` payload 格式为 `{ content, metadata }`，读写同源（vectorstores.js:7/71/128-133） | "存储干净原文 + embedding 用组装文本"可通过自定义 `client.upsert` 实现，与 `fromExistingCollection` 查询路径完全兼容；`fetchAllDocumentsFromQdrant` 已有 `pageContent` key 回退，双保险 |

### 2.3 Chunk 契约

```typescript
type DocType = 'markdown' | 'plaintext' | 'html' | 'pdf' | 'image';  // 本期注册前两者

interface Chunk {
    id: string;              // 确定性：hash(docId + chunkIndex + content)
    content: string;         // 干净原文，绝不掺生成内容（sectionPath 注入在消费侧）
    metadata: ChunkMetadata;
}

interface ChunkMetadata {
    // —— 定位（必需）——
    docId: string;           // canonical URL（web 语料）
    contentHash: string;     // sha256(原文)，本地文件/去重场景的身份
    source: string;          // uri，引用溯源
    docType: DocType;
    docPath?: string;        // 语料内逻辑路径，evals 按 it 匹配 golden，保留为一级字段
    chunkIndex: number;      // 阅读顺序，从 0 连续
    totalChunks: number;

    // —— 语义上下文（有则给）——
    title?: string;          // 首个 h1 或 loader 提供
    sectionPath?: string[];  // ["Agents", "Tools", "Custom tools"]

    // —— 物理溯源（预留，本期不产出）——
    page?: number[];         // pdf：跨页 chunk 为数组
    slide?: number;          // pptx
    bbox?: unknown;          // pdf 高亮引用占位

    // —— 系统（必需）——
    chunkerVersion: string;  // 'md-header-v1'，热启动守卫依据
    language?: string;

    // —— 扩展位 ——
    extra?: Record<string, unknown>;  // 类型特有字段收这里，核心 schema 保持小而稳
}
```

配套纪律：

- **确定性**：Splitter 输出不含任何时间性/随机内容；`fetchedAt` 归 Loader、`indexedAt` 归 ingestion（zod schema 对核心字段严格、允许 passthrough，ingestion 后打 `indexedAt` 不违约）。
- **消费侧组装**：`composeSearchText(content, metadata)` = `sectionPath.join(' > ') + '\n\n' + content`（无 sectionPath 时原样返回），一处实现、四处消费——入库 embedding、BM25 build（含热启动回读路径）、rerank 输入、MMR 重嵌。存储侧始终是干净 `content` + 结构化字段。
- **确定性 ID**：`docId` = canonical URL；`contentHash` = sha256(原文)；chunk `id` = hash(docId + chunkIndex + content)；Qdrant point id 由 `id` 派生确定性 UUID（sha256 格式化），rebuild 幂等、同文档重入覆盖不追加。
- **校验**：zod schema 定义于 `src/chunking/schema.ts`，类型与运行时校验同源。

### 2.4 `src/chunking/` 模块清单

| 文件 | 职责 |
|---|---|
| `types.ts` | 契约接口：`DocType` / `SplitDocInput` / `SplitOptions` / `Chunk` / `ChunkMetadata` / `SplitResult` / `Splitter` |
| `schema.ts` | zod schema（Chunk / ChunkMetadata / SplitResult） |
| `version.ts` | `CHUNKER_VERSION = 'md-header-v1'` |
| `detect.ts` | `detectDocType(input)`：三层判定 + 置信降级 |
| `registry.ts` | `SplitterRegistry`：register / get / fallback |
| `ids.ts` | `contentHash` / `chunkId` / `toDeterministicUuid` |
| `compose.ts` | `composeSearchText`（消费侧注入的唯一实现） |
| `validate.ts` | `validateChunks`：zod + 跨 chunk 不变量 |
| `pipeline.ts` | `runChunkingPipeline(input)`：detect → registry → split → 补 id → validate |
| `splitters/markdown.ts` | header 栈扫描（h1-h4，**跳过代码围栏内的 `#`**）切 section；超长 section 用 `RecursiveCharacterTextSplitter` 二级切；无 header 文档整体作单 section（sectionPath 为空） |
| `splitters/plaintext.ts` | `RecursiveCharacterTextSplitter` 兜底 |
| `index.ts` | 导出 |

### 2.5 文件级改动

**新增**：`src/chunking/`（上表全部文件，均配同目录 `*.test.ts`）。

**修改**

| 文件 | 改动 |
|---|---|
| `src/config.ts` | 新增 `IngestionConfig`：`CHUNK_SIZE`（默认 1000）/ `CHUNK_OVERLAP`（默认 200），沿用现有 env 解析与校验风格 |
| `src/ingestion/index.ts` | `loadLangchainDocs` 变 Loader（产出 text + source + docPath + declaredType + fetchedAt）；切分改调 `runChunkingPipeline`；`indexedAt` 在此打；热启动校验 chunkerVersion，不一致打警告提示 `--rebuild` |
| `src/vectorStore.ts` | `createVectorStoreFromDocuments` 改为 `embeddings.embedDocuments(composedTexts)` + `client.upsert`（确定性 UUID，payload `{ content: 干净原文, metadata }`），替换 `addDocuments`；分批与日志保持 |
| `src/retrieval/retrievers/bm25.ts` | `build()` 内 `tokenize(doc.pageContent)`（:84）改 `tokenize(composeSearchText(...))`；无 sectionPath 的旧文档行为不变 |
| `src/retrieval/types.ts` | `getChunkId` 优先 `metadata.id`，回退 `docPath#chunkIndex`（兼容旧 collection） |
| `src/retrieval/pipeline.ts` | rerank 输入（:61）与 MMR 重嵌（:120-122）改用 `composeSearchText` |
| `src/retrieval/index.ts` | agent 落盘 chunk 文件头（:81）增加 `Section: A > B` 行，子代理引用带章节 |

### 2.6 实施步骤（每步一个 gate）

1. **契约层**：`types.ts` + `schema.ts` + `validate.ts` + 单测 → `pnpm run typecheck`
2. **管道组件**：`detect.ts` / `registry.ts` / `ids.ts` / `compose.ts` + 单测（magic bytes 内联 fixture；compose 验证 join 格式与无 sectionPath 回退；ids 验证确定性）
3. **Splitter**：markdown header 核 + plaintext + 单测（重点：代码围栏内 `#` 不当 header、超长 section 二级切、无 header 退化、同输入同输出）→ gate：全量 `pnpm test`
4. **接线**：`config.ts` IngestionConfig + ingestion 重构 → `pnpm run typecheck`
5. **存储与检索改造**：自定义 upsert + bm25 / pipeline / getChunkId / agent header → `pnpm run typecheck && pnpm test`（现有测试零回归）
6. **全量验证**：typecheck + 单测全绿
7. **A/B eval + 落档**（见 §3.2），结果回填本文档 §5

---

## 3. 预期

### 3.1 成功标准

- 单测：契约校验器、markdown header 核、compose/ids 全覆盖，现有测试零回归；
- A/B（同策略新旧切分对比）：**Hit@4 / MRR 不回退**，easy/medium 分段无系统性回退；chunk 总数与平均长度分布合理（无异常碎块）；
- 收益预期（诚实边界）：sectionPath 注入对 BM25 的增益主要是英文标题词命中（如 "streaming" / "subagent"）；dense 收益依赖 embedding 对前缀的利用，幅度不确定——**以 eval 数据为准，不预设方向**。

### 3.2 A/B 验证流程

```bash
cd packages/rag

# 对照组：现有 collection 直接跑（旧切分，不 rebuild）
pnpm run eval:json > evals/results/mdheader-baseline-old-chunking.raw.json

# 实验组：独立 collection，新旧索引共存
QDRANT_COLLECTION=langchain_docs_mdheader pnpm run eval:rebuild -- --json \
  > evals/results/mdheader-v1.raw.json
```

判定与后续：

- 通过 → `langchain_docs_mdheader` 提升为默认（改 `QDRANT_COLLECTION` 或改名），旧 collection 保留一段时间后删除；
- 不通过 → 分析 bad case（失败 query 列表对比），调 header 层级深度 / chunkSize 后重跑。

### 3.3 已知预期偏移（解读数据时注意）

| 指标 | 偏移原因 |
|---|---|
| `duplicateChunkRatioAtK` | 定义基于旧切分的 chunkIndex 邻接（metrics.ts:71-91），新边界下语义变化，只看趋势不看绝对值 |
| abstention 阈值 0.78 | 基于旧切分 embedding 分数分布标定，re-embed 后分布移动；若误杀率变化，按 phase1 流程网格重扫 |
| `keywordRecall` | 关键词恰被新边界切断的尾部风险，bad case 时逐一核对 |

---

## 4. 已定案决策

| # | 决策 | 备注 |
|---|---|---|
| D1 | `docId`（canonical URL）与 `contentHash`（sha256 原文）**双存** | web 语料用 docId 对照，本地/去重用 contentHash |
| D2 | `sectionPath` 存 **string[]**，消费侧 `join(' > ')` | 结构化利于过滤，注入成本仅一次 join |
| D3 | `content` 只存干净原文，注入发生在消费侧（embedding/BM25/rerank/MMR） | 与 Contextual Retrieval 的"embed 输入 ≠ 存储内容"原则一致 |
| D4 | 时间戳归 ingestion（`indexedAt`）/ Loader（`fetchedAt`），Splitter 确定性输出 | golden test / 内容 hash / 可复现的前提 |
| D5 | 扁平 metadata + `extra` 扩展位，zod 边界校验 | Qdrant payload 过滤需要扁平可索引标量 |
| D6 | `chunkerVersion` 常量入 chunk metadata + 热启动守卫 | 根治"代码升级、索引静默复用"的坑（§1.3） |
| D7 | header 切分核自研（F1），不由 Python 侧 API 迁移 | 纯函数 ~100 行，契合现有单测文化 |
| D8 | 本期只注册 markdown + plaintext；PDF / HTML / Image 为后续插件 | 接口就绪即插件接入，避免本期范围膨胀 |

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 自定义 upsert 与 lib 查询路径不兼容 | F2 已核实 payload key 同源；`fetchAllDocumentsFromQdrant` 有 `pageContent` 回退；eval 前 smoke 一轮问答 |
| header 切分在无 header / 围栏密集文档退化 | 兜底为整段 section + 字符切分，行为不差于现状；validator 记录 warning |
| 中文 BM25 分词（CJK unigram）不受益于 sectionPath | 本期不动分词；sectionPath 主要增益英文标题词，已计入诚实预期 |
| abstention 阈值失配 | §3.3 已列，必要时按 phase1 网格流程重标定 |
| embedding API 成本 | corpus 仅 ~2.7k chunks，一次 rebuild 分钟级、成本可忽略 |

**不做的事**：PDF / HTML / Image Splitter 实现、Contextual Retrieval 的 LLM context 生成、增量更新（`docId` 字段已预留地基）、中文分词升级、ColPali 视觉检索路线。

---

## 6. 实施与标定结果

> 预留：实施完成后回填各 gate 结果、A/B 数据、阈值标定（如涉及）、bad case 分析。
