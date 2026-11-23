FROM node:22-bookworm-slim AS wa-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /wa
COPY wa/package.json wa/tsconfig.json ./
COPY wa/scripts ./scripts
COPY wa/src ./src
RUN npm install && npx tsc

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS py-builder
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY config.jsonc ./config.jsonc
COPY README.md ./README.md
RUN uv sync --frozen --no-dev

FROM node:22-bookworm-slim AS wa-runtime
WORKDIR /app/wa
COPY --from=wa-builder /wa/node_modules ./node_modules
COPY --from=wa-builder /wa/dist ./dist
COPY --from=wa-builder /wa/package.json ./package.json

FROM python:3.14-slim-bookworm AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng libpq5 ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=py-builder /app/.venv /app/.venv
COPY --from=py-builder /app/config.jsonc /app/config.jsonc
COPY --from=py-builder /app/src /app/src
COPY --from=wa-runtime /app/wa /app/wa
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH" PYTHONUNBUFFERED=1
ENV STOCKLINE_WA_URL=http://localhost:3001
EXPOSE 8000
CMD ["sh", "-c", "(cd /app/wa && while true; do /usr/local/bin/node dist/index.js; rc=$?; echo \"[wa] listener exited code=$rc, restarting in 2s...\"; sleep 2; done) & exec stock-api"]
