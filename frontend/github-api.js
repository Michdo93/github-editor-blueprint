/**
 * Dünner Wrapper um die GitHub REST API.
 * Läuft komplett im Browser mit dem Access-Token des eingeloggten Nutzers.
 * Contents API: einzelne Datei lesen/speichern (einfacher Fall, ein Commit pro Datei).
 * Git Data API: mehrere Änderungen (Move/Rename/Delete/Bulk-Upload) als EIN Commit.
 */

const API = "https://api.github.com";

export class GitHubClient {
  constructor(token) {
    this.token = token;
  }

  async _fetch(path, options = {}) {
    const resp = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub API ${resp.status}: ${text}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  // -- Nutzer & Repos --------------------------------------------------

  getUser() {
    return this._fetch("/user");
  }

  listRepos() {
    return this._fetch("/user/repos?per_page=100&sort=updated");
  }

  createRepo(name, { private: isPrivate = true, description = "" } = {}) {
    return this._fetch("/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: isPrivate, description, auto_init: true }),
    });
  }

  // Webhook auf einem Repo anlegen, damit der Worker "push"-Events bekommt
  async ensureWebhook(owner, repo, webhookUrl, webhookSecret) {
    const hooks = await this._fetch(`/repos/${owner}/${repo}/hooks`);
    const exists = hooks.some((h) => h.config?.url === webhookUrl);
    if (exists) return;

    return this._fetch(`/repos/${owner}/${repo}/hooks`, {
      method: "POST",
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["push"],
        config: {
          url: webhookUrl,
          content_type: "json",
          secret: webhookSecret,
        },
      }),
    });
  }

  // -- Dateibaum lesen (rekursiv, ein API-Call) -------------------------

  async getDefaultBranch(owner, repo) {
    const repoInfo = await this._fetch(`/repos/${owner}/${repo}`);
    return repoInfo.default_branch;
  }

  async getTree(owner, repo, branch) {
    const branchInfo = await this._fetch(`/repos/${owner}/${repo}/branches/${branch}`);
    const treeSha = branchInfo.commit.commit.tree.sha;
    return this._fetch(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  }

  // -- Contents API: einzelne Datei -------------------------------------

  async getFileContent(owner, repo, path, ref) {
    const data = await this._fetch(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`
    );
    const content = decodeURIComponent(escape(atob(data.content)));
    return { content, sha: data.sha };
  }

  async saveFile(owner, repo, path, content, { sha, branch, message } = {}) {
    return this._fetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: message || `Update ${path}`,
        content: btoa(unescape(encodeURIComponent(content))),
        sha, // vorhandene Datei -> sha der aktuellen Version mitgeben; neue Datei -> weglassen
        branch,
      }),
    });
  }

  async deleteFile(owner, repo, path, sha, branch, message) {
    return this._fetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      body: JSON.stringify({ message: message || `Delete ${path}`, sha, branch }),
    });
  }

  // -- Git Data API: mehrere Änderungen als EIN Commit -------------------
  //
  // changes = [
  //   { path: "neu/pfad.txt", content: "..." },           // Upload/Move-Ziel
  //   { path: "alter/pfad.txt", delete: true },            // Move-Quelle / echtes Löschen
  // ]
  //
  // Damit lassen sich Rename, Move, Ordner-Löschung (mehrere delete-Einträge)
  // und Bulk-Upload (mehrere content-Einträge) als ein atomarer Commit abbilden.

  async commitChanges(owner, repo, branch, changes, message) {
    const refData = await this._fetch(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const baseCommitSha = refData.object.sha;

    const baseCommit = await this._fetch(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
    const baseTreeSha = baseCommit.tree.sha;

    // Blobs für neue/geänderte Dateien anlegen
    const treeEntries = [];
    for (const change of changes) {
      if (change.delete) {
        treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
      } else {
        const blob = await this._fetch(`/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({
            content: btoa(unescape(encodeURIComponent(change.content))),
            encoding: "base64",
          }),
        });
        treeEntries.push({
          path: change.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
    }

    const newTree = await this._fetch(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });

    const newCommit = await this._fetch(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [baseCommitSha],
      }),
    });

    await this._fetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha }),
    });

    return newCommit;
  }

  // Komfort-Funktionen oben drauf, die intern commitChanges nutzen:

  moveFile(owner, repo, branch, oldPath, newPath, content) {
    return this.commitChanges(
      owner,
      repo,
      branch,
      [
        { path: newPath, content },
        { path: oldPath, delete: true },
      ],
      `Rename ${oldPath} -> ${newPath}`
    );
  }

  deleteMultiple(owner, repo, branch, paths) {
    return this.commitChanges(
      owner,
      repo,
      branch,
      paths.map((path) => ({ path, delete: true })),
      `Delete ${paths.length} file(s)`
    );
  }

  uploadMultiple(owner, repo, branch, files) {
    // files = [{ path, content }, ...]
    return this.commitChanges(owner, repo, branch, files, `Upload ${files.length} file(s)`);
  }
}
