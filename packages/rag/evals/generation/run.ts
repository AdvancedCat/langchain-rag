import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import type { Document } from '@langchain/core/documents';
import type { VectorStore } from '@langchain/core/vectorstores';
import { buildVectorStore } from '../../src/ingestion/index.js';
import { createEmbeddings } from '../../src/embeddings.js';
import { generateAnswer, getEvalLLM } from './generator.js';
import { evaluateFaithfulness, isAbstention } from './faithfulness.js';
import { evaluateRelevance } from './relevance.js';
import { mean } from '../retrieval/metrics.js';
import type {
    GoldenDataset,
    GoldenQuery,
    QueryType,
    Difficulty,
    RetrievedChunk,
} from '../shared/types.js';
import type {
    GenEvalConfig,
    GenQueryResult,
    GenEvalReport,
    GenTypeBreakdown,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DATASET = resolve(__dirname, '../datasets/langchain-rag.json');
const BASELINES_DIR = resolve(__dirname, '../baselines/generation');

interface CliArgs {
    rebuild: boolean;
    fetchK: number;
    topK: number;
    numQuestions: number;
    datasetPath: string;
    typeFilter?: QueryType;
    difficultyFilter?: Difficulty;
    jsonOutput: boolean;
    limit?: number;
    save?: string;
    abstentionThreshold: number;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);
    const parsed: CliArgs = {
        rebuild: false,
        fetchK: 20,
        topK: 4,
        numQuestions: 3,
        datasetPath: DEFAULT_DATASET,
        jsonOutput: false,
        abstentionThreshold: 0.78,
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
            case '--num-questions':
                parsed.numQuestions = parseInt(args[++i], 10);
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
            case '--limit':
                parsed.limit = parseInt(args[++i], 10);
                break;
            case '--save':
                parsed.save = args[++i];
                break;
            case '--json':
                parsed.jsonOutput = true;
                break;
            case '--abstention-threshold':
                parsed.abstentionThreshold = parseFloat(args[++i]);
                break;
        }
    }
    return parsed;
}

function loadDataset(path: string): GoldenDataset {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as GoldenDataset;
}

async function retrieve(
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

function emptyBreakdown(): GenTypeBreakdown {
    return { count: 0, avgFaithfulness: 0, avgRelevance: 0 };
}

function computeBreakdown(results: GenQueryResult[]): GenTypeBreakdown {
    if (results.length === 0) return emptyBreakdown();
    return {
        count: results.length,
        avgFaithfulness: mean(results.map((r) => r.faithfulness.score)),
        avgRelevance: mean(results.map((r) => r.relevance.score)),
    };
}

function aggregateReport(
    results: GenQueryResult[],
    config: GenEvalConfig,
): Omit<GenEvalReport, 'perQuery' | 'config' | 'evaluatedAt'> {
    const byTypeMap: Record<QueryType, GenQueryResult[]> = {
        concept: [],
        api_usage: [],
        comparison: [],
        troubleshooting: [],
        unanswerable: [],
    };
    const byDifficultyMap: Record<Difficulty, GenQueryResult[]> = {
        easy: [],
        medium: [],
        hard: [],
    };

    const answerableResults: GenQueryResult[] = [];
    const unanswerableResults: GenQueryResult[] = [];

    for (const r of results) {
        byTypeMap[r.query.type].push(r);
        byDifficultyMap[r.query.difficulty].push(r);
        if (r.query.answerable) {
            answerableResults.push(r);
        } else {
            unanswerableResults.push(r);
        }
    }

    const abstentionCorrect = unanswerableResults.filter(
        (r) => r.abstentionCorrect,
    ).length;

    return {
        totalQueries: results.length,
        answerableCount: answerableResults.length,
        unanswerableCount: unanswerableResults.length,
        avgFaithfulness: mean(results.map((r) => r.faithfulness.score)),
        avgRelevance: mean(results.map((r) => r.relevance.score)),
        abstentionRate:
            unanswerableResults.length > 0
                ? abstentionCorrect / unanswerableResults.length
                : 0,
        answerableFaithfulness: mean(
            answerableResults.map((r) => r.faithfulness.score),
        ),
        answerableRelevance: mean(
            answerableResults.map((r) => r.relevance.score),
        ),
        byType: {
            concept: computeBreakdown(byTypeMap.concept),
            api_usage: computeBreakdown(byTypeMap.api_usage),
            comparison: computeBreakdown(byTypeMap.comparison),
            troubleshooting: computeBreakdown(byTypeMap.troubleshooting),
            unanswerable: computeBreakdown(byTypeMap.unanswerable),
        },
        byDifficulty: {
            easy: computeBreakdown(byDifficultyMap.easy),
            medium: computeBreakdown(byDifficultyMap.medium),
            hard: computeBreakdown(byDifficultyMap.hard),
        },
    };
}

function formatPct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
}

function printReport(report: GenEvalReport): void {
    console.log('\n' + '='.repeat(72));
    console.log('  RAGAS-Style Generation Evaluation Report');
    console.log('='.repeat(72));
    console.log(`  Evaluated at  : ${report.evaluatedAt}`);
    console.log(`  Strategy      : ${report.config.retrievalStrategy}`);
    console.log(`  Top K         : ${report.config.topK}, Fetch K: ${report.config.fetchK}`);
    console.log(`  Queries       : ${report.totalQueries} (answerable: ${report.answerableCount}, unanswerable: ${report.unanswerableCount})`);
    console.log('-'.repeat(72));

    console.log('\n  Overall Generation Quality:');
    console.log(`    Faithfulness    : ${formatPct(report.avgFaithfulness)}`);
    console.log(`    Answer Relevance: ${formatPct(report.avgRelevance)}`);
    console.log(`    Abstention Rate : ${formatPct(report.abstentionRate)}`);

    console.log('\n  Answerable Queries Only:');
    console.log(`    Faithfulness    : ${formatPct(report.answerableFaithfulness)}`);
    console.log(`    Answer Relevance: ${formatPct(report.answerableRelevance)}`);

    console.log('\n  By Query Type:');
    console.log('    Type              Count  Faithfulness  Relevance');
    console.log('    ' + '-'.repeat(54));
    for (const [type, b] of Object.entries(report.byType)) {
        console.log(
            `    ${type.padEnd(18)}${String(b.count).padStart(5)}  ${formatPct(b.avgFaithfulness).padStart(12)}  ${formatPct(b.avgRelevance).padStart(9)}`,
        );
    }

    console.log('\n  By Difficulty:');
    console.log('    Difficulty        Count  Faithfulness  Relevance');
    console.log('    ' + '-'.repeat(54));
    for (const [diff, b] of Object.entries(report.byDifficulty)) {
        console.log(
            `    ${diff.padEnd(18)}${String(b.count).padStart(5)}  ${formatPct(b.avgFaithfulness).padStart(12)}  ${formatPct(b.avgRelevance).padStart(9)}`,
        );
    }

    const lowFaithfulness = report.perQuery.filter(
        (r) => r.faithfulness.score < 0.8 && r.query.answerable,
    );
    console.log('\n  Low Faithfulness (< 80%, answerable):');
    if (lowFaithfulness.length === 0) {
        console.log('    None');
    } else {
        for (const r of lowFaithfulness) {
            console.log(`    [${r.query.id}] faith=${formatPct(r.faithfulness.score)} (${r.faithfulness.supportedCount}/${r.faithfulness.totalCount} claims supported)`);
            console.log(`      Q: ${r.query.query}`);
            const unsupported = r.faithfulness.verdicts.filter((v) => !v.supported);
            for (const v of unsupported.slice(0, 3)) {
                console.log(`      ✗ ${v.claim}`);
                console.log(`        → ${v.reason}`);
            }
        }
    }

    const falseConfidence = report.perQuery.filter(
        (r) => !r.query.answerable && !r.abstentionCorrect,
    );
    console.log('\n  Unanswerable False Confidence:');
    if (falseConfidence.length === 0) {
        console.log('    None');
    } else {
        for (const r of falseConfidence) {
            console.log(`    [${r.query.id}] score=${r.topScore.toFixed(4)} faith=${formatPct(r.faithfulness.score)}`);
            console.log(`      Q: ${r.query.query}`);
            console.log(`      A: ${r.generatedAnswer.slice(0, 120)}...`);
        }
    }

    const missedAbstentions = report.perQuery.filter(
        (r) => !r.query.answerable && r.abstentionCorrect,
    );
    if (missedAbstentions.length > 0) {
        console.log('\n  Correctly Abstained (unanswerable):');
        for (const r of missedAbstentions) {
            console.log(`    [${r.query.id}] ✅ ${r.generatedAnswer.slice(0, 80)}`);
        }
    }

    console.log('\n' + '='.repeat(72) + '\n');
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
    if (cli.limit && cli.limit > 0) {
        queries = queries.slice(0, cli.limit);
    }

    console.log(`Loaded ${queries.length} queries from dataset v${dataset.version}`);

    const config: GenEvalConfig = {
        fetchK: cli.fetchK,
        topK: cli.topK,
        numGeneratedQuestions: cli.numQuestions,
        retrievalStrategy: 'baseline-dense',
        abstentionThreshold: cli.abstentionThreshold,
    };

    console.log('Building/loading vector store...');
    const vectorStore = await buildVectorStore(cli.rebuild);
    const embeddings = createEmbeddings();
    const llm = getEvalLLM();

    console.log(`Running generation eval for ${queries.length} queries...`);
    console.log(`(Each query: retrieve → generate → faithfulness → relevance)\n`);

    const results: GenQueryResult[] = [];

    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        process.stdout.write(`  [${i + 1}/${queries.length}] ${q.id}: ${q.query.slice(0, 45)}...\r`);

        try {
            const allRetrieved = await retrieve(vectorStore, q.query, cli.fetchK);
            const topChunks = allRetrieved.slice(0, cli.topK);
            const topScore = allRetrieved[0]?.score ?? 0;

            const generatedAnswer = await generateAnswer(q.query, topChunks);

            const [faithfulness, relevance] = await Promise.all([
                evaluateFaithfulness(llm, generatedAnswer, topChunks),
                evaluateRelevance(
                    llm,
                    embeddings,
                    q.query,
                    generatedAnswer,
                    cli.numQuestions,
                ),
            ]);

            const generationAbstained = isAbstention(generatedAnswer);
            const retrievalAbstained = topScore < cli.abstentionThreshold;
            const abstentionCorrect = q.answerable
                ? !generationAbstained
                : generationAbstained;

            results.push({
                query: q,
                retrieved: allRetrieved,
                generatedAnswer,
                faithfulness,
                relevance,
                generationAbstained,
                retrievalAbstained,
                abstentionCorrect,
                topScore,
            });
        } catch (err) {
            console.error(`\n  [${q.id}] Error:`, err instanceof Error ? err.message : err);
        }
    }
    process.stdout.write('\n');

    const aggregate = aggregateReport(results, config);
    const report: GenEvalReport = {
        ...aggregate,
        perQuery: results,
        config,
        evaluatedAt: new Date().toISOString(),
    };

    if (cli.jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printReport(report);
    }

    if (cli.save) {
        mkdirSync(BASELINES_DIR, { recursive: true });
        const savePath = resolve(BASELINES_DIR, cli.save);
        writeFileSync(savePath, JSON.stringify(report, null, 2) + '\n');
        console.log(`Report saved to ${savePath}`);
    }
}

main().catch((err) => {
    console.error('Generation evaluation failed:', err);
    process.exit(1);
});
