# Reframe

Reference-led image edits: upload an original image plus an edited reference, select the details that must remain unchanged, and receive a finished edit without writing a prompt.

## Run locally

1. Copy `.env.example` to `.env.local` and add your keys:
   - `FAL_KEY` for Fal's `openrouter/router/vision` Gemini reference analysis.
   - Set `APP_URL=http://localhost:3000` locally, then your deployed URL in production.
2. Install dependencies with `npm install`.
3. Run `npm run dev`.

All keys are accessed only by `app/api/edit/route.ts`; do not use `NEXT_PUBLIC_` prefixes for them.

## Pipeline

The browser sends the original, reference, and selected preservation constraints to the `/api/edit` server route. Gemini runs through Fal's `openrouter/router/vision` endpoint, compares the two images, and returns a constrained editing instruction. That instruction and only the original image are sent to Fal's `fal-ai/gpt-image-1.5/edit` endpoint. The route does not write uploaded images or output images to disk or a database. The edit request uses Fal's `sync_mode`, so the generated output is returned as a data URI and is not stored in request history.

## Security and deployment

- Files are restricted to JPG, PNG, and WEBP and a 10 MB limit on both client and server.
- Responses are marked `no-store`; images are never persisted by the app.
- Baseline security headers are configured in `next.config.mjs`.
- For public production traffic, put the endpoint behind platform rate limiting / WAF (for example Vercel Firewall or Cloudflare) to protect usage-based API keys. This needs a deployment-level service because a stateless app cannot safely rate-limit across instances.

> Note: Every inference call is made through Fal using just `FAL_KEY`: `openrouter/router/vision` for analysis and `fal-ai/gpt-image-1.5/edit` for the final edit.
