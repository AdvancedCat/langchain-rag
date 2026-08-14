import type {
    GoldenDataset,
    GoldenQuery,
    QueryType,
    Difficulty,
    RetrievedChunk,
} from '../shared/types.js';

export type { GoldenDataset, GoldenQuery, QueryType, Difficulty, RetrievedChunk };

export interface QueryResult {
    query: GoldenQuery;
    retrieved: RetrievedChunk[];
    hitAtK: Record<number, boolean>;
    precisionAtK: Record<number, number>;
    reciprocalRank: number;
    ndcgAtK: Record<number, number>;
    keywordHits: number;
    keywordTotal: number;
    abstentionCorrect: boolean;
    topScore: number;
}

export interface ScoreStats {
    min: number;
    max: number;
    mean: number;
    median: number;
    belowThreshold: number;
}

export interface EvalReport {
    evaluatedAt: string;
    totalQueries: number;
    answerableCount: number;
    unanswerableCount: number;
    hitRateAtK: Record<number, number>;
    precisionAtK: Record<number, number>;
    mrr: number;
    ndcgAtK: Record<number, number>;
    avgKeywordRecall: number;
    abstentionRate: number;
    answerableScoreStats: ScoreStats;
    unanswerableScoreStats: ScoreStats;
    byType: Record<QueryType, TypeBreakdown>;
    byDifficulty: Record<Difficulty, TypeBreakdown>;
    perQuery: QueryResult[];
    config: EvalConfig;
}

export interface TypeBreakdown {
    count: number;
    hitRateAtK: Record<number, number>;
    precisionAtK: Record<number, number>;
    mrr: number;
    ndcgAtK: Record<number, number>;
}

export interface EvalConfig {
    fetchK: number;
    topK: number;
    hitRateKs: number[];
    ndcgKs: number[];
    retrievalStrategy: string;
    abstentionThreshold: number;
}
