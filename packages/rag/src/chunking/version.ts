/**
 * 切分器版本：变更切分策略（header 层级、chunkSize 语义、注入规则等）时必须
 * 更新此常量。它随 chunk metadata 入库，ingestion 热启动时比对，不一致则提示
 * `--rebuild`（根治"代码升级、旧索引静默复用"的坑，决策 D6）。
 *
 * 版本历史：
 * - md-header-v1：h1-h4 header 切分。A/B 实验证实 h4 粒度下同文档 section 霸屏
 *   top4（Hit@4 83.8% vs 旧切分 91.9%，见 evals/results/mdheader-v1.raw.json）。
 * - md-header-v2：默认 header 深度收窄为 h1-h2。A/B：Hit@4 94.6%、Hit@10 100%、
 *   MRR 0.685、Abstention 100%，全面优于旧切分（mdheader-h2.raw.json）。
 */
export const CHUNKER_VERSION = 'md-header-v2';
