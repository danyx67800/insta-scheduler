# GD Insta Scheduler

Programma e pubblica automaticamente post su Instagram dal tuo Umbrel. Backend **Node.js + Express**, scheduler **cron ogni minuto**, **SQLite** per post/log/token, frontend web responsive, pubblicazione via **Instagram Graph API** ufficiale.

Questa repo contiene il **codice dell'app + Dockerfile**. I file per lo store Umbrel (`umbrel-app.yml`, `docker-compose.yml`) stanno qui:
**[Gigiomiccio425/Gigio-dany-appstore — `g-d-app-store-gd-insta-scheduler/`](https://github.com/Gigiomiccio425/Gigio-dany-appstore/tree/master/g-d-app-store-gd-insta-scheduler)**

Immagine pubblicata: `ghcr.io/danyx67800/insta-scheduler:1.0.0` (multi-arch `linux/amd64` + `linux/arm64`, build automatica via GitHub Actions).

## Avvio rapido (locale)

```bash
npm install
cp .env.example .env   # imposta PUBLIC_URL
npm start              # http://localhost:8757
```

## Docker

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/danyx67800/insta-scheduler:1.0.0 .
```

La build/release ufficiale gira su GitHub Actions (`.github/workflows/docker-publish.yml`): a ogni push su `main` pubblica `:1.0.0` + `:latest` su GHCR.

I dati stanno in `/data` (su Umbrel: volume `${APP_DATA_DIR}/data`):
- `scheduler.db` — post (`bozza`/`programmato`/`pubblicato`/`errore`), settings, log
- `uploads/` — media caricati, serviti su `/uploads/*`

## Instagram Graph API

1. Account **Business/Creator** collegato a una Pagina Facebook.
2. App su [Meta for Developers](https://developers.facebook.com) con prodotto Instagram + permesso `instagram_content_publish`.
3. Genera token long-lived (~60 giorni), ricavane **IG User ID** (`GET /me/accounts?fields=instagram_business_account`).
4. Nella UI dell'app (tab Account): incolla IG User ID + token + `PUBLIC_URL`, poi **Testa connessione**.
5. `PUBLIC_URL` deve essere raggiungibile da Meta (dominio/Tailscale/LAN) perché i media vengono scaricati da lì.

Il rinnovo automatico del token è tentato una volta al giorno (ore 03:00) se `app_secret` è impostato; altrimenti rinnova manualmente.

## API

- `GET /api/health` · `GET/POST /api/settings` · `POST /api/connect/test`
- `GET /api/posts[?status=]` · `POST /api/posts` (multipart `files[]`) · `GET/PATCH/DELETE /api/posts/:id`
- `POST /api/posts/:id/publish-now` · `POST /api/posts/:id/retry` · `GET /api/logs?limit=`

## Installazione su Umbrel

Aggiungi il community store `https://github.com/Gigiomiccio425/Gigio-dany-appstore` e installa **GD Insta Scheduler**.
