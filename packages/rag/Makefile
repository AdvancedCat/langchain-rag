# =============================================================================
# RAG Agent — Makefile
# =============================================================================
# Usage: make <target>
# Tip:   make help   (default, lists all targets)
# =============================================================================

SHELL := /bin/bash

# ---- Paths & configuration --------------------------------------------------
PACKAGE_DIR  := $(shell dirname $(realpath $(lastword $(MAKEFILE_LIST))))
COMPOSE      := docker compose
PNPM         := pnpm

# ---- Eval parameters (override via CLI, e.g. make eval K=30 TOP_K=8) -------
K            ?= 20
TOP_K        ?= 4
LIMIT        ?=
TYPE         ?=
DIFFICULTY   ?=
ABSTAIN      ?= 0.78
DATASET      ?=
SAVE         ?=

# =============================================================================
# Default target
# =============================================================================
.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help message
	@echo ""
	@echo "RAG Agent — available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Override variables on the command line, e.g.:"
	@echo "  make eval K=30 TOP_K=8"
	@echo "  make eval-gen LIMIT=5 SAVE=my-baseline.json"
	@echo ""

# =============================================================================
# Setup
# =============================================================================
.PHONY: install
install: ## Install dependencies
	$(PNPM) install

.PHONY: env
env: ## Copy .env.example to .env (if .env does not exist)
	@test -f .env && echo ".env already exists, skipping" || cp .env.example .env

# =============================================================================
# Infrastructure (Qdrant)
# =============================================================================
.PHONY: infra-up
infra-up: ## Start Qdrant vector DB via Docker Compose
	$(COMPOSE) up -d
	@echo "Qdrant is running at http://localhost:6333"

.PHONY: infra-down
infra-down: ## Stop Qdrant and remove containers
	$(COMPOSE) down

.PHONY: infra-logs
infra-logs: ## Tail Qdrant logs
	$(COMPOSE) logs -f qdrant

# =============================================================================
# Indexing
# =============================================================================
.PHONY: index
index: ## Build / rebuild the vector index from documentation
	$(PNPM) run index

# =============================================================================
# Run
# =============================================================================
.PHONY: start
start: ## Start the RAG agent (interactive Q&A)
	$(PNPM) start

# =============================================================================
# Retrieval Evaluation
# =============================================================================
EVAL_FLAGS := --k $(K) --top-k $(TOP_K) --abstention-threshold $(ABSTAIN)
ifdef TYPE
	EVAL_FLAGS += --type $(TYPE)
endif
ifdef DIFFICULTY
	EVAL_FLAGS += --difficulty $(DIFFICULTY)
endif
ifdef DATASET
	EVAL_FLAGS += --dataset $(DATASET)
endif

.PHONY: eval
eval: ## Run retrieval evaluation (text report). Vars: K TOP_K TYPE DIFFICULTY ABSTAIN DATASET
	$(PNPM) run eval -- $(EVAL_FLAGS)

.PHONY: eval-json
eval-json: ## Run retrieval evaluation (JSON output)
	$(PNPM) run eval:json -- $(EVAL_FLAGS)

.PHONY: eval-rebuild
eval-rebuild: ## Run retrieval evaluation with forced vector index rebuild
	$(PNPM) run eval:rebuild -- $(EVAL_FLAGS)

# =============================================================================
# Generation Evaluation
# =============================================================================
GEN_FLAGS := --k $(K) --top-k $(TOP_K) --abstention-threshold $(ABSTAIN)
ifdef TYPE
	GEN_FLAGS += --type $(TYPE)
endif
ifdef DIFFICULTY
	GEN_FLAGS += --difficulty $(DIFFICULTY)
endif
ifdef DATASET
	GEN_FLAGS += --dataset $(DATASET)
endif
ifdef LIMIT
	GEN_FLAGS += --limit $(LIMIT)
endif
ifdef SAVE
	GEN_FLAGS += --save $(SAVE)
endif

.PHONY: eval-gen
eval-gen: ## Run generation evaluation (faithfulness + relevance). Vars: K TOP_K LIMIT SAVE TYPE DIFFICULTY
	$(PNPM) run eval:gen -- $(GEN_FLAGS)

.PHONY: eval-gen-json
eval-gen-json: ## Run generation evaluation (JSON output)
	$(PNPM) run eval:gen:json -- $(GEN_FLAGS)

# =============================================================================
# Quality
# =============================================================================
.PHONY: typecheck
typecheck: ## Run TypeScript type check
	$(PNPM) run typecheck

.PHONY: check
check: typecheck ## Run all checks (alias: typecheck)

# =============================================================================
# Clean
# =============================================================================
.PHONY: clean
clean: ## Remove build artifacts and local data
	rm -rf dist/ node_modules/.cache/
	@echo "Cleaned build artifacts"

.PHONY: clean-all
clean-all: infra-down clean ## Stop infrastructure and remove all generated files
	rm -rf node_modules/
	$(COMPOSE) down -v
	@echo "Full clean complete (node_modules removed, Docker volumes pruned)"
