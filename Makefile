.DEFAULT_GOAL := help

test: ## Run tests
	npx vitest run --reporter verbose

test-watch: ## Run tests in watch mode
	npx vitest

up: ## Start infra (redis, postgres)
	docker compose up -d

down: ## Stop infra
	docker compose down

down-volumes: ## Stop infra and remove volumes
	docker compose down -v

logs: ## Tail infra logs
	docker compose logs -f

devtools: ## Start devtools demo server
	node src/devtools/demo/server.js

devtools-ui: ## Start devtools vite dev server
	cd src/devtools/client && npx vite

devtools-build: ## Build devtools client
	cd src/devtools/client && npx vite build

clean: ## Remove all node_modules
	rm -rf node_modules src/devtools/client/node_modules

install: ## Install dependencies
	npm install

.PHONY: help
help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[32m%-20s\033[0m %s\n", $$1, $$2}'
