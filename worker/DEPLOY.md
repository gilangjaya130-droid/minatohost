# MINATOHOST Worker deployment

The Vercel site is only the dashboard. The WhatsApp/Baileys worker must run as a
long-lived Node.js service; do not deploy this worker as a Vercel serverless
function.

## Required hosting features

Choose a Node.js or Docker host that provides:
- Node.js 20+ (or Docker support)
- A continuously running web process
- A persistent disk/volume mounted at `/data`
- HTTPS public URL
- Private environment variables/secrets

A free host that sleeps or deletes its filesystem can disconnect WhatsApp and
lose local session files. A successful build is not proof that WhatsApp is
connected.

## Deploy with Docker

1. Set the service's repository to this GitHub repository.
2. Set the Docker build context to `worker` and Dockerfile to
   `worker/Dockerfile` (or configure the host's equivalent).
3. Attach a persistent volume mounted at `/data`.
4. Add the environment variables below in the host dashboard.
5. Deploy, then open `https://YOUR-WORKER-DOMAIN/health`. It should return
   an OK response.
6. Put the worker's HTTPS base URL into `BOT_API_URL` in
   `public/config.js`, and configure the Supabase public anon key there.
7. Redeploy the Vercel frontend after editing its public config.

## Required environment variables

Use `.env.example` as a template:
- `SUPABASE_URL`: your Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: secret service-role key, entered only in the
  worker host's private environment settings. Never put it in frontend files,
  GitHub, screenshots, or chat.
- `SESSION_DIR`: set to `/data/sessions` when the persistent volume is
  mounted at `/data`.
- `CORS_ORIGIN`: your exact Vercel website origin, for example
  `https://your-site.vercel.app`.
- `PORT`: use the port required by the hosting provider, commonly 3000.

## Important

- Enable anonymous sign-ins in Supabase if the dashboard uses guest
  authentication.
- Apply the project's Supabase SQL/schema before testing the worker.
- The service-role key is private and must only exist in the worker's secret
  environment.
- A healthy `/health` response only confirms the HTTP process is alive. Test
  QR/pairing, reconnect, start/stop, and session persistence separately.
- WhatsApp may limit or log out automated linked devices. Follow WhatsApp's
  terms and applicable law.
