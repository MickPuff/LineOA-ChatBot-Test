# LINE OA Gemini Chatbot

A small Node.js webhook service that connects a LINE Official Account to Gemini. It replies to LINE text messages like a chat assistant, stores conversation logs per LINE user, group, or room, and sends only recent context to Gemini.

## What It Does

- Receives LINE Messaging API webhooks at `POST /webhook`
- Validates LINE signatures with the official LINE Node SDK
- Sends recent conversation context plus the latest message to Gemini
- Stores full conversation logs in remote Upstash Redis
- Supports `/reset`, `/clear`, `reset`, or `clear` to forget one conversation

## Setup

### Cloud Hosting, No Local Runtime

Use this path if you do not want the bot running on your machine.

1. Push this folder to a GitHub repository.

2. In Render, create a new Blueprint from the repository. The included `render.yaml` tells Render how to build and run the service.

3. Add these environment variables in Render:

   ```text
   LINE_CHANNEL_ACCESS_TOKEN
   LINE_CHANNEL_SECRET
   GEMINI_API_KEY
   UPSTASH_REDIS_REST_URL
   UPSTASH_REDIS_REST_TOKEN
   ```

4. After Render deploys, copy your service URL and set the LINE webhook URL to:

   ```text
   https://your-render-service.onrender.com/webhook
   ```

5. Enable webhooks in the LINE Developers Console.

### Local Development

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Fill in `.env`:

   ```ini
   LINE_CHANNEL_ACCESS_TOKEN=...
   LINE_CHANNEL_SECRET=...
   GEMINI_API_KEY=...
   STORAGE_PROVIDER=upstash
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   ```

4. Create an Upstash Redis database, then copy the REST URL and REST token into `.env`.

5. Start the server:

   ```powershell
   npm.cmd run dev
   ```

6. Expose it with HTTPS for LINE, for example with ngrok:

   ```powershell
   ngrok http 3000
   ```

7. In the LINE Developers Console, set the Messaging API webhook URL to:

   ```text
   https://your-ngrok-domain.ngrok-free.app/webhook
   ```

8. Enable webhooks for the LINE channel, then send a text message to the LINE Official Account.

## Environment

| Name | Required | Default | Notes |
| --- | --- | --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | | Messaging API channel access token |
| `LINE_CHANNEL_SECRET` | Yes | | Messaging API channel secret |
| `GEMINI_API_KEY` | Yes | | Gemini API key from Google AI Studio |
| `PORT` | No | `3000` | Local HTTP port |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model ID |
| `MAX_CONTEXT_MESSAGES` | No | value of `MAX_HISTORY_MESSAGES` or `24` | Recent stored messages sent to Gemini as context |
| `MAX_HISTORY_MESSAGES` | No | `24` | Backward-compatible alias for `MAX_CONTEXT_MESSAGES` |
| `STORAGE_PROVIDER` | No | `upstash` | Use `upstash` for remote persistence or `memory` for temporary local testing |
| `UPSTASH_REDIS_REST_URL` | Yes for Upstash | | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Yes for Upstash | | Upstash Redis REST token |
| `BOT_SYSTEM_INSTRUCTION` | No | Friendly concise LINE assistant | Bot personality/system prompt |

## Test

```powershell
npm.cmd test
```

## Notes

LINE requires an HTTPS webhook URL. Local development usually needs a tunnel such as ngrok, Cloudflare Tunnel, or deployment to a host with HTTPS.

If you set `STORAGE_PROVIDER=memory`, nothing is written locally, but the bot forgets context whenever the Node process restarts. Use Upstash for persistent non-local memory.
