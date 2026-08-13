import "dotenv/config";

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { Document } from "@langchain/core/documents";
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { createDeepAgent, StateBackend, type SubAgent } from "deepagents";
import { getLLM } from "../libs/llm-provider.js";

// ============================================================================
// Configuration
// ============================================================================

const DOCS_BASE = "https://docs.langchain.com";
const VECTOR_STORE_PATH = "./vectorstore/index.json";

interface MemoryVector {
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  id?: string;
}

interface SerializedVectorStore {
  version: number;
  embeddingModel: string;
  embeddingDimensions?: number;
  docPaths: string[];
  vectors: MemoryVector[];
  createdAt: string;
}

// Curated LangChain OSS pages for this tutorial. Expand this list or filter
// llms.txt URLs to index more of the site.
const DOC_PATHS = [
  "oss/javascript/langchain/agents",
  "oss/javascript/deepagents/rag",
  "oss/javascript/langchain/tools",
  "oss/javascript/langchain/models",
  "oss/javascript/deepagents/retrieval",
  "oss/javascript/langchain/knowledge-base",
  "oss/javascript/langchain/middleware",
  "oss/javascript/deepagents/overview",
  "oss/javascript/deepagents/subagents",
  "oss/javascript/deepagents/streaming",
  "oss/javascript/deepagents/frontend/subagent-streaming",
  "oss/javascript/deepagents/backends",
  "oss/javascript/langgraph/overview",
  "oss/javascript/langgraph/quickstart",
];

const EXAMPLE_QUERY =
  "How do I stream intermediate tool results from a subagent?";

// ============================================================================
// Embedding factory: switch between OpenAI and Qianwen (DashScope) via env
// ============================================================================

function getEmbeddingConfig() {
  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;
  if (dashscopeApiKey) {
    const model = process.env.QWEN_EMBEDDING_MODEL ?? "qwen3.7-text-embedding";
    const dimensions = process.env.QWEN_EMBEDDING_DIMENSIONS
      ? Number(process.env.QWEN_EMBEDDING_DIMENSIONS)
      : undefined;
    return {
      provider: "qianwen" as const,
      model,
      dimensions,
    };
  }
  return {
    provider: "openai" as const,
    model: "text-embedding-3-small",
    dimensions: undefined,
  };
}

function createEmbeddings() {
  const config = getEmbeddingConfig();
  if (config.provider === "qianwen") {
    console.log("🧠 Using Qianwen embedding:", config.model);
    return new OpenAIEmbeddings({
      apiKey: process.env.DASHSCOPE_API_KEY,
      configuration: {
        baseURL:
          process.env.DASHSCOPE_BASE_URL ??
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      model: config.model,
      batchSize: 20,
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    });
  }

  console.log("🧠 Using OpenAI embedding: text-embedding-3-small");
  return new OpenAIEmbeddings({ model: "text-embedding-3-small" });
}

// ============================================================================
// Persistence helpers for MemoryVectorStore
// ============================================================================

function saveVectorStore(
  vectorStore: MemoryVectorStore,
  docPaths: string[],
  filePath: string,
): void {
  const config = getEmbeddingConfig();
  const serialized: SerializedVectorStore = {
    version: 1,
    embeddingModel: config.model,
    embeddingDimensions: config.dimensions,
    docPaths,
    vectors: (vectorStore as any).memoryVectors as MemoryVector[],
    createdAt: new Date().toISOString(),
  };

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(serialized, null, 2), "utf-8");

  const sizeMB = (Buffer.byteLength(JSON.stringify(serialized)) / 1024 / 1024).toFixed(2);
  console.log(`💾 Saved ${serialized.vectors.length} vectors to ${filePath} (${sizeMB} MB)`);
}

async function loadVectorStore(
  filePath: string,
): Promise<MemoryVectorStore | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as SerializedVectorStore;
    const config = getEmbeddingConfig();

    if (data.embeddingModel !== config.model) {
      console.warn(
        `⚠️  Embedding model mismatch: saved="${data.embeddingModel}", current="${config.model}". Rebuilding...`,
      );
      return null;
    }

    if (data.embeddingDimensions !== config.dimensions) {
      console.warn(
        `⚠️  Embedding dimensions mismatch: saved=${data.embeddingDimensions}, current=${config.dimensions}. Rebuilding...`,
      );
      return null;
    }

    const embeddings = createEmbeddings();
    const vectorStore = new MemoryVectorStore(embeddings);

    (vectorStore as any).memoryVectors = data.vectors;

    console.log(
      `✅ Loaded ${data.vectors.length} vectors from ${filePath} (indexed at ${data.createdAt})`,
    );
    return vectorStore;
  } catch (error) {
    console.warn(`⚠️  Failed to load vector store:`, error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================================================
// Step 1: Load documents
// ============================================================================

async function loadLangchainDocs(
  docPaths: string[] = DOC_PATHS,
): Promise<Document[]> {
  const docs: Document[] = [];
  for (const path of docPaths) {
    const url = `${DOCS_BASE}/${path}.md`;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const text = await response.text();
      docs.push(
        new Document({
          pageContent: text,
          metadata: { source: `${DOCS_BASE}/${path}` },
        }),
      );
    } catch {
      continue;
    }
  }
  return docs;
}

// ============================================================================
// Step 2: Build the vector store (load -> split -> embed -> store -> persist)
// Design: "load local first, rebuild as fallback" pattern per Experience #519197
// ============================================================================

async function buildVectorStore(forceRebuild = false): Promise<MemoryVectorStore> {
  if (!forceRebuild) {
    const existing = await loadVectorStore(VECTOR_STORE_PATH);
    if (existing) {
      return existing;
    }
  }

  console.log("🔨 Building new vector store from documentation...");
  console.log("Loading LangChain documentation...");
  const docs = await loadLangchainDocs();
  console.log(`Loaded ${docs.length} documentation pages.`);

  const totalChars = docs.reduce((sum, doc) => sum + doc.pageContent.length, 0);
  console.log(`Total characters: ${totalChars}`);

  console.log("Splitting documents into chunks...");
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const allSplits = await textSplitter.splitDocuments(docs);
  console.log(`Split documentation into ${allSplits.length} chunks.`);

  console.log("Creating embeddings and indexing into the vector store...");
  const embeddings = createEmbeddings();
  const vectorStore = await MemoryVectorStore.fromDocuments(allSplits, embeddings);
  console.log(`Indexed ${allSplits.length} chunks.`);

  saveVectorStore(vectorStore, DOC_PATHS, VECTOR_STORE_PATH);

  return vectorStore;
}

// ============================================================================
// Step 3: Build the agent (retrieve, offload, and delegate)
// ============================================================================

const RAG_WORKFLOW_INSTRUCTIONS = `# Documentation Q&A workflow

Answer questions about LangChain using the indexed documentation corpus.

1. **Plan**: Use write_todos to break complex questions into focused search queries.
2. **Search**: Call search_documentation with a query. The tool saves matching chunks under /retrieved/ and returns their file paths.
3. **Analyze**: For each saved chunk file, delegate to the chunk-analyst subagent. Pass the file path so the analyst can read it. Run at most {max_concurrent_analysts} analysts in parallel.
4. **Synthesize**: Combine analyst reports into a final answer. Cite source URLs from the chunk headers.

If search results do not contain relevant information, reformulate the query and search again before answering from prior knowledge.`;

const SUBAGENT_DELEGATION_INSTRUCTIONS = `# Delegating to subagents

Hand off focused analysis work to the chunk-analyst subagent. Each subagent gets an isolated context, so large file content does not pollute the main conversation.

- chunk-analyst: Reads a single retrieved chunk file and returns a concise summary addressing the user's question.

When delegating:
- Keep each task focused on one specific file.
- Limit concurrent delegations to {max_concurrent_analysts} to avoid rate limits.
- After all analysts return, synthesize their findings with citations to the source URLs.`;

async function createRagAgent(forceRebuild = false) {
  const vectorStore = await buildVectorStore(forceRebuild);
  const backend = new StateBackend();

  // Custom retrieval tool: run vector similarity search, then write each
  // retrieved chunk to the agent filesystem instead of returning full text.
  const searchDocumentation = tool(
    async ({ query }) => {
      const retrievedDocs = await vectorStore.similaritySearch(query, 4);
      const batchId = randomUUID().slice(0, 8);
      const uploads: Array<[string, Uint8Array]> = [];
      const savedPaths: string[] = [];

      retrievedDocs.forEach((doc: Document, index: number) => {
        const path = `/retrieved/${batchId}/chunk_${index + 1}.md`;
        const content =
          `# Source: ${doc.metadata?.source ?? "unknown"}\n\n${doc.pageContent}`;
        uploads.push([path, new TextEncoder().encode(content)]);
        savedPaths.push(path);
      });

      await backend.uploadFiles(uploads);
      return `Saved ${savedPaths.length} documentation chunks:\n${savedPaths.join("\n")}`;
    },
    {
      name: "search_documentation",
      description:
        "Search LangChain documentation and save matching chunks to the agent filesystem under /retrieved/.",
      schema: z.object({
        query: z.string().describe("Natural language search query."),
      }),
    },
  );

  const maxConcurrentAnalysts = 3;
  const systemPrompt =
    RAG_WORKFLOW_INSTRUCTIONS.replaceAll(
      "{max_concurrent_analysts}",
      String(maxConcurrentAnalysts),
    ) +
    "\n\n" +
    "=".repeat(80) +
    "\n\n" +
    SUBAGENT_DELEGATION_INSTRUCTIONS.replaceAll(
      "{max_concurrent_analysts}",
      String(maxConcurrentAnalysts),
    );

  // Subagent that reads a single chunk file and returns a focused summary.
  // It uses the built-in filesystem tools (read_file) exposed by the backend.
  const chunkAnalyst: SubAgent = {
    name: "chunk-analyst",
    description:
      "Reads a single retrieved documentation chunk file and returns a concise, focused summary answering the user's question.",
    systemPrompt:
      "You are a documentation analyst. Read the chunk file at the path provided to you using read_file. " +
      "Return a concise summary that directly answers or relates to the user's question, and include the " +
      "source URL from the file header. If the chunk is not relevant, say so briefly.",
  };

  const model = getLLM();
  console.log(`🧠 Using LLM: deepseek:${model.model}`);

  const agent = createDeepAgent({
    model,
    tools: [searchDocumentation],
    subagents: [chunkAnalyst],
    systemPrompt,
    backend,
  });

  return agent;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const isIndexOnly = args.includes("--index-only");
  const forceRebuild = args.includes("--rebuild");

  console.log("=".repeat(80));
  console.log("Deep Agents RAG - Documentation Q&A Agent");
  console.log("=".repeat(80));
  console.log();

  if (isIndexOnly) {
    await buildVectorStore(forceRebuild);
    console.log("Indexing complete.");
    return;
  }

  const agent = await createRagAgent(forceRebuild);

  console.log();
  console.log(`Query: ${EXAMPLE_QUERY}`);
  console.log("-".repeat(80));
  console.log();

  const result = await agent.invoke({
    messages: [new HumanMessage(EXAMPLE_QUERY)],
  });

  const finalMessage = result.messages.at(-1);
  console.log("Final answer:");
  console.log("-".repeat(80));
  console.log(finalMessage?.text ?? finalMessage?.content ?? "(no response)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
