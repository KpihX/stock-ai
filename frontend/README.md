# Stock AI frontend

React + TypeScript + Vite dashboard for Stock AI. It connects to the FastAPI backend over HTTPS REST, streams real-time pipeline events over SSE, and handles live inbound WhatsApp VoIP calls via WebRTC (48 kHz Opus) and WebSocket.

## Dependencies

- React 19 (`react`, `react-dom`)
- Vite 7 (`vite`, `@vitejs/plugin-react`)
- TypeScript 5.8 (`typescript`, `@types/react`, `@types/react-dom`)

## Run locally

Requires Node 20.19 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

The dev server prints its URL (`http://localhost:5173`). The default API base is `http://localhost:8000`.

To typecheck and build the production bundle:

```bash
npm run build
npm run preview
```

## Environment

| Variable | Local Default | Production Value | Purpose |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | `https://stock-api.kpihx-labs.com` | Base URL of the FastAPI backend (`http`/`ws` locally, `https`/`wss` in prod) |

## Deploy to Vercel

Production URL: `https://stock-ai.kpihx-labs.com`

```bash
vercel --prod
```

`vercel.json` sets the Vite framework and rewrites all paths to `index.html` so client-side navigation works. Make sure `VITE_API_BASE_URL` is configured for the `production` environment in Vercel before running `vercel --prod`.
