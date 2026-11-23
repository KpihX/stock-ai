.DEFAULT_GOAL := help
SHELL := /bin/zsh

DC := env PATH=/usr/bin:/usr/local/bin:/usr/libexec/docker/cli-plugins docker compose
ROOT := $(shell pwd)

.PHONY: help init seed seed-random setup db db-logs backend frontend dev up down logs ps check deploy-frontend

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

init:  ## Create .env and generate missing local secrets
	@test -f .env || cp .env.example .env
	@test -f docker-compose.override.yml || cp docker-compose.override.example.yml docker-compose.override.yml
	@for key in JWT_SECRET POSTGRES_PASSWORD STOCKLINE_ADMIN_PASSWORD; do \
	  if ! grep -q "^$$key=" .env; then \
	    printf '%s=%s\n' "$$key" "$$(openssl rand -base64 48)" >> .env; \
	  elif ! grep -q "^$$key=.\+" .env; then \
	    sed -i "s|^$$key=.*|$$key=$$(openssl rand -base64 48)|" .env; \
	  fi; \
	done
	@echo "OK .env ready"
	@$(MAKE) seed

seed:  ## Ensure the stack is up and apply the deterministic seed
	@$(DC) up -d --build
	@echo "waiting for api health..."
	@until $(DC) exec -T api python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health")' >/dev/null 2>&1; do sleep 1; done
	@$(DC) exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -f /docker-entrypoint-initdb.d/init.sql'
	@echo "OK database seeded"

seed-random:  ## Fill the database with random clients, products and commands
	@cd backend && uv run python db/seed_random.py

setup: init  ## Install all local dependencies (uv + npm)
	@cd backend && uv sync
	@cd frontend && npm install
	@echo "OK dependencies installed"

db:  ## Start PostgreSQL only (needed by the local backend)
	@$(DC) up -d postgres
	@echo "OK postgres on localhost:5432"

db-logs:  ## Follow PostgreSQL logs
	@$(DC) logs -f postgres

backend:  ## Run the FastAPI backend locally with reload (port 8000)
	@cd backend && STOCKLINE_DATABASE_URL=postgresql://stockline:stockline@localhost:5432/stockline uv run uvicorn stockline_ai.api.main:app --reload --port 8000

frontend:  ## Run the Vite frontend locally with HMR (port 5173)
	@cd frontend && npm run dev

dev:  ## Run backend and frontend together in this terminal
	@trap 'kill 0' EXIT; \
	  (cd backend && STOCKLINE_DATABASE_URL=postgresql://stockline:stockline@localhost:5432/stockline uv run uvicorn stockline_ai.api.main:app --reload --port 8000) & \
	  (cd frontend && npm run dev) & \
	  wait

up:  ## Build and start the full Docker stack
	@$(DC) up -d --build

down:  ## Stop the full Docker stack
	@$(DC) down

logs:  ## Follow API logs
	@$(DC) logs -f api

ps:  ## Show Docker stack status
	@$(DC) ps

check:  ## Run backend checks
	@cd backend && make check

deploy-frontend:  ## Deploy the frontend to Vercel (requires vercel login)
	@cd frontend && vercel --prod

