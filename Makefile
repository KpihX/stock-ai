.DEFAULT_GOAL := help
SHELL := /bin/zsh

DC := env PATH=/usr/bin:/usr/local/bin:/usr/libexec/docker/cli-plugins docker compose

.PHONY: help init up down logs ps check

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

init:  ## Create .env from template and generate missing secrets
	@test -f .env || cp .env.example .env
	@if ! grep -q '^JWT_SECRET=.\+' .env; then \
	  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$$(openssl rand -base64 48)|" .env; \
	fi
	@if ! grep -q '^POSTGRES_PASSWORD=.\+' .env; then \
	  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$$(openssl rand -base64 48)|" .env; \
	fi
	@if ! grep -q '^STOCKLINE_ADMIN_PASSWORD=.\+' .env; then \
	  sed -i "s|^STOCKLINE_ADMIN_PASSWORD=.*|STOCKLINE_ADMIN_PASSWORD=$$(openssl rand -base64 48)|" .env; \
	fi
	@echo "OK .env ready (secrets generated locally)"

up:  ## Build and start the local stack
	@$(DC) up -d --build

down:  ## Stop the local stack
	@$(DC) down

logs:  ## Follow API logs
	@$(DC) logs -f api

ps:  ## Show stack status
	@$(DC) ps

check:  ## Run backend checks
	@cd backend && make check
