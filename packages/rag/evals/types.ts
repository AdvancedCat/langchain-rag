export type QueryType =
    | 'concept'
    | 'api_usage'
    | 'comparison'
    | 'troubleshooting'
    | 'unanswerable';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface GoldenQuery {
    id: string;
    query: string;
    type: QueryType;
    difficulty: Difficulty;
    expectedDocPaths: string[];
    expectedKeywords: string[];
    answerable: boolean;
}

export interface GoldenDataset {
    version: number;
    description: string;
    createdAt: string;
    queries: GoldenQuery[];
}

export interface RetrievedChunk {
    docPath: string;
    score: number;
    content: string;
    rank: number;
}

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
