import { GitHubClient } from "./github-api.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// -----------------------------------------------------------------------
// Konfiguration -- hier deine eigenen Werte eintragen
// -----------------------------------------------------------------------
const GITHUB_CLIENT_ID = "DEINE_GITHUB_CLIENT_ID";
const WORKER_URL = "https://github-editor-worker.DEIN-SUBDOMAIN.workers.dev";
const SUPABASE_URL = "https://DEINPROJEKT.supabase.co";
const SUPABASE_ANON_KEY = "DEIN_SUPABASE_ANON_KEY";
const REDIRECT_URI = window.location.origin + window.location.pathname;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let github = null; // GitHubClient-Instanz nach Login
let currentUser = null;
let currentProject = null; // { owner, repo, branch }
let realtimeChannel = null;

// -----------------------------------------------------------------------
// 1. Login / Signup über GitHub OAuth
// -----------------------------------------------------------------------

function redirectToGitHubLogin() {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "repo"); // Repos lesen/schreiben, Webhooks anlegen
  url.searchParams.set("state", crypto.randomUUID());
  window.location.href = url.toString();
}

async function handleOAuthRedirectIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return false;

  // code aus der URL entfernen, damit er nicht erneut verwendet wird
  window.history.replaceState({}, document.title, REDIRECT_URI);

  const resp = await fetch(`${WORKER_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await resp.json();
  if (data.error || !data.access_token) {
    console.error("OAuth Fehler:", data);
    return false;
  }

  localStorage.setItem("gh_token", data.access_token);
  return true;
}

async function tryRestoreSession() {
  const token = localStorage.getItem("gh_token");
  if (!token) return false;
  github = new GitHubClient(token);
  try {
    currentUser = await github.getUser();
    return true;
  } catch {
    localStorage.removeItem("gh_token");
    github = null;
    return false;
  }
}

function logout() {
  localStorage.removeItem("gh_token");
  github = null;
  currentUser = null;
  location.reload();
}

// -----------------------------------------------------------------------
// 2. Projekte: anlegen / importieren
// -----------------------------------------------------------------------

async function registerWebhookViaWorker(owner, repo) {
  const token = localStorage.getItem("gh_token");
  const resp = await fetch(`${WORKER_URL}/create-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ owner, repo }),
  });
  const data = await resp.json();
  if (data.error) {
    console.error("Webhook-Erstellung fehlgeschlagen:", data.error);
    throw new Error(data.error);
  }
  return data;
}

async function createNewProject(name) {
  const repo = await github.createRepo(name, { private: true });
  await registerWebhookViaWorker(repo.owner.login, repo.name);
  return { owner: repo.owner.login, repo: repo.name, branch: repo.default_branch };
}

async function importExistingProject(owner, repoName) {
  await registerWebhookViaWorker(owner, repoName);
  const branch = await github.getDefaultBranch(owner, repoName);
  return { owner, repo: repoName, branch };
}

async function listMyRepos() {
  return github.listRepos();
}

// -----------------------------------------------------------------------
// 3. Editor-Aktionen (nutzen github-api.js)
// -----------------------------------------------------------------------

async function openProject(project) {
  currentProject = project;
  subscribeToRealtimeUpdates(project);
  return refreshFileTree();
}

async function refreshFileTree() {
  const { owner, repo, branch } = currentProject;
  const tree = await github.getTree(owner, repo, branch);
  return tree.tree.filter((entry) => entry.type === "blob"); // nur Dateien, keine Ordner-Knoten
}

async function openFile(path) {
  const { owner, repo, branch } = currentProject;
  return github.getFileContent(owner, repo, path, branch);
}

async function saveFile(path, content, existingSha) {
  const { owner, repo, branch } = currentProject;
  return github.saveFile(owner, repo, path, content, {
    sha: existingSha,
    branch,
    message: `Edit ${path}`,
  });
}

async function renameOrMoveFile(oldPath, newPath, content) {
  const { owner, repo, branch } = currentProject;
  return github.moveFile(owner, repo, branch, oldPath, newPath, content);
}

async function deleteFilesOrFolder(paths) {
  const { owner, repo, branch } = currentProject;
  return github.deleteMultiple(owner, repo, branch, paths);
}

async function uploadFiles(fileList) {
  // fileList: Array von { path, content } -- Inhalte vorher im Frontend aus <input type="file"> auslesen
  const { owner, repo, branch } = currentProject;
  return github.uploadMultiple(owner, repo, branch, fileList);
}

// -----------------------------------------------------------------------
// 4. Realtime: Änderungen, die direkt in GitHub gemacht wurden, live sehen
// -----------------------------------------------------------------------

function subscribeToRealtimeUpdates(project) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);

  const repoFullName = `${project.owner}/${project.repo}`;

  realtimeChannel = supabase
    .channel(`repo:${repoFullName}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "repo_events",
        filter: `repo_full_name=eq.${repoFullName}`,
      },
      async (payload) => {
        // Jemand hat direkt auf GitHub gepusht -> Baum neu laden und UI-Event feuern
        const files = await refreshFileTree();
        window.dispatchEvent(
          new CustomEvent("repo-updated", { detail: { files, event: payload.new } })
        );
      }
    )
    .subscribe();
}

// -----------------------------------------------------------------------
// Exporte für die UI (siehe index.html)
// -----------------------------------------------------------------------
window.App = {
  redirectToGitHubLogin,
  handleOAuthRedirectIfPresent,
  tryRestoreSession,
  logout,
  createNewProject,
  importExistingProject,
  listMyRepos,
  openProject,
  refreshFileTree,
  openFile,
  saveFile,
  renameOrMoveFile,
  deleteFilesOrFolder,
  uploadFiles,
  getCurrentUser: () => currentUser,
};
