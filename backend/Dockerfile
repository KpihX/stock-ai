FROM node:22-alpine AS wa-builder
WORKDIR /wa
COPY wa/package.json wa/tsconfig.json ./
COPY wa/src ./src
RUN npm install --ignore-scripts && npx tsc --noEmit

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS py-builder
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY config.jsonc ./config.jsonc
RUN uv sync --frozen --no-dev

FROM python:3.14-slim-bookworm AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng libpq5 nodejs \
 && rm -rf /var/lib/apt/lists/*
COPY --from=py-builder /app/.venv /app/.venv
COPY --from=py-builder /app/config.jsonc /app/config.jsonc
COPY --from=py-builder /app/src /app/src
COPY --from=wa-builder /wa /app/wa
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
ENV STOCKLINE_WA_URL=http://localhost:3001
EXPOSE 8000
CMD ["sh", "-c", "cd /app/wa && node_modules/.bin/tsx src/index.ts & exec stockline-api"]
