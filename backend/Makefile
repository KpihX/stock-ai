.DEFAULT_GOAL := help
SHELL := /bin/zsh

PKG_NAME      := stockline-ai
PKG_DIR_NAME  := stockline_ai
PKG_DIR       := src/$(PKG_DIR_NAME)
VERSION       := $(shell grep -m 1 '^version' pyproject.toml | tr -s ' ' | cut -d'"' -f2)

UV      := $(shell command -v uv 2>/dev/null || echo uv)
PYTHON  := $(UV) run python
PY_FILES := $(shell $(UV) run python -c 'from pathlib import Path; print(" ".join(map(str, Path("$(PKG_DIR)").rglob("*.py"))))')

.PHONY: help sync check smoke demo build uv-link uv-uninstall uv-publish push status

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

sync:  ## Sync the base environment and the dev tools
	@$(UV) sync
	@echo "OK base env ready"

check: smoke  ## Format check, lint, type check and tests
	@$(UV) run ruff format --check $(PKG_DIR) tests
	@$(UV) run ruff check $(PKG_DIR) tests
	@$(PYTHON) -m py_compile $(PY_FILES)
	@$(UV) run pyright $(PKG_DIR)
	@$(UV) run pytest -q
	@echo "OK make check passed"

smoke:  ## Import the package and run the CLI version command
	@$(PYTHON) -c "import $(PKG_DIR_NAME)"
	@$(PYTHON) -m $(PKG_DIR_NAME).cli version
	@echo "OK smoke test passed"

demo:  ## Reserved target for the end to end voice order demo
	@echo "Demo target reserved for the hackathon pipeline"

build:  ## Wipe dist then build the sdist and the wheel
	@rm -rf dist
	@$(UV) build
	@echo "OK build complete in dist/"

uv-link:  ## Editable install so the CLI always uses the current checkout
	@$(UV) tool install --editable . --force
	@echo "OK $(PKG_NAME) linked"

uv-uninstall:  ## Remove the editable install
	@$(UV) tool uninstall $(PKG_NAME) 2>/dev/null || true
	@echo "OK $(PKG_NAME) uninstalled"

uv-publish: build  ## Publish to PyPI, requires UV_PUBLISH_TOKEN in the environment
	@$(UV) publish
	@echo "OK published"

push:  ## Push the current branch to GitLab first, then GitHub
	@branch="$$(git branch --show-current)"; \
	for remote in gitlab github; do \
		if git remote get-url "$$remote" >/dev/null 2>&1; then \
			echo "==> pushing $$branch to $$remote"; \
			git push "$$remote" "$$branch"; \
		fi; \
	done

status:  ## Short git status
	@git status --short
