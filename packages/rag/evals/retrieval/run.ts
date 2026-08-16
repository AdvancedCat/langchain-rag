import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { buildVectorStore } from '../../src/ingestion/index.js';
import { retrieve } from '../../src/retrieval/pipeline.js';
import type { RetrieveDeps } from '../../src/retrieval/pipeline.js';
import { getGlobalBM25Retriever } from '../../src/retrieval/retrievers/bm25.js';
import { getMaxDenseScore } from '../../src/retrieval/types.js';
import { createDashScopeReranker, type Reranker } from '../../src/retrieval/rerankers/index.js';
import { getLLM } from '../../../libs/llm-provider.js';
import type { RetrievalConfig } from '../../src/config.js';
import { evaluateQuery, mean } from './metrics.js';
import type {
    GoldenDataset,
    GoldenQuery,
    QueryResult,
    EvalReport,
    EvalConfig,
    QueryType,
    Difficulty,
    TypeBreakdown,
    RetrievedChunk,
    ScoreStats,
    RetrievalStrategy,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DATASET = resolve(__dirname, '../datasets/langchain-rag.json');

interface CliArgs {
    rebuild: boolean;
    fetchK: number;
    topK: number;
    datasetPath: string;
    typeFilter?: QueryType;
    difficultyFilter?: Difficulty;
    jsonOutput: boolean;
    abstentionThreshold: number;
    strategy: RetrievalStrategy;
    scoreThreshold?: number;
    mmrLambda: number;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);
    const parsed: CliArgs = {
        rebuild: false,
        fetchK: 20,
        topK: 4,
        datasetPath: DEFAULT_DATASET,
        jsonOutput: false,
        abstentionThreshold: 0.78,
        strategy: 'hybrid-rewrite',
        mmrLambda: 0.9,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--rebuild':
                parsed.rebuild = true;
                break;
            case '--k':
                parsed.fetchK = parseInt(args[++i], 10);
                break;
            case '--top-k':
                parsed.topK = parseInt(args[++i], 10);
                break;
            case '--dataset':
                parsed.datasetPath = resolve(args[++i]);
                break;
            case '--type':
                parsed.typeFilter = args[++i] as QueryType;
                break;
            case '--difficulty':
                parsed.difficultyFilter = args[++i] as Difficulty;
                break;
            case '--abstention-threshold':
                parsed.abstentionThreshold = parseFloat(args[++i]);
                break;
            case '--strategy':
                parsed.strategy = args[++i] as RetrievalStrategy;
                break;
            case '--score-threshold':
                parsed.scoreThreshold = parseFloat(args[++i]);
                break;
            case '--mmr-lambda':
                parsed.mmrLambda = parseFloat(args[++i]);
                break;
            case '--json':
                parsed.jsonOutput = true;
                break;
        }
    }

    const validStrategies: RetrievalStrategy[] = [
        'baseline-dense',
        'threshold-mmr',
        'hybrid-bm25',
        'hybrid-rewrite',
        'hybrid-multiquery',
        'hybrid-rerank',
    ];
    if (!validStrategies.includes(parsed.strategy)) {
        throw new Error(
            `--strategy must be one of ${validStrategies.join(', ')}, received: ${parsed.strategy}`,
        );
    }
    if (!Number.isInteger(parsed.fetchK) || parsed.fetchK <= 0) {
        throw new Error(`--k must be a positive integer, received: ${parsed.fetchK}`);
    }
    if (!Number.isInteger(parsed.topK) || parsed.topK <= 0) {
        throw new Error(`--top-k must be a positive integer, received: ${parsed.topK}`);
    }
    if (parsed.fetchK < parsed.topK) {
        throw new Error('--k must be greater than or equal to --top-k');
    }
    if (parsed.strategy === 'threshold-mmr' && parsed.scoreThreshold === undefined) {
        throw new Error('--score-threshold is required for strategy threshold-mmr');
    }
    if (
        parsed.scoreThreshold !== undefined &&
        (!Number.isFinite(parsed.scoreThreshold) ||
            parsed.scoreThreshold < -1 ||
            parsed.scoreThreshold > 1)
    ) {
        throw new Error(
            `--score-threshold must be between -1 and 1, received: ${parsed.scoreThreshold}`,
        );
    }
    if (!Number.isFinite(parsed.mmrLambda) || parsed.mmrLambda < 0 || parsed.mmrLambda > 1) {
        throw new Error(`--mmr-lambda must be between 0 and 1, received: ${parsed.mmrLambda}`);
    }
    return parsed;
}

function buildRetrievalConfig(cli: CliArgs): RetrievalConfig {
    const base: RetrievalConfig = {
        topK: cli.topK,
        fetchK: cli.fetchK,
        scoreThreshold: cli.scoreThreshold,
        mmr: {
            enabled: false,
            lambda: cli.mmrLambda,
        },
        hybrid: {
            enabled: false,
            rrfConstant: 60,
            sparseTopK: 5,
            denseTopK: 30,
            denseWeight: 2,
            sparseWeight: 0.5,
        },
        queryTransform: {
            rewrite: false,
            multiQuery: false,
            multiQueryCount: 3,
        },
        rerank: {
            enabled: false,
            model: 'qwen3-rerank',
            topN: cli.topK,
            rerankUrl: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
        },
    };

    switch (cli.strategy) {
        case 'baseline-dense':
            break;
        case 'threshold-mmr':
            base.mmr.enabled = true;
            break;
        case 'hybrid-bm25':
            base.hybrid.enabled = true;
            break;
        case 'hybrid-rewrite':
            base.hybrid.enabled = true;
            base.queryTransform.rewrite = true;
            break;
        case 'hybrid-multiquery':
            base.hybrid.enabled = true;
            base.queryTransform.rewrite = true;
            base.queryTransform.multiQuery = true;
            break;
        case 'hybrid-rerank':
            base.hybrid.enabled = true;
            base.queryTransform.rewrite = true;
            base.rerank.enabled = true;
            base.rerank.topN = cli.topK;
            break;
    }

    return base;
}

function loadDataset(path: string): GoldenDataset {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as GoldenDataset;
}

async function retrieveForStrategy(
    deps: RetrieveDeps,
    query: string,
    config: RetrievalConfig,
    strategy: RetrievalStrategy,
): Promise<{ chunks: RetrievedChunk[]; topDenseScore: number }> {
    if (strategy === 'baseline-dense') {
        const denseConfig: RetrievalConfig = {
            ...config,
            hybrid: { ...config.hybrid, enabled: false },
            queryTransform: { rewrite: false, multiQuery: false, multiQueryCount: 3 },
            scoreThreshold: undefined,
            mmr: { enabled: false, lambda: config.mmr.lambda },
        };
        const results = await retrieve(deps, query, denseConfig);
        const chunks = results.map(({ document, score }, index) => ({
            docPath: document.metadata?.docPath ?? 'unknown',
            chunkIndex:
                typeof document.metadata?.chunkIndex === 'number'
                    ? document.metadata.chunkIndex
                    : undefined,
            score,
            content: document.pageContent,
            rank: index + 1,
        }));
        return { chunks, topDenseScore: results.length > 0 ? results[0].score : 0 };
    }

    const results = await retrieve(deps, query, config);
    const chunks = results.map(({ document, score }, index) => ({
        docPath: document.metadata?.docPath ?? 'unknown',
        chunkIndex:
            typeof document.metadata?.chunkIndex === 'number'
                ? document.metadata.chunkIndex
                : undefined,
        score,
        content: document.pageContent,
        rank: index + 1,
    }));
    return { chunks, topDenseScore: getMaxDenseScore(results) };
}

function emptyBreakdown(ks: number[]): TypeBreakdown {
    return {
        count: 0,
        hitRateAtK: Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>,
        precisionAtK: Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>,
        mrr: 0,
        ndcgAtK: Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>,
        duplicateChunkRatioAtK: Object.fromEntries(
            ks.map((k) => [k, 0]),
        ) as Record<number, number>,
        uniqueSourceCoverageAtK: Object.fromEntries(
            ks.map((k) => [k, 0]),
        ) as Record<number, number>,
        generationContextQualityAtK: Object.fromEntries(
            ks.map((k) => [k, 0]),
        ) as Record<number, number>,
    };
}

function computeBreakdown(results: QueryResult[], ks: number[]): TypeBreakdown {
    const b = emptyBreakdown(ks);
    b.count = results.length;
    if (results.length === 0) return b;

    for (const k of ks) {
        b.hitRateAtK[k] = mean(results.map((r) => (r.hitAtK[k] ? 1 : 0)));
        b.precisionAtK[k] = mean(results.map((r) => r.precisionAtK[k]));
        b.ndcgAtK[k] = mean(results.map((r) => r.ndcgAtK[k]));

        const answerableResults = results.filter((r) => r.query.answerable);
        b.duplicateChunkRatioAtK[k] = mean(
            answerableResults.map((r) => r.duplicateChunkRatioAtK[k]),
        );
        b.uniqueSourceCoverageAtK[k] = mean(
            answerableResults.map((r) => r.uniqueSourceCoverageAtK[k]),
        );
        b.generationContextQualityAtK[k] = mean(
            answerableResults.map((r) => r.generationContextQualityAtK[k]),
        );
    }
    b.mrr = mean(results.map((r) => r.reciprocalRank));
    return b;
}

function computeScoreStats(
    results: QueryResult[],
    threshold: number,
): ScoreStats {
    if (results.length === 0) {
        return { min: 0, max: 0, mean: 0, median: 0, belowThreshold: 0 };
    }
    const scores = results.map((r) => r.topScore).sort((a, b) => a - b);
    return {
        min: scores[0],
        max: scores[scores.length - 1],
        mean: mean(scores),
        median: scores[Math.floor(scores.length / 2)],
        belowThreshold: scores.filter((s) => s < threshold).length,
    };
}

function aggregateReport(
    results: QueryResult[],
    config: EvalConfig,
): Omit<EvalReport, 'perQuery' | 'config' | 'evaluatedAt'> {
    const ks = config.hitRateKs;

    const byType: Record<QueryType, QueryResult[]> = {
        concept: [],
        api_usage: [],
        comparison: [],
        troubleshooting: [],
        unanswerable: [],
    };
    const byDifficultyRec: Record<Difficulty, QueryResult[]> = {
        easy: [],
        medium: [],
        hard: [],
    };

    const answerableResults: QueryResult[] = [];
    const unanswerableResults: QueryResult[] = [];

    for (const r of results) {
        byType[r.query.type].push(r);
        byDifficultyRec[r.query.difficulty].push(r);
        if (r.query.answerable) {
            answerableResults.push(r);
        } else {
            unanswerableResults.push(r);
        }
    }

    const keywordResults = answerableResults.filter((r) => r.keywordTotal > 0);
    const avgKeywordRecall = keywordResults.length > 0
        ? mean(keywordResults.map((r) => r.keywordHits / r.keywordTotal))
        : 0;

    const abstentionCorrect = unanswerableResults.filter((r) => r.abstentionCorrect).length;
    const abstentionRate = unanswerableResults.length > 0
        ? abstentionCorrect / unanswerableResults.length
        : 0;

    return {
        totalQueries: results.length,
        answerableCount: answerableResults.length,
        unanswerableCount: unanswerableResults.length,
        hitRateAtK: Object.fromEntries(
            ks.map((k) => [k, mean(answerableResults.map((r) => (r.hitAtK[k] ? 1 : 0)))]),
        ) as Record<number, number>,
        precisionAtK: Object.fromEntries(
            ks.map((k) => [k, mean(answerableResults.map((r) => r.precisionAtK[k]))]),
        ) as Record<number, number>,
        mrr: mean(answerableResults.map((r) => r.reciprocalRank)),
        ndcgAtK: Object.fromEntries(
            ks.map((k) => [k, mean(answerableResults.map((r) => r.ndcgAtK[k]))]),
        ) as Record<number, number>,
        avgKeywordRecall,
        avgDuplicateChunkRatioAtK: Object.fromEntries(
            ks.map((k) => [
                k,
                mean(answerableResults.map((r) => r.duplicateChunkRatioAtK[k])),
            ]),
        ) as Record<number, number>,
        avgUniqueSourceCoverageAtK: Object.fromEntries(
            ks.map((k) => [
                k,
                mean(answerableResults.map((r) => r.uniqueSourceCoverageAtK[k])),
            ]),
        ) as Record<number, number>,
        avgGenerationContextQualityAtK: Object.fromEntries(
            ks.map((k) => [
                k,
                mean(answerableResults.map((r) => r.generationContextQualityAtK[k])),
            ]),
        ) as Record<number, number>,
        abstentionRate,
        answerableScoreStats: computeScoreStats(answerableResults, config.abstentionThreshold),
        unanswerableScoreStats: computeScoreStats(unanswerableResults, config.abstentionThreshold),
        byType: {
            concept: computeBreakdown(byType.concept, ks),
            api_usage: computeBreakdown(byType.api_usage, ks),
            comparison: computeBreakdown(byType.comparison, ks),
            troubleshooting: computeBreakdown(byType.troubleshooting, ks),
            unanswerable: computeBreakdown(byType.unanswerable, ks),
        },
        byDifficulty: {
            easy: computeBreakdown(byDifficultyRec.easy, ks),
            medium: computeBreakdown(byDifficultyRec.medium, ks),
            hard: computeBreakdown(byDifficultyRec.hard, ks),
        },
    };
}

function formatPct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
}

function formatScore(v: number): string {
    return v.toFixed(4);
}

function printScoreStats(label: string, stats: ScoreStats, threshold: number): void {
    console.log(`  ${label}:`);
    console.log(`    min=${formatScore(stats.min)}  max=${formatScore(stats.max)}  mean=${formatScore(stats.mean)}  median=${formatScore(stats.median)}`);
    console.log(`    below threshold (${threshold}): ${stats.belowThreshold}`);
}

function printReport(report: EvalReport): void {
    console.log('\n' + '='.repeat(72));
    console.log('  RAG Retrieval Evaluation Report');
    console.log('='.repeat(72));
    console.log(`  Evaluated at  : ${report.evaluatedAt}`);
    console.log(`  Strategy      : ${report.config.retrievalStrategy}`);
    console.log(`  Fetch K       : ${report.config.fetchK}, Top K: ${report.config.topK}`);
    if (report.config.scoreThreshold !== undefined) {
        console.log(`  Score threshold: ${report.config.scoreThreshold}`);
    }
    if (report.config.mmr.enabled) {
        console.log(`  MMR lambda    : ${report.config.mmr.lambda}`);
    }
    console.log(`  Queries       : ${report.totalQueries} (answerable: ${report.answerableCount}, unanswerable: ${report.unanswerableCount})`);
    console.log('-'.repeat(72));

    console.log('\n  Answerable Metrics (retrieval accuracy):');
    for (const k of report.config.hitRateKs) {
        console.log(`    Hit@${String(k).padEnd(2)}        : ${formatPct(report.hitRateAtK[k])}`);
    }
    for (const k of report.config.hitRateKs) {
        console.log(`    Precision@${String(k).padEnd(2)}  : ${formatPct(report.precisionAtK[k])}`);
    }
    console.log(`    MRR           : ${formatScore(report.mrr)}`);
    for (const k of report.config.ndcgKs) {
        console.log(`    NDCG@${String(k).padEnd(2)}      : ${formatScore(report.ndcgAtK[k])}`);
    }
    console.log(`    Keyword Recall: ${formatPct(report.avgKeywordRecall)} (top ${report.config.topK} only)`);

    const primaryK = report.config.topK;
    console.log('\n  Context Diversity & Generation Proxy (answerable):');
    console.log(`    Duplicate Chunk Ratio@${primaryK}: ${formatPct(report.avgDuplicateChunkRatioAtK[primaryK])}`);
    console.log(`    Unique Source Coverage@${primaryK}: ${formatPct(report.avgUniqueSourceCoverageAtK[primaryK])}`);
    console.log(`    Generation Context Quality@${primaryK}: ${formatPct(report.avgGenerationContextQualityAtK[primaryK])}`);

    if (report.unanswerableCount > 0) {
        console.log('\n  Unanswerable Metrics (abstention ability):');
        console.log(`    Abstention Rate : ${formatPct(report.abstentionRate)} (topScore < ${report.config.abstentionThreshold})`);
    }

    console.log('\n  Score Distribution (using dense cosine score for abstention):');
    printScoreStats('Answerable  ', report.answerableScoreStats, report.config.abstentionThreshold);
    printScoreStats('Unanswerable', report.unanswerableScoreStats, report.config.abstentionThreshold);

    console.log('\n  By Query Type:');
    console.log('    Type              Count  Hit@4   Prec@4  MRR     NDCG@10');
    console.log('    ' + '-'.repeat(62));
    for (const [type, b] of Object.entries(report.byType)) {
        console.log(
            `    ${type.padEnd(18)}${String(b.count).padStart(5)}  ${formatPct(b.hitRateAtK[4] ?? 0).padStart(6)}  ${formatPct(b.precisionAtK[4] ?? 0).padStart(6)}  ${b.mrr.toFixed(3).padStart(6)}  ${(b.ndcgAtK[10] ?? 0).toFixed(3).padStart(6)}`,
        );
    }

    console.log('\n  By Difficulty:');
    console.log('    Difficulty        Count  Hit@4   Prec@4  MRR     NDCG@10');
    console.log('    ' + '-'.repeat(62));
    for (const [diff, b] of Object.entries(report.byDifficulty)) {
        console.log(
            `    ${diff.padEnd(18)}${String(b.count).padStart(5)}  ${formatPct(b.hitRateAtK[4] ?? 0).padStart(6)}  ${formatPct(b.precisionAtK[4] ?? 0).padStart(6)}  ${b.mrr.toFixed(3).padStart(6)}  ${(b.ndcgAtK[10] ?? 0).toFixed(3).padStart(6)}`,
        );
    }

    const answerableFailed = report.perQuery.filter(
        (r) => r.query.answerable && !r.hitAtK[4],
    );
    console.log('\n  Answerable Failures (Hit@4 = 0):');
    if (answerableFailed.length === 0) {
        console.log('    None');
    } else {
        for (const r of answerableFailed) {
            const topPaths = r.retrieved.slice(0, 4).map((c) => c.docPath.split('/').pop()).join(', ');
            console.log(`    [${r.query.id}] (${r.query.type}/${r.query.difficulty}) topDenseScore=${formatScore(r.topScore)}`);
            console.log(`      Q: ${r.query.query}`);
            console.log(`      Expected: ${r.query.expectedDocPaths.map((p) => p.split('/').pop()).join(', ')}`);
            console.log(`      Got: ${topPaths}`);
        }
    }

    if (report.unanswerableCount > 0) {
        const falseConfidence = report.perQuery.filter(
            (r) => !r.query.answerable && !r.abstentionCorrect,
        );
        console.log('\n  Unanswerable False Confidence (topScore >= threshold):');
        if (falseConfidence.length === 0) {
            console.log('    None');
        } else {
            for (const r of falseConfidence) {
                const topPath = r.retrieved[0]?.docPath.split('/').pop() ?? 'none';
                console.log(`    [${r.query.id}] topDenseScore=${formatScore(r.topScore)} -> ${topPath}`);
                console.log(`      Q: ${r.query.query}`);
            }
        }

        const answerableBelowThreshold = report.perQuery.filter(
            (r) => r.query.answerable && r.topScore < report.config.abstentionThreshold,
        );
        if (answerableBelowThreshold.length > 0) {
            console.log('\n  Answerable Low-Score Risk (topScore < threshold, would be false-abstained):');
            for (const r of answerableBelowThreshold) {
                const hit = r.hitAtK[4] ? 'HIT' : 'MISS';
                console.log(`    [${r.query.id}] topDenseScore=${formatScore(r.topScore)} [${hit}] ${r.query.query.slice(0, 50)}`);
            }
        }
    }

    console.log('\n' + '='.repeat(72) + '\n');
}

async function main(): Promise<void> {
    const cli = parseArgs();
    if (cli.jsonOutput) {
        console.log = (...args: unknown[]) => console.error(...args);
    }
    const progressOutput = cli.jsonOutput ? process.stderr : process.stdout;
    const dataset = loadDataset(cli.datasetPath);

    let queries = dataset.queries;
    if (cli.typeFilter) {
        queries = queries.filter((q) => q.type === cli.typeFilter);
    }
    if (cli.difficultyFilter) {
        queries = queries.filter((q) => q.difficulty === cli.difficultyFilter);
    }

    console.log(`Loaded ${queries.length} queries from dataset v${dataset.version}`);

    const metricKs = [...new Set([cli.topK, 10, cli.fetchK])];
    const retrievalConfig = buildRetrievalConfig(cli);
    const evalConfig: EvalConfig = {
        fetchK: cli.fetchK,
        topK: cli.topK,
        hitRateKs: metricKs,
        ndcgKs: metricKs,
        retrievalStrategy: cli.strategy,
        scoreThreshold: cli.scoreThreshold,
        mmr: retrievalConfig.mmr,
        abstentionThreshold: cli.abstentionThreshold,
    };

    console.log('Building/loading vector store and BM25 index...');
    const vectorStore = await buildVectorStore(cli.rebuild);
    const bm25Retriever = getGlobalBM25Retriever();
    const llm = getLLM();

    let reranker: Reranker | undefined;
    if (retrievalConfig.rerank.enabled) {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
            throw new Error('DASHSCOPE_API_KEY is required for hybrid-rerank strategy');
        }
        reranker = createDashScopeReranker({
            apiKey,
            model: retrievalConfig.rerank.model,
            rerankUrl: retrievalConfig.rerank.rerankUrl,
        });
        console.log(`🔄 Reranker enabled for eval: ${retrievalConfig.rerank.model}`);
    }

    const deps: RetrieveDeps = { vectorStore, bm25Retriever, llm, reranker };

    console.log(`Running retrieval (strategy=${cli.strategy}, fetchK=${cli.fetchK}) for ${queries.length} queries...\n`);

    const results: QueryResult[] = [];
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        progressOutput.write(`  [${i + 1}/${queries.length}] ${q.id}: ${q.query.slice(0, 50)}...\r`);
        const { chunks: retrieved, topDenseScore } = await retrieveForStrategy(
            deps,
            q.query,
            retrievalConfig,
            cli.strategy,
        );
        const result = evaluateQuery(q, retrieved, {
            ...evalConfig,
            topScoreOverride: topDenseScore,
        });
        results.push(result);
    }
    progressOutput.write('\n');

    const aggregate = aggregateReport(results, evalConfig);
    const report: EvalReport = {
        ...aggregate,
        perQuery: results,
        config: evalConfig,
        evaluatedAt: new Date().toISOString(),
    };

    if (cli.jsonOutput) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        printReport(report);
    }
}

main().catch((err) => {
    console.error('Evaluation failed:', err);
    process.exit(1);
});
