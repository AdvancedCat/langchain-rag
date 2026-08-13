import "dotenv/config";

import { randomUUID } from "node:crypto";
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

function createEmbeddings() {
  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;
  if (dashscopeApiKey) {
    console.log(
      "🧠 Using Qianwen embedding:",
      process.env.QWEN_EMBEDDING_MODEL ?? "qwen3.7-text-embedding",
    );
    const dimensions = process.env.QWEN_EMBEDDING_DIMENSIONS
      ? Number(process.env.QWEN_EMBEDDING_DIMENSIONS)
      : undefined;
    return new OpenAIEmbeddings({
      apiKey: dashscopeApiKey,
      configuration: {
        baseURL:
          process.env.DASHSCOPE_BASE_URL ??
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      model:
        process.env.QWEN_EMBEDDING_MODEL ?? "qwen3.7-text-embedding",
      batchSize: 20, // Qianwen API limit: max 20 inputs per request
      ...(dimensions ? { dimensions } : {}),
    });
  }

  // Fallback to OpenAI default
  console.log("🧠 Using OpenAI embedding: text-embedding-3-small");
  return new OpenAIEmbeddings({ model: "text-embedding-3-small" });
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
// Step 2: Build the vector store (load -> split -> embed -> store)
// ============================================================================

async function buildVectorStore(): Promise<MemoryVectorStore> {
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
  const vectorStore = new MemoryVectorStore(embeddings);
  await vectorStore.addDocuments(allSplits);
  console.log(`Indexed ${allSplits.length} chunks.`);

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

async function createRagAgent() {
  const vectorStore = await buildVectorStore();
  const backend = new StateBackend();

  // Custom retrieval tool: run vector similarity search, then write each
  // retrieved chunk to the agent filesystem instead of returning full text.
  const searchDocumentation = tool(
    async ({ query }) => {
      const retrievedDocs = await vectorStore.similaritySearch(query, 4);
      const batchId = randomUUID().slice(0, 8);
      const uploads: Array<[string, Uint8Array]> = [];
      const savedPaths: string[] = [];

      retrievedDocs.forEach((doc, index) => {
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
  const isIndexOnly = process.argv.slice(2).includes("--index-only");

  console.log("=".repeat(80));
  console.log("Deep Agents RAG - Documentation Q&A Agent");
  console.log("=".repeat(80));
  console.log();

  if (isIndexOnly) {
    await buildVectorStore();
    console.log("Indexing complete.");
    return;
  }

  const agent = await createRagAgent();

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
