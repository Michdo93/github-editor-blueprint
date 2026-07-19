-- Tabelle für Push-Events aus GitHub-Webhooks.
-- Enthält bewusst keine sensiblen Daten, nur "was hat sich geändert" als Pointer.
-- Der Client holt die eigentlichen Inhalte danach selbst per GitHub API (mit eigenem Token).

create table if not exists repo_events (
  id bigint generated always as identity primary key,
  repo_full_name text not null,        -- z.B. "Michdo93/mein-projekt"
  commit_sha text not null,
  pusher text,
  changed_files jsonb,                 -- { added: [], removed: [], modified: [] }
  created_at timestamptz not null default now()
);

create index if not exists idx_repo_events_repo on repo_events (repo_full_name, created_at desc);

-- Realtime aktivieren (zusätzlich auch im Dashboard unter Database > Replication nötig)
alter publication supabase_realtime add table repo_events;

-- Row Level Security: Tabelle enthält keine geheimen Daten (nur Repo-Name + Commit-SHA),
-- daher reicht Lesezugriff für den anon key. Schreiben darf nur der Worker (service_role key).
alter table repo_events enable row level security;

create policy "Anyone can read repo events"
  on repo_events for select
  using (true);

-- Kein Insert/Update/Delete-Policy für anon -> nur service_role (Worker) kann schreiben,
-- da service_role RLS ohnehin umgeht.

-- ---------------------------------------------------------------------------
-- "Meine Projekte" -- welche Repos wurden über den Editor angelegt/importiert.
-- Damit die Projekt-Liste nur diese zeigt, statt aller Repos des Nutzers.
-- ---------------------------------------------------------------------------
create table if not exists user_projects (
  id bigint generated always as identity primary key,
  github_login text not null,
  owner text not null,
  repo text not null,
  full_name text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_projects_login on user_projects (github_login);

alter table user_projects enable row level security;

-- Hinweis (Demo-Kompromiss): Da der Nutzer sich rein über GitHub OAuth authentifiziert und
-- Supabase selbst keine GitHub-Identität kennt, kann RLS hier nicht wirklich nach "ist das
-- wirklich dieser Nutzer" prüfen -- genau wie bei repo_events. Für eine Demo/Blaupause ok
-- (die Tabelle enthält nur Owner/Repo-Namen, keine Secrets); für Produktivbetrieb würde man
-- Supabase Auth mit einem eigenen JWT pro GitHub-Nutzer koppeln und RLS darauf aufbauen.
create policy "Anyone can read user_projects"
  on user_projects for select
  using (true);

create policy "Anyone can insert user_projects"
  on user_projects for insert
  with check (true);

create policy "Anyone can update user_projects"
  on user_projects for update
  using (true);

create policy "Anyone can delete user_projects"
  on user_projects for delete
  using (true);
