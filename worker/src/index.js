/**
 * Cloudflare Worker – der einzige "Server" in dieser Blaupause.
 * Zwei Aufgaben:
 *   1. POST /oauth/token  -> tauscht GitHub OAuth "code" gegen Access-Token
 *      (client_secret darf niemals im Browser liegen, deshalb dieser Schritt hier)
 *   2. POST /webhook      -> nimmt GitHub "push"-Events entgegen, prüft Signatur,
 *      schreibt einen Realtime-Event-Datensatz nach Supabase
 */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/oauth/token" && request.method === "POST") {
      return handleOAuthToken(request, env);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    if (url.pathname === "/create-webhook" && request.method === "POST") {
      return handleCreateWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// 1. OAuth Token-Exchange
// ---------------------------------------------------------------------------
async function handleOAuthToken(request, env) {
  const headers = corsHeaders(env);
  try {
    const { code } = await request.json();
    if (!code) {
      return new Response(JSON.stringify({ error: "code fehlt" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const data = await resp.json();

    if (data.error) {
      return new Response(JSON.stringify(data), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // data.access_token an den Client zurückgeben; Client speichert es selbst
    return new Response(
      JSON.stringify({ access_token: data.access_token, scope: data.scope }),
      { headers: { ...headers, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Webhook auf einem Repo anlegen -- GITHUB_WEBHOOK_SECRET bleibt hier,
//    verlässt den Worker nie in Richtung Browser.
// ---------------------------------------------------------------------------
async function handleCreateWebhook(request, env) {
  const headers = corsHeaders(env);
  try {
    const authHeader = request.headers.get("Authorization") || "";
    const userToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!userToken) {
      return new Response(JSON.stringify({ error: "Kein Nutzer-Token übergeben" }), {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const { owner, repo } = await request.json();
    if (!owner || !repo) {
      return new Response(JSON.stringify({ error: "owner/repo fehlt" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const ghHeaders = {
      Authorization: `Bearer ${userToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "github-editor-worker",
    };
    const webhookTargetUrl = `${env.WORKER_PUBLIC_URL}/webhook`;

    // Prüfen, ob der Webhook schon existiert
    const listResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/hooks`,
      { headers: ghHeaders }
    );
    if (!listResp.ok) {
      const text = await listResp.text();
      return new Response(JSON.stringify({ error: `GitHub API: ${text}` }), {
        status: listResp.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    const existingHooks = await listResp.json();
    const alreadyExists = existingHooks.some(
      (h) => h.config?.url === webhookTargetUrl
    );
    if (alreadyExists) {
      return new Response(JSON.stringify({ status: "already-exists" }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const createResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/hooks`,
      {
        method: "POST",
        headers: ghHeaders,
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["push"],
          config: {
            url: webhookTargetUrl,
            content_type: "json",
            secret: env.GITHUB_WEBHOOK_SECRET, // bleibt serverseitig, geht nie an den Browser
          },
        }),
      }
    );

    if (!createResp.ok) {
      const text = await createResp.text();
      return new Response(JSON.stringify({ error: `GitHub API: ${text}` }), {
        status: createResp.status,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ status: "created" }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Webhook-Empfänger (GitHub "push" Event)
// ---------------------------------------------------------------------------
async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("X-Hub-Signature-256") || "";

  const valid = await verifySignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = request.headers.get("X-GitHub-Event");
  if (event !== "push") {
    // Andere Events (z.B. ping) einfach quittieren
    return new Response("OK", { status: 200 });
  }

  const payload = JSON.parse(rawBody);

  const changedFiles = { added: [], removed: [], modified: [] };
  for (const commit of payload.commits || []) {
    changedFiles.added.push(...commit.added);
    changedFiles.removed.push(...commit.removed);
    changedFiles.modified.push(...commit.modified);
  }

  // Datensatz in Supabase schreiben -> löst Realtime-Broadcast an alle Subscriber aus
  await fetch(`${env.SUPABASE_URL}/rest/v1/repo_events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      repo_full_name: payload.repository.full_name,
      commit_sha: payload.after,
      pusher: payload.pusher?.name,
      changed_files: changedFiles,
    }),
  });

  return new Response("OK", { status: 200 });
}

async function verifySignature(body, signatureHeader, secret) {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const actualHex = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Konstante-Zeit-Vergleich
  if (actualHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actualHex.length; i++) {
    diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}
