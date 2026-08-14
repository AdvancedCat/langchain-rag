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
