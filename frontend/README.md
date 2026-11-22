# Stockline frontend

Minimal Vite + React + TypeScript dashboard for the Stockline manager. It talks to the FastAPI backend over HTTP, streams new commands with SSE, and opens a WebSocket for live calls.

## Run locally

Requires Node 20.19 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

The dev server prints its URL. The default API base is `http://localhost:8000`.

To build and preview the production bundle:

```bash
npm run build
npm run preview
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Base URL of the FastAPI backend |

Set it to the Tailscale address of the PC running the backend when working remotely, for example `http://100.x.y.z:8000`.

## Deploy to Vercel

```bash
vercel --prod
```

`vercel.json` sets the Vite framework and rewrites all paths to `index.html` so client-side navigation works. Set `VITE_API_BASE_URL` in the Vercel project settings before deploying if the backend is not on localhost.
