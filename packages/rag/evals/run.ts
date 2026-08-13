import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import type { Document } from '@langchain/core/documents';
import type { VectorStore } from '@langchain/core/vectorstores';
import { buildVectorStore } from '../src/ingestion/index.js';
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
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DATASET = resolve(__dirname, 'datasets/langchain-rag.json');

interface CliArgs {
    rebuild: boolean;
    fetchK: number;
    datasetPath: string;
    typeFilter?: QueryType;
    difficultyFilter?: Difficulty;
    jsonOutput: boolean;
    topK: number;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);
    const parsed: CliArgs = {
        rebuild: false,
        fetchK: 20,
        datasetPath: DEFAULT_DATASET,
        jsonOutput: false,
        topK: 4,
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
            case '--json':
                parsed.jsonOutput = true;
                break;
        }
    }
    return parsed;
}

function loadDataset(path: string): GoldenDataset {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as GoldenDataset;
}

async function retrieveBaseline(
    vectorStore: VectorStore,
    query: string,
    fetchK: number,
): Promise<RetrievedChunk[]> {
    const results = await (vectorStore as any).similaritySearchVectorWithScore(
        await vectorStore.embeddings.embedQuery(query),
        fetchK,
    );
    return results.map(([doc, score]: [Document, number], idx: number) => ({
        docPath: doc.metadata?.docPath ?? 'unknown',
        score,
        content: doc.pageContent,
        rank: idx + 1,
    }));
}

function emptyBreakdown(ks: number[]): TypeBreakdown {
    return {
        count: 0,
        hitRateAtK: Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>,
        mrr: 0,
        ndcgAtK: Object.fromEntries(ks.map((k) => [k, 0])) as Record<number, number>,
    };
}

function computeBreakdown(results: QueryResult[], ks: number[]): TypeBreakdown {
    const b = emptyBreakdown(ks);
    b.count = results.length;
    if (results.length === 0) return b;

    for (const k of ks) {
        b.hitRateAtK[k] = mean(results.map((r) => (r.hitAtK[k] ? 1 : 0)));
        b.ndcgAtK[k] = mean(results.map((r) => r.ndcgAtK[k]));
    }
    b.mrr = mean(results.map((r) => r.reciprocalRank));
    return b;
}

function aggregateReport(
    results: QueryResult[],
    config: EvalConfig,
): Omit<EvalReport, 'perQuery' | 'config'> {
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
    const unanswerableAvgTopScore = unanswerableResults.length > 0
        ? mean(unanswerableResults.map((r) => r.topScore))
        : 0;

    return {
        totalQueries: results.length,
        answerableCount: answerableResults.length,
        unanswerableCount: unanswerableResults.length,
        hitRateAtK: Object.fromEntries(
            ks.map((k) => [k, mean(answerableResults.map((r) => (r.hitAtK[k] ? 1 : 0)))]),
        ) as Record<number, number>,
        mrr: mean(answerableResults.map((r) => r.reciprocalRank)),
        ndcgAtK: Object.fromEntries(
            ks.map((k) => [k, mean(answerableResults.map((r) => r.ndcgAtK[k]))]),
        ) as Record<number, number>,
        avgKeywordRecall,
        abstentionRate,
        unanswerableAvgTopScore,
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

function printReport(report: EvalReport): void {
    console.log('\n' + '='.repeat(70));
    console.log('  RAG Retrieval Evaluation Report');
    console.log('='.repeat(70));
    console.log(`  Strategy      : ${report.config.retrievalStrategy}`);
    console.log(`  Fetch K       : ${report.config.fetchK}`);
    console.log(`  Total queries : ${report.totalQueries} (answerable: ${report.answerableCount}, unanswerable: ${report.unanswerableCount})`);
    console.log('-'.repeat(70));

    console.log('\n  Answerable Metrics (retrieval accuracy):');
    for (const k of report.config.hitRateKs) {
        console.log(`    Hit Rate@${k}  : ${formatPct(report.hitRateAtK[k])}`);
    }
    console.log(`    MRR           : ${report.mrr.toFixed(4)}`);
    for (const k of report.config.ndcgKs) {
        console.log(`    NDCG@${k}      : ${report.ndcgAtK[k].toFixed(4)}`);
    }
    console.log(`    Keyword Recall: ${formatPct(report.avgKeywordRecall)}`);

    if (report.unanswerableCount > 0) {
        console.log('\n  Unanswerable Metrics (abstention ability):');
        console.log(`    Abstention Rate : ${formatPct(report.abstentionRate)} (topScore < ${report.config.abstentionThreshold})`);
        console.log(`    Avg Top Score   : ${report.unanswerableAvgTopScore.toFixed(4)}`);
    }

    console.log('\n  By Query Type:');
    console.log('    Type              Count  Hit@4   Hit@10  MRR     NDCG@10');
    console.log('    ' + '-'.repeat(62));
    for (const [type, b] of Object.entries(report.byType)) {
        console.log(
            `    ${type.padEnd(18)}${String(b.count).padStart(5)}  ${formatPct(b.hitRateAtK[4] ?? 0).padStart(6)}  ${formatPct(b.hitRateAtK[10] ?? 0).padStart(6)}  ${b.mrr.toFixed(3).padStart(6)}  ${(b.ndcgAtK[10] ?? 0).toFixed(3).padStart(6)}`,
        );
    }

    console.log('\n  By Difficulty:');
    console.log('    Difficulty        Count  Hit@4   Hit@10  MRR     NDCG@10');
    console.log('    ' + '-'.repeat(62));
    for (const [diff, b] of Object.entries(report.byDifficulty)) {
        console.log(
            `    ${diff.padEnd(18)}${String(b.count).padStart(5)}  ${formatPct(b.hitRateAtK[4] ?? 0).padStart(6)}  ${formatPct(b.hitRateAtK[10] ?? 0).padStart(6)}  ${b.mrr.toFixed(3).padStart(6)}  ${(b.ndcgAtK[10] ?? 0).toFixed(3).padStart(6)}`,
        );
    }

    const answerableFailed = report.perQuery.filter(
        (r) => r.query.answerable && !r.hitAtK[4],
    );
    console.log('\n  Answerable Failures (Hit@4 = 0):');
    if (answerableFailed.length === 0) {
        console.log('    None 🎉');
    } else {
        for (const r of answerableFailed) {
            const topPaths = r.retrieved.slice(0, 4).map((c) => c.docPath.split('/').pop()).join(', ');
            console.log(`    [${r.query.id}] (${r.query.type}/${r.query.difficulty})`);
            console.log(`      Q: ${r.query.query}`);
            console.log(`      Expected: ${r.query.expectedDocPaths.map((p) => p.split('/').pop()).join(', ')}`);
            console.log(`      Got: ${topPaths}`);
        }
    }

    const falseConfidence = report.perQuery.filter(
        (r) => !r.query.answerable && !r.abstentionCorrect,
    );
    if (report.unanswerableCount > 0) {
        console.log('\n  Unanswerable False Confidence (topScore >= threshold):');
        if (falseConfidence.length === 0) {
            console.log('    None 🎉');
        } else {
            for (const r of falseConfidence) {
                const topPath = r.retrieved[0]?.docPath.split('/').pop() ?? 'none';
                console.log(`    [${r.query.id}] topScore=${r.topScore.toFixed(4)} -> ${topPath}`);
                console.log(`      Q: ${r.query.query}`);
            }
        }
    }

    console.log('\n' + '='.repeat(70) + '\n');
}

async function main(): Promise<void> {
    const cli = parseArgs();
    const dataset = loadDataset(cli.datasetPath);

    let queries = dataset.queries;
    if (cli.typeFilter) {
        queries = queries.filter((q) => q.type === cli.typeFilter);
    }
    if (cli.difficultyFilter) {
        queries = queries.filter((q) => q.difficulty === cli.difficultyFilter);
    }

    console.log(`📊 Loaded ${queries.length} queries from dataset (v${dataset.version})`);

    const config: EvalConfig = {
        fetchK: cli.fetchK,
        hitRateKs: [cli.topK, 10, cli.fetchK],
        ndcgKs: [cli.topK, 10, cli.fetchK],
        retrievalStrategy: 'baseline-dense',
        abstentionThreshold: 0.78,
    };

    console.log('🔨 Building/loading vector store...');
    const vectorStore = await buildVectorStore(cli.rebuild);

    console.log(`🔍 Running retrieval (fetchK=${cli.fetchK}) for ${queries.length} queries...\n`);

    const results: QueryResult[] = [];
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        process.stdout.write(`  [${i + 1}/${queries.length}] ${q.id}: ${q.query.slice(0, 50)}...\r`);
        const retrieved = await retrieveBaseline(vectorStore, q.query, cli.fetchK);
        const result = evaluateQuery(q, retrieved, config);
        results.push(result);
    }
    process.stdout.write('\n');

    const aggregate = aggregateReport(results, config);
    const report: EvalReport = {
        ...aggregate,
        perQuery: results,
        config,
    };

    if (cli.jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printReport(report);
    }
}

main().catch((err) => {
    console.error('Evaluation failed:', err);
    process.exit(1);
});
