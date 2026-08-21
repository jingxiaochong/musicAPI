# Personal deployment

This directory (`musicAPI`) contains the community-maintained NeteaseCloudMusicApi Enhanced
service. It is intended for private, single-user use. It does not provide an
official NetEase API or guarantee that upstream endpoints remain stable.

The sibling `musicWEB` directory contains the public web player source. It is
built and deployed separately. The private deployment repository owns the
server-specific domain, TLS certificate, static-file path, and reverse-proxy
configuration.

## PM2

The backend can also be run under PM2. Logs are written to the ignored
`musicAPI/log/` directory.

```bash
npm install -g pm2
npm run pm2:start
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

The PM2 process is named `musicAPI`. The default binding is `127.0.0.1:4397`, which is suitable when the web
server or reverse proxy runs on the same machine.

When the web player uses a separate domain, set `CORS_ALLOW_ORIGIN` in the
private `.env` to the exact player origin and keep the `/api/` prefix in browser
requests. The private Nginx configuration removes that prefix before proxying
to the API process.

## Local smoke test

```bash
cp .env.example .env
docker compose up -d --build ncm_api
curl -fsS http://localhost:4397/
```

The container binds to `127.0.0.1` by default. On a private server, expose it
through an existing HTTPS reverse proxy, VPN, or tunnel with authentication;
do not publish port 4397 directly to the Internet.

## Login

Open the service's `/qrlogin.html` page through the authenticated HTTPS URL and
use QR login. The resulting session is handled by the client/server flow. Do
not send or store the account password in `.env`, shell history, Docker labels,
or a public request URL.

## Updating

```bash
git pull --ff-only
docker compose up -d --build ncm_api
docker compose logs --tail=100 ncm_api
```

Only use the service with an account and content you are authorized to access.
