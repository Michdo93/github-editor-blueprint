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
      cache: "no-store", // wichtig: verhindert, dass ein gecachter, veralteter Ref-Stand
                          // (z.B. bei /git/ref/heads/...) zu dauerhaften "not a fast forward"-
                          // Fehlern führt, weil wir sonst denselben alten Stand aus dem
                          // Browser-Cache statt einer frischen Antwort bekommen könnten.
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

  // Webhook-Erstellung läuft jetzt serverseitig über den Worker (POST /create-webhook),
  // damit GITHUB_WEBHOOK_SECRET niemals im Browser-Code sichtbar ist. Siehe app.js.

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

  // Baum direkt aus einem selbst erzeugten Commit-Objekt lesen (kein erneuter Branch-Read nötig,
  // vermeidet Replikations-Verzögerung: der Commit ist ja gerade eben in DIESER Antwort entstanden)
  getTreeFromCommit(owner, repo, commit) {
    return this._fetch(`/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
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

  async commitChanges(owner, repo, branch, changes, message, _attempt = 1) {
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

    try {
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
    } catch (err) {
      // GitHub-seitige Replikations-Verzögerung (GitRPC::BadObjectState) -- kurz warten, erneut versuchen
      const isReplicationRace = /BadObjectState|not a fast forward/i.test(String(err));
      if (isReplicationRace && _attempt < 6) {
        const jitter = Math.random() * 150;
        const delay = Math.min(300 * 2 ** (_attempt - 1), 2000) + jitter;
        await new Promise((r) => setTimeout(r, delay));
        return this.commitChanges(owner, repo, branch, changes, message, _attempt + 1);
      }
      throw err;
    }
  }

  // Komfort-Funktionen oben drauf, die intern commitChanges nutzen:

  createFile(owner, repo, branch, path, content = "") {
    return this.commitChanges(owner, repo, branch, [{ path, content }], `Create ${path}`);
  }

  // Git kennt keine leeren Ordner -- ein .gitkeep sorgt dafür, dass der Ordner im Baum erscheint.
  createFolder(owner, repo, branch, folderPath) {
    return this.commitChanges(
      owner,
      repo,
      branch,
      [{ path: `${folderPath}/.gitkeep`, content: "" }],
      `Create folder ${folderPath}`
    );
  }

  // allFiles = kompletter flacher Dateibaum (aus getTree), um Ordner-Inhalte zu finden
  async renamePath(owner, repo, branch, oldPath, newPath, isFolder, allFiles) {
    if (!isFolder) {
      const { content } = await this.getFileContent(owner, repo, oldPath, branch);
      return this.moveFile(owner, repo, branch, oldPath, newPath, content);
    }

    const affected = allFiles.filter((f) => f.path.startsWith(`${oldPath}/`));
    const changes = [];
    for (const f of affected) {
      const { content } = await this.getFileContent(owner, repo, f.path, branch);
      const rest = f.path.slice(oldPath.length); // z.B. "/unterordner/datei.txt"
      changes.push({ path: `${newPath}${rest}`, content });
      changes.push({ path: f.path, delete: true });
    }
    return this.commitChanges(owner, repo, branch, changes, `Rename folder ${oldPath} -> ${newPath}`);
  }

  deletePath(owner, repo, branch, path, isFolder, allFiles) {
    if (!isFolder) {
      return this.deleteMultiple(owner, repo, branch, [path]);
    }
    const affected = allFiles.filter((f) => f.path.startsWith(`${path}/`));
    return this.deleteMultiple(owner, repo, branch, affected.map((f) => f.path));
  }

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
