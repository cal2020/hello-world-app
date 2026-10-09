# AI Cost Inspector: common tasks. Run `make help` for the list.

BACKEND := backend
FRONTEND := frontend
UV := uv run --frozen

.PHONY: help setup build start dev dev-api dev-web test lint e2e check browser browser-serve browser-e2e seed-demo reset-demo reset clean

help: ## List the targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  %-12s %s\n", $$1, $$2}'

setup: ## Install pinned backend (uv) and frontend (npm) dependencies
	cd $(BACKEND) && uv sync --frozen
	cd $(FRONTEND) && npm ci

build: ## Build the frontend into frontend/dist (served by `make start`)
	cd $(FRONTEND) && npm run build

start: ## Serve the app and API on http://127.0.0.1:8765
	cd $(BACKEND) && $(UV) cost-inspector serve

dev: ## API with auto-reload on :8765 plus the Vite dev server on http://127.0.0.1:5173
	$(MAKE) -j2 dev-api dev-web

dev-api:
	cd $(BACKEND) && $(UV) cost-inspector serve --reload

dev-web:
	cd $(FRONTEND) && npm run dev

test: ## Backend (pytest) and frontend (Vitest) tests
	cd $(BACKEND) && $(UV) pytest -q
	cd $(FRONTEND) && npm test

lint: ## Ruff, mypy, TypeScript and ESLint
	cd $(BACKEND) && $(UV) ruff check . ../browser && $(UV) ruff format --check . ../browser && $(UV) mypy
	cd $(FRONTEND) && npm run typecheck && npm run lint

e2e: ## Build, then run the Playwright end-to-end suite on a throwaway database
	cd $(FRONTEND) && npm run e2e

check: lint test e2e ## Everything CI would run

browser: ## Build the in-browser version (static site) into browser/dist/ai-cost-inspector
	cd $(BACKEND) && $(UV) python ../browser/build.py

browser-serve: ## Serve the in-browser build on http://127.0.0.1:8790/ai-cost-inspector/
	python3 -m http.server 8790 --bind 127.0.0.1 --directory browser/dist

browser-e2e: ## Run the end-to-end suite against the in-browser build
	cd $(FRONTEND) && npx playwright test -c playwright.browser.config.ts

seed-demo: ## Add the synthetic demo imports (idempotent)
	cd $(BACKEND) && $(UV) cost-inspector seed-demo

reset-demo: ## Remove the demo imports and their comparisons, then seed them again
	cd $(BACKEND) && $(UV) cost-inspector reset-demo

reset: ## Delete every import and comparison (needs CONFIRM=yes)
ifeq ($(CONFIRM),yes)
	cd $(BACKEND) && $(UV) cost-inspector reset --yes
else
	@echo "This deletes every import and comparison in the local database."
	@echo "To confirm, run: make reset CONFIRM=yes"
	@exit 2
endif

clean: ## Remove build output and test artifacts (keeps your data)
	rm -rf $(FRONTEND)/dist $(FRONTEND)/test-results $(FRONTEND)/playwright-report $(FRONTEND)/e2e/.tmp browser/dist
