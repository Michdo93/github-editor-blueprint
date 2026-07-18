# GitHub Repo Editor – Blaupause

Frontend (GitHub Pages) + Backend (Cloudflare Worker) + Realtime (Supabase).
Login/Signup läuft komplett über GitHub OAuth. Jeder Nutzer sieht nur seine eigenen Repos,
weil sein eigenes GitHub-Token benutzt wird – keine eigene Nutzerverwaltung nötig.

## Architektur

```
Browser (GitHub Pages, statisch)
   │  1. Login-Redirect zu GitHub OAuth
   │  2. Alle GitHub-API-Calls (Contents API, Git Data API, Repos API)
   │     laufen DIREKT aus dem Browser mit dem Nutzer-Token
   │
   ▼
Cloudflare Worker (kostenlos, kein eigener Server)
   │  a) POST /oauth/token   -> tauscht code+client_secret gegen Access-Token
   │  b) POST /webhook       -> nimmt GitHub push-Events entgegen (HMAC-geprüft)
   │
   ▼
Supabase (Free Tier)
   - Tabelle repo_events: worker schreibt "Repo X hat neuen Commit Y"
   - Realtime: Browser abonniert Änderungen für die Repos, die er offen hat
   - Kein eigener WebSocket-Server nötig
```

Der Worker ist der EINZIGE Ort, an dem `client_secret` existiert. Alles andere braucht
keinen Server, weil GitHub selbst die Zugriffskontrolle übernimmt (Nutzer-Token = Nutzer-Rechte).

## Setup

### 1. GitHub OAuth App anlegen
GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
- Homepage URL: `https://<dein-username>.github.io/<repo>`
- Authorization callback URL: `https://<dein-username>.github.io/<repo>/` (Redirect zurück ins Frontend)
- Scope, den du beim Login anforderst: `repo` (Contents API, Git Data API, Repo erstellen, Webhooks anlegen)

Merke dir `Client ID` und `Client Secret`.

> Hinweis: Für den Start ist eine klassische OAuth App am unkompliziertesten, weil
> `POST /user/repos` (neues Repo anlegen) und Webhook-Erstellung damit ohne Sonderfälle
> funktionieren. Eine GitHub App (feingranularere Rechte, Installation pro Repo) ist der
> nächste Ausbaustufen-Schritt, sobald die Blaupause für weitere Apps wiederverwendet wird.

### 2. Cloudflare Worker deployen
```bash
cd worker
npm install
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# GITHUB_CLIENT_ID, SUPABASE_URL als normale vars in wrangler.toml eintragen
npx wrangler deploy
```
Du bekommst eine URL wie `https://github-editor-worker.<du>.workers.dev`.

### 3. Supabase Projekt anlegen
- Neues Projekt auf supabase.com
- SQL aus `supabase/schema.sql` im SQL Editor ausführen
- Realtime für Tabelle `repo_events` aktivieren (Database → Replication)
- `Project URL` und `anon public key` notieren (fürs Frontend), `service_role key` (fürs Worker-Secret)

### 4. Frontend konfigurieren
In `frontend/app.js` ganz oben die Konstanten eintragen:
- `GITHUB_CLIENT_ID`
- `WORKER_URL`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`

Dann `frontend/` Inhalt in dein GitHub-Pages-Repo pushen (oder als `docs/`-Ordner /
GitHub Actions Pages-Deploy einrichten).

## Ablauf im Detail

1. **Login**: Redirect zu `github.com/login/oauth/authorize?scope=repo&client_id=...`
   → GitHub schickt `?code=...` zurück ans Frontend → Frontend ruft Worker `/oauth/token`
   → Worker tauscht das gegen Access-Token → Frontend speichert Token in `localStorage`.
2. **Projekt anlegen**: Frontend ruft `POST /user/repos` (mit Nutzer-Token) → legt danach
   automatisch einen Webhook auf dem neuen Repo an (`POST /repos/{owner}/{repo}/hooks`),
   Ziel-URL = Worker `/webhook`.
3. **Projekt importieren**: Frontend listet `GET /user/repos`, Nutzer wählt eins aus,
   Frontend prüft/legt Webhook nach demselben Muster an.
4. **Datei speichern (Editor)**: Contents API (`PUT /repos/{owner}/{repo}/contents/{path}`).
5. **Datei umbenennen/verschieben, Ordner löschen, Bulk-Upload**: Git Data API
   (Blob → Tree → Commit → Ref-Update) — ein atomarer Commit für mehrere Änderungen.
6. **Fremdänderung in GitHub selbst**: GitHub schickt `push`-Webhook an den Worker →
   Worker schreibt Zeile in Supabase `repo_events` → alle Browser-Clients, die dieses
   Repo offen haben, bekommen die Änderung per Supabase Realtime sofort mitgeteilt →
   Frontend lädt den betroffenen Teilbaum per Git Trees API neu.

## Sicherheitshinweis für die Demo
Der Access-Token liegt im Frontend in `localStorage` (kein eigener Server, der Sessions
hält). Für eine Demo/Blaupause ist das akzeptabel; für produktiven Einsatz würde man auf
eine GitHub App mit kurzlebigen, installationsgebundenen Tokens migrieren.
