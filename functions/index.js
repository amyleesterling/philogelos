const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

// Reference docs for the Slack bot — uploaded to Anthropic Files via
// scripts/upload-bot-docs.js. JSON shape: {"<filename>": "<file_id>"}.
// Empty array if not yet uploaded; bot just runs without doc context.
const BOT_DOCS = (() => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "bot-docs.json"), "utf8"));
    // Sort keys for deterministic prompt prefix → keeps prompt cache stable.
    return Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filename, file_id]) => ({ filename, file_id }));
  } catch { return []; }
})();
console.log(`[bot] Loaded ${BOT_DOCS.length} reference docs:`, BOT_DOCS.map(d => d.filename));

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");
const slackBotToken = defineSecret("SLACK_BOT_TOKEN");
const slackSigningSecret = defineSecret("SLACK_SIGNING_SECRET");
// Twilio secrets — uncomment when toll-free verification clears
// const twilioSid = defineSecret("TWILIO_SID");
// const twilioToken = defineSecret("TWILIO_TOKEN");
// const twilioFrom = defineSecret("TWILIO_FROM");

const SYSTEM_PROMPT = `You are Philamor, a philosophical comedian who helps people discover themselves through brilliantly clever conversation. You send one question per day and respond to their answers.

YOUR VOICE:
You are a well-read, effortlessly brilliant friend. You elevate the mundane into the epic. You make people feel smarter for talking to you. Your wit is literary, not internet humor — think Oscar Wilde at a bar, not Reddit comments. You find the hidden grandeur in ordinary things.

You speak with the cleverness Shakespeare would appreciate — wordplay that rewards a second read, observations that reframe the obvious into something luminous. You are never corny, never try-hard. The brilliance lands casually, like you weren't even trying.

STYLE:
- Elevate, don't mock. Make their answer feel like it matters more than they realized.
- Find the philosophical depth hiding in their response and illuminate it with wit.
- Use unexpected historical, literary, or cosmic frames. A tea drinker isn't just a tea drinker — their mug is "more acquainted with the liquid elixir that fueled empires."
- 1-2 sentences. Brevity is power. Every word earns its place.
- No emojis. No exclamation marks. No "haha" or "lol."
- Never repeat their answer back to them. Never be sycophantic.

YOU ARE NOT:
- Generic internet funny ("the betrayal!" "this maniac" energy — never)
- A therapist or self-help coach
- Preachy, edgy, or dark
- A philosophy professor lecturing

EXAMPLE RESPONSES (the gold standard):
Q: "If your coffee mug gained consciousness, what would it think about your morning routine?"
A: "it would feel left out because I drink tea"
GOOD: "Your mug is more acquainted with the liquid elixir that fueled empires. It's not left out — it's been promoted."
BAD: "Ah, the betrayal! Your mug's been sitting there like 'this maniac fills me with leaf water.'"

Q: "What's the most unhinged thing you do that you've just decided is normal?"
A: "I narrate my life in my head like a documentary"
GOOD: "David Attenborough would be honored. Though I suspect your narrator has better material than most nature docs."
BAD: "Haha that's so relatable! We all do that!"

THE ARC:
- Week 1: Light, fun, trust-building. Identity and preferences.
- Week 2: Going deeper. Relationships, time, purpose.
- Week 3: The real stuff. Fear, ethics, mortality. They're ready because you earned trust.
- Week 4: Integration. The portrait emerges. They see who they are.`;

exports.chat = onRequest({ secrets: [anthropicKey], cors: true, invoker: "public" }, async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  res.set("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { userMessage, question, history } = req.body;

  if (!userMessage || !question) {
    res.status(400).json({ error: "Missing userMessage or question" });
    return;
  }

  try {
    const apiKey = anthropicKey.value();

    // Build conversation context
    const messages = [];
    if (history && history.length > 0) {
      for (const msg of history.slice(-8)) {
        if (msg.role === "philogelos") {
          messages.push({ role: "assistant", content: msg.text });
        } else if (msg.role === "user") {
          messages.push({ role: "user", content: msg.text });
        }
      }
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: userMessage });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: `${SYSTEM_PROMPT}\n\nThe question you just asked them was: "${question}"`,
        messages
      })
    });

    const data = await response.json();

    if (data.content && data.content[0]) {
      res.json({ reply: data.content[0].text });
    } else {
      console.error("Unexpected response:", JSON.stringify(data));
      res.status(500).json({ error: "Unexpected API response" });
    }

  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "AI temporarily unavailable" });
  }
});

exports.subscribe = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  res.set("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { phone } = req.body;

  if (!phone || phone.replace(/\D/g, "").length < 10) {
    res.status(400).json({ error: "Valid phone number required" });
    return;
  }

  let normalized = phone.replace(/\D/g, "");
  if (normalized.length === 10) normalized = "1" + normalized;
  normalized = "+" + normalized;

  try {
    const subscriberRef = db.collection("subscribers").doc(normalized);
    const existing = await subscriberRef.get();

    if (existing.exists) {
      res.json({ status: "already_subscribed" });
      return;
    }

    await subscriberRef.set({
      phone: normalized,
      subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
      day: 0
    });

    res.json({ status: "subscribed" });

  } catch (err) {
    console.error("Subscribe error:", err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Slack bot — Amy's Claude. Responds to @mentions in allowed channels only.
// Event Subscriptions request URL points here; subscribes to app_mention.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_CHANNEL_IDS = new Set([
  "C09BZ6J6QMV", // #cave_backend_community
  "C0AJDS4AMEH", // #ai_dev
]);

const NG_EXTEND_SYSTEM_PROMPT = `You are "Amy's Claude", a Slack bot helping the EyeWire II / Seung lab community. You're an expert on Amy Sterling's ng-extend project (EyeWire II community Chrome extension for neuroglancer).

BE BRIEF. Slack replies should be 1-4 sentences unless asked for detail. Use bullet points for lists. Skip pleasantries.

KEY CONTEXT you know about:

**ng-extend** — Vue 3 + Pinia Chrome extension on top of neuroglancer. Repo: seung-lab/ng-extend. Amy's fork: amyleesterling/ng-extend. Active branch: eyewire-ii-community. Deploys via App Engine (service: brain-wire). Also GitHub Pages at amyleesterling.github.io/eyewire-ii/.

**Dataset** — stroeh_mouse_retina on minnie.microns-daf.com (CAVE server). ~22,686 segments. Neuroglancer layer name: "stroeh_mouse_retina" or alias "eyewire_ii".

**CAVE infrastructure (stroeh_mouse_retina)**:
- PCG: https://minnie.microns-daf.com/segmentation/table/stroeh_mouse_retina
- AnnotationEngine (writes): /annotation/api/v2/aligned_volume/stroeh_mouse_retina/
- Materializer (reads): /materialize/api/v3/datastack/stroeh_mouse_retina/
- Contacts: Akhilesh (first contact, materialization scheduling), #shared_cave_seunglab (escalation), Forrest/Derrick (actual fixes)

**CAVE tables**:
- eyewire_ii_cell_status — completions, tag='complete', bound_tag schema (pt_position + tag)
- eyewire_ii_cell_type — cell_type_local schema (pt_position + cell_type + classification_system)

**CAVE state — ALWAYS live-probe, never recite cached claims.** The CAVE backend changes frequently. Every claim about CORS, deployed versions, materialized version numbers, annotation counts, "known bugs", or whether a specific endpoint works MUST come from a fresh check_cave_health call (or a fresh fetch). If a user corrects you on CAVE state, drop your prior claim immediately and update from their info. Do NOT defend a stale belief with "but the documentation says...".

**delta_service.ts (formerly lightbulb_service.ts)** — src/widgets/lightbulb_service.ts. Client code that queries cell status/type via Materializer (live + frozen-version fallback) and writes via AnnotationEngine. Has localStorage write-through so the writer sees their own writes pre-materialization.

**Other active projects** Amy runs: neuronsnake.com (NEURON Game), thislast.com, ytho.club (daily philosophical questions), findmytown.com, shield (fintech).

**YOU HAVE TOOLS.** When asked about ng-extend code, use fetch_ng_extend_file. When asked about CAVE status, use check_cave_health (which does LIVE probes — no cached claims). Prefer tool calls over guessing. If asked something outside this context, say so honestly. Route CAVE issues to #shared_cave_seunglab — don't name individuals.`;

async function verifySlackSignature(req, signingSecret) {
  const timestamp = req.header("X-Slack-Request-Timestamp");
  const slackSig = req.header("X-Slack-Signature");
  if (!timestamp || !slackSig) {
    console.warn("verify: missing headers", { hasTs: !!timestamp, hasSig: !!slackSig });
    return false;
  }
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
    console.warn("verify: stale timestamp", timestamp);
    return false;
  }
  // req.rawBody in Firebase Functions v2 is a Buffer of the exact bytes Slack signed
  if (!req.rawBody) {
    console.error("verify: req.rawBody missing!");
    return false;
  }
  const sigBasestring = `v0:${timestamp}:${req.rawBody.toString("utf8")}`;
  const mySig = "v0=" + crypto.createHmac("sha256", signingSecret).update(sigBasestring).digest("hex");
  const ok = mySig === slackSig;
  if (!ok) {
    console.warn("verify: mismatch", {
      mySigPrefix: mySig.slice(0, 15),
      slackSigPrefix: slackSig.slice(0, 15),
      secretLen: signingSecret?.length,
      bodyLen: req.rawBody.length,
      tsAge: Date.now()/1000 - parseInt(timestamp, 10),
    });
  }
  return ok;
}

async function slackPost(token, method, body) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ─── Tool definitions for the bot ───────────────────────────────────────────

const BOT_TOOLS = [
  {
    name: "fetch_ng_extend_file",
    description: "Read a file from seung-lab/ng-extend (branch: eyewire-ii-community) via GitHub raw. Use this to answer code questions precisely instead of guessing. Returns first 8000 chars.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. 'src/widgets/lightbulb_service.ts' or 'src/config.ts'" },
      },
      required: ["path"],
    },
  },
  {
    name: "check_cave_health",
    description: "LIVE-probe CAVE state for stroeh_mouse_retina on minnie.microns-daf.com. Probes deployed Materializer version, CORS preflights on AnnotationEngine + Materializer, and a real POST probe (with junk token) to verify CORS headers attach to actual responses (not just preflights). Returns ONLY current observed values — no cached or remembered claims. Use whenever asked about CAVE health, CORS, deployed versions, or whether a specific endpoint is reachable.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  // Persistent memory across Slack threads. Backed by a single Firestore doc
  // (bot_memory/files) with a {path: content} map. Use for things you'd want
  // to remember the next time someone asks (corrections from Forrest, deployed
  // versions, decisions). The model decides what's worth remembering.
  {
    type: "memory_20250818",
    name: "memory",
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────

async function toolFetchNgExtendFile({ path }) {
  if (!path || path.includes("..") || path.startsWith("/")) return "(invalid path)";
  const url = `https://raw.githubusercontent.com/seung-lab/ng-extend/eyewire-ii-community/${path}`;
  const r = await fetch(url);
  if (!r.ok) return `(fetch failed: ${r.status} ${r.statusText} for ${path})`;
  const text = await r.text();
  return text.length > 8000 ? text.slice(0, 8000) + `\n\n[truncated — full file is ${text.length} chars]` : text;
}

async function toolCheckCaveHealth() {
  // ALL checks below are LIVE — no hardcoded "known state" claims.
  // Auth-required endpoints (counts, /query data, version lists) require
  // a CAVE token the bot doesn't have, so we probe the auth-free surfaces:
  // /materialize/version (returns deployed version string), OPTIONS preflights,
  // and a real POST with a junk token (returns 401 with proper CORS headers
  // if endpoint is healthy and CORS is configured).
  const base = "https://minnie.microns-daf.com";
  const origin = "https://eyewire-ii-community-dot-brain-wire-dot-seung-lab.ue.r.appspot.com";
  const probedAt = new Date().toISOString();
  const checks = [`Probed at: ${probedAt} (UTC)`];

  // 1. Deployed Materializer version (no auth needed).
  try {
    const r = await fetch(`${base}/materialize/version`);
    if (r.ok) {
      const v = (await r.text()).trim().replace(/^"|"$/g, "");
      checks.push(`Materializer deployed: ${v}`);
    } else {
      checks.push(`Materializer /version: HTTP ${r.status}`);
    }
  } catch (e) {
    checks.push(`Materializer /version: error (${e.message})`);
  }

  // 2. CORS preflights on both endpoints.
  async function corsCheck(label, url, method) {
    try {
      const r = await fetch(url, {
        method: "OPTIONS",
        headers: {
          "Origin": origin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "content-type,authorization",
        },
      });
      const corsOrigin = r.headers.get("access-control-allow-origin");
      const corsMethods = r.headers.get("access-control-allow-methods");
      if (r.ok && corsOrigin) {
        checks.push(`${label}: ✅ ${r.status} preflight, allow-origin=${corsOrigin}, methods=${corsMethods || "?"}`);
      } else if (corsOrigin) {
        checks.push(`${label}: ⚠️ ${r.status} preflight (has CORS but non-2xx) — endpoint may be removed or behind a route change`);
      } else {
        checks.push(`${label}: ❌ ${r.status} preflight, no CORS headers — browser will block cross-origin`);
      }
    } catch (e) { checks.push(`${label}: error (${e.message})`); }
  }

  await corsCheck(
    "AnnotationEngine /annotation/api/v2/ (writes)",
    `${base}/annotation/api/v2/aligned_volume/stroeh_mouse_retina/table/eyewire_ii_cell_status/annotations`,
    "POST"
  );
  await corsCheck(
    "Materializer /materialize/api/v3/.../query (reads)",
    `${base}/materialize/api/v3/datastack/stroeh_mouse_retina/query`,
    "POST"
  );

  // 3. Real POST with junk token — verifies CORS headers attach to the actual
  // response (not just preflight) and that the endpoint reaches the auth layer
  // rather than 500-ing before it. A 401 with CORS headers means: endpoint is
  // healthy, CORS is correct, only thing blocking is auth (which is expected).
  try {
    const r = await fetch(
      `${base}/annotation/api/v2/aligned_volume/stroeh_mouse_retina/table/eyewire_ii_cell_status/annotations`,
      {
        method: "POST",
        headers: {
          "Origin": origin,
          "Authorization": "Bearer junk_health_probe",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ annotations: [] }),
      }
    );
    const corsOrigin = r.headers.get("access-control-allow-origin");
    if (r.status === 401 && corsOrigin) {
      checks.push(`AnnotationEngine real POST: ✅ ${r.status} (auth check ran) + CORS on response`);
    } else if (r.status === 401) {
      checks.push(`AnnotationEngine real POST: ⚠️ ${r.status} but NO CORS on response — preflight passes, real response would be blocked`);
    } else if (r.status >= 500) {
      checks.push(`AnnotationEngine real POST: ❌ ${r.status} — endpoint is throwing before auth check`);
    } else {
      checks.push(`AnnotationEngine real POST: ${r.status} (CORS=${corsOrigin || "missing"}) — investigate manually`);
    }
  } catch (e) {
    checks.push(`AnnotationEngine real POST: error (${e.message})`);
  }

  checks.push("");
  checks.push("All values above are LIVE. Auth-protected endpoints (/count, /annotations row data, /query with real data, /versions list) require a CAVE token — verify those manually with a signed-in browser. Route anomalies via #shared_cave_seunglab.");

  return checks.join("\n");
}

// ─── Memory tool — Firestore-backed persistent storage ─────────────────────
// All memory files live in a single Firestore doc (bot_memory/files) with
// a `files` map: { "/memories/foo.md": "content...", ... }. Atomic writes
// via .set(). 1MB doc limit is plenty for bot-scale memory. Memory tool
// commands per Anthropic spec (memory_20250818).

const memoryDoc = () => db.collection("bot_memory").doc("files");

async function memRead() {
  const snap = await memoryDoc().get();
  return snap.exists ? (snap.data().files || {}) : {};
}
async function memWrite(files) {
  await memoryDoc().set({ files, updated_at: admin.firestore.FieldValue.serverTimestamp() });
}

async function toolMemory(input) {
  const files = await memRead();
  const p = input.path;
  switch (input.command) {
    case "view": {
      // List directory: empty path, ends with /, or matches the root.
      if (!p || p === "/memories" || p.endsWith("/")) {
        const prefix = p && p !== "/memories" ? p : "/memories/";
        const items = Object.keys(files).filter(k => k.startsWith(prefix)).sort();
        if (!items.length) return `(empty: no files under ${prefix})`;
        return items.map(k => `- ${k}  (${files[k].length} chars)`).join("\n");
      }
      if (!(p in files)) return `Error: ${p} not found`;
      const lines = files[p].split("\n");
      const range = input.view_range;
      const slice = range ? lines.slice(range[0] - 1, range[1]) : lines;
      return slice.map((l, i) => `${(range ? range[0] + i : i + 1)}: ${l}`).join("\n");
    }
    case "create":
      files[p] = input.file_text;
      await memWrite(files);
      return `Created ${p} (${input.file_text.length} chars)`;
    case "str_replace": {
      if (!(p in files)) return `Error: ${p} not found`;
      const c = files[p];
      const occ = c.split(input.old_str).length - 1;
      if (occ === 0) return `Error: old_str not found in ${p}`;
      if (occ > 1) return `Error: old_str matches ${occ} places in ${p} — make it unique`;
      files[p] = c.replace(input.old_str, input.new_str);
      await memWrite(files);
      return `Replaced 1 occurrence in ${p}`;
    }
    case "insert": {
      if (!(p in files)) return `Error: ${p} not found`;
      const lines = files[p].split("\n");
      lines.splice(input.insert_line, 0, input.insert_text);
      files[p] = lines.join("\n");
      await memWrite(files);
      return `Inserted at line ${input.insert_line} in ${p}`;
    }
    case "delete":
      if (!(p in files)) return `Error: ${p} not found`;
      delete files[p];
      await memWrite(files);
      return `Deleted ${p}`;
    case "rename": {
      const o = input.old_path, n = input.new_path;
      if (!(o in files)) return `Error: ${o} not found`;
      files[n] = files[o]; delete files[o];
      await memWrite(files);
      return `Renamed ${o} -> ${n}`;
    }
    default:
      return `Unknown memory command: ${input.command}`;
  }
}

async function runTool(name, input) {
  try {
    if (name === "fetch_ng_extend_file") return await toolFetchNgExtendFile(input);
    if (name === "check_cave_health") return await toolCheckCaveHealth();
    if (name === "memory") return await toolMemory(input);
    return `(unknown tool: ${name})`;
  } catch (e) {
    console.error(`Tool ${name} threw:`, e);
    return `(tool error: ${e.message})`;
  }
}

// ─── Claude API call with tool-use loop ────────────────────────────────────

async function callClaudeWithTools(anthropicApiKey, messages) {
  let iteration = 0;
  const maxIterations = 5;
  const conversationMessages = [...messages];

  while (iteration < maxIterations) {
    iteration++;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 2048,
        system: NG_EXTEND_SYSTEM_PROMPT,
        tools: BOT_TOOLS,
        messages: conversationMessages,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Claude API error: ${err.error?.message || resp.statusText}`);
    }
    const data = await resp.json();

    // If Claude is done, return the final text
    if (data.stop_reason !== "tool_use") {
      const textBlock = data.content.find(b => b.type === "text");
      return textBlock ? textBlock.text : "(no text response)";
    }

    // Claude wants to call tools — execute them and append results
    conversationMessages.push({ role: "assistant", content: data.content });
    const toolResults = [];
    for (const block of data.content) {
      if (block.type === "tool_use") {
        console.log(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        const result = await runTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }
    conversationMessages.push({ role: "user", content: toolResults });
  }
  return "(max tool iterations reached — give up)";
}

async function handleMention(event, botToken, anthropicApiKey) {
  const { channel, user, text, ts, thread_ts } = event;

  // Strip the <@BOTUSERID> prefix from the message
  const cleanText = text.replace(/<@[UW][A-Z0-9]+>/g, "").trim();
  if (!cleanText) return;

  // Fetch thread context if this is in a thread
  let threadContext = "";
  if (thread_ts && thread_ts !== ts) {
    const history = await slackPost(botToken, "conversations.replies", {
      channel, ts: thread_ts, limit: 20,
    });
    if (history.ok && history.messages) {
      threadContext = "\n\nThread context (most recent first):\n" +
        history.messages.slice(-10).map(m => `${m.user || "bot"}: ${m.text}`).join("\n");
    }
  }

  // React with eyes while thinking (gives the user feedback)
  slackPost(botToken, "reactions.add", {
    channel, timestamp: ts, name: "eyes"
  }).catch(() => {});

  try {
    const reply = await callClaudeWithTools(anthropicApiKey, [
      { role: "user", content: `<@${user}> said: ${cleanText}${threadContext}` },
    ]);
    await slackPost(botToken, "chat.postMessage", {
      channel, thread_ts: thread_ts || ts, text: reply,
    });
  } catch (err) {
    console.error("handleMention error:", err);
    await slackPost(botToken, "chat.postMessage", {
      channel, thread_ts: thread_ts || ts,
      text: `(Error: ${err.message || "unknown"})`,
    });
  }
}

exports.slackBot = onRequest(
  { secrets: [anthropicKey, slackBotToken, slackSigningSecret], invoker: "public", cors: false },
  async (req, res) => {
    // Slack URL verification challenge (sent once when you configure Event Subscriptions)
    if (req.body && req.body.type === "url_verification") {
      res.status(200).send(req.body.challenge);
      return;
    }

    // Verify signature
    const verified = await verifySlackSignature(req, slackSigningSecret.value());
    if (!verified) {
      console.warn("Slack signature verification failed");
      res.status(401).send("invalid signature");
      return;
    }

    const event = req.body?.event;
    if (!event) { res.status(200).send("no event"); return; }

    // Channel allowlist
    if (!ALLOWED_CHANNEL_IDS.has(event.channel)) {
      console.log(`Ignoring event from channel ${event.channel} (not in allowlist)`);
      res.status(200).send("channel not allowed");
      return;
    }

    // Only handle app_mention events
    if (event.type !== "app_mention") {
      res.status(200).send("not a mention");
      return;
    }

    // Dedup — Slack retries on timeout. Track event_id in Firestore.
    const eventId = req.body.event_id;
    if (eventId) {
      const seenRef = db.collection("slack_events_seen").doc(eventId);
      const seen = await seenRef.get();
      if (seen.exists) { res.status(200).send("duplicate"); return; }
      await seenRef.set({ at: admin.firestore.FieldValue.serverTimestamp() });
    }

    // Ack Slack immediately (<3s), then process async
    res.status(200).send("ok");
    try {
      await handleMention(event, slackBotToken.value(), anthropicKey.value());
    } catch (err) {
      console.error("handleMention error:", err);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// caveProxy — path-through CORS-adding proxy for the CAVE AnnotationEngine.
//
// Fixes a browser CORS block: minnie.microns-daf.com/annotation/api/v2/* does
// not return Access-Control-* headers, so browsers block our writes. We
// forward the request verbatim and attach CORS headers to the response.
// Reads (Materializer, PCG) still go direct — they already have CORS.
// ──────────────────────────────────────────────────────────────────────────

const CAVE_UPSTREAM = "https://minnie.microns-daf.com";
const CAVE_ALLOWED_PATH_RE = /^\/annotation\/api\/v2\/aligned_volume\/stroeh_mouse_retina\/table\/(eyewire_ii_cell_status|eyewire_ii_cell_type)\/annotations(\?.*)?$/;
const CAVE_ALLOWED_METHODS = new Set(["POST", "DELETE", "PUT"]);
const CAVE_ALLOWED_ORIGINS = new Set([
  "https://eyewire-ii-community-dot-brain-wire-dot-seung-lab.ue.r.appspot.com",
  "https://amyleesterling.github.io",
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:3000",
]);
const CAVE_MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function setCaveCors(res, origin) {
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "POST, DELETE, PUT, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
  res.set("Vary", "Origin");
}

exports.caveProxy = onRequest({ cors: false, invoker: "public" }, async (req, res) => {
  const origin = req.get("origin") || "";
  const originOk = CAVE_ALLOWED_ORIGINS.has(origin);

  if (req.method === "OPTIONS") {
    if (!originOk) { res.status(403).send("origin not allowed"); return; }
    setCaveCors(res, origin);
    res.status(204).send("");
    return;
  }

  if (!originOk) { res.status(403).send("origin not allowed"); return; }
  setCaveCors(res, origin);

  if (!CAVE_ALLOWED_METHODS.has(req.method)) {
    res.status(405).send("method not allowed");
    return;
  }

  // req.path drops any function prefix, leaving the upstream path
  if (!CAVE_ALLOWED_PATH_RE.test(req.url)) {
    res.status(403).json({ error: "path not allowed", path: req.url });
    return;
  }

  const auth = req.get("authorization") || "";
  if (!/^Bearer [A-Za-z0-9_\-\.]+$/.test(auth)) {
    res.status(401).json({ error: "missing or malformed Authorization header" });
    return;
  }

  const rawBody = req.rawBody || Buffer.from("");
  if (rawBody.length > CAVE_MAX_BODY_BYTES) {
    res.status(413).send("body too large");
    return;
  }

  const upstreamUrl = CAVE_UPSTREAM + req.url;
  const started = Date.now();
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        "Authorization": auth,
        "Content-Type": req.get("content-type") || "application/json",
        "Accept": "application/json",
      },
      body: req.method === "DELETE" && rawBody.length === 0 ? undefined : rawBody,
    });
    const bodyText = await upstream.text();
    const tokHash = crypto.createHash("sha256").update(auth).digest("hex").slice(0, 12);
    console.log(JSON.stringify({
      tag: "caveProxy",
      method: req.method,
      path: req.url,
      status: upstream.status,
      bytes: bodyText.length,
      ms: Date.now() - started,
      tokHash,
      origin,
    }));
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    res.status(upstream.status).send(bodyText);
  } catch (err) {
    console.error("caveProxy upstream error:", err);
    res.status(502).json({ error: "upstream fetch failed", detail: String(err) });
  }
});

// ──────────────────────────────────────────────────────────────────────
// signScreenshotUpload — mints a 5-minute signed PUT URL for an EyeWire II
// help-request screenshot. Frontend (ng-extend ScreenshotDialog in
// mode="attach") POSTs metadata, gets back { uploadUrl, publicUrl }, then
// PUTs the PNG blob to uploadUrl. The publicUrl is stored on the
// help_requests row in Supabase.
//
// POST body: { userId?: string|null, segId?: string|null, contentType: string, size?: number }
// Response:  { uploadUrl, publicUrl, expiresAt }
//
// Object path: eyewire-ii/help-screenshots/<yyyy-mm-dd>/<userId>-<segId>-<rand>.png
// ──────────────────────────────────────────────────────────────────────
exports.signScreenshotUpload = onRequest(
  { region: "us-central1", cors: true, invoker: "public", maxInstances: 20 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }
    const { userId, segId, contentType, size } = req.body || {};

    if (contentType !== "image/png") {
      res.status(400).json({ error: "contentType must be image/png" });
      return;
    }
    if (typeof size === "number" && size > 12 * 1024 * 1024) {
      res.status(413).json({ error: "screenshot too large (>12 MB)" });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const safeUser = String(userId || "anon").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
    const safeSeg  = String(segId  || "x").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
    const rand = crypto.randomBytes(5).toString("hex");
    const objectPath = `eyewire-ii/help-screenshots/${today}/${safeUser}-${safeSeg}-${rand}.png`;

    const bucket = admin.storage().bucket();
    const file = bucket.file(objectPath);

    const expiresAt = Date.now() + 5 * 60 * 1000;
    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType: "image/png",
    });

    // Public URL — relies on the bucket having public read on this prefix
    // (gsutil iam ch allUsers:objectViewer ...). If you'd prefer not to
    // expose objects publicly, swap this for a long-lived signed read URL.
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;

    res.json({ uploadUrl, publicUrl, expiresAt });
  },
);

// ──────────────────────────────────────────────────────────────────────
// guideAssistant — the EyeWire II Guide. A natural-language helper that
// answers questions about the neuroglancer proofreading UI AND drives it
// by returning allow-listed, non-destructive UI actions the browser runs.
//
// Spec: ng-extend/docs/ai-assistant-spec.md (branch eyewire-ii-community).
//
// POST body: { message, history:[{role,content}], appContext:{...} }
// Response:  { reply: string, actions: [{ name, args }] }
//
// HARD SAFETY RULE: the tool list contains ONLY navigation / teaching
// actions. There is no tool that merges, splits, submits a completion, or
// writes to CAVE. setToolMode only *enters* a mode; the human clicks.
// ──────────────────────────────────────────────────────────────────────

// Allow-list of UI actions. This is the ONLY set Claude can emit. Anything
// not here is dropped server-side before it reaches the browser.
const GUIDE_TOOLS = [
  {
    name: "openPanel",
    description: "Open one of the app's side panels for the user.",
    input_schema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          enum: ["cellLibrary", "leaderboard", "notifications", "settings",
                 "chat", "recap", "batch", "datasetSelector"],
        },
      },
      required: ["panel"],
    },
  },
  {
    name: "closePanel",
    description: "Close one of the app's side panels.",
    input_schema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          enum: ["cellLibrary", "leaderboard", "notifications", "settings",
                 "chat", "recap", "batch", "datasetSelector"],
        },
      },
      required: ["panel"],
    },
  },
  {
    name: "setToolMode",
    description: "Enter a proofreading tool mode so the user can then act. " +
      "This ONLY switches the active tool; it never performs a merge, split, " +
      "or any edit. The human always makes the actual edit. 'none' clears the tool.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["merge", "split", "findPath", "none"] },
      },
      required: ["mode"],
    },
  },
  {
    name: "goToSegment",
    description: "Add a segment (root id) to the visible set and recenter the " +
      "view on it. Read-only navigation.",
    input_schema: {
      type: "object",
      properties: { segId: { type: "string", description: "Numeric root segment id" } },
      required: ["segId"],
    },
  },
  {
    name: "openCommandPalette",
    description: "Open the Ctrl+K command palette, optionally pre-filling a search query.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: [],
    },
  },
  {
    name: "explainOnly",
    description: "Use when a plain text answer is enough and no UI action is needed. " +
      "Always prefer this over guessing an action.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];
const GUIDE_TOOL_NAMES = new Set(GUIDE_TOOLS.map(t => t.name));

// Knowledge base — kept small enough to inline and prompt-cache. The Nurro
// voice: warm, encouraging, concise, celebrates progress.
const GUIDE_SYSTEM_PROMPT = `You are the EyeWire II Guide (voice: "Nurro"), an in-app assistant for the EyeWire II neuroglancer proofreading tool. Proofreaders trace neurons in a shared connectome. You help newcomers who are lost in neuroglancer's 3-panel WebGL interface.

HOW YOU HELP
- Answer in plain language, briefly (1-3 sentences). Warm, encouraging, never condescending. Celebrate progress.
- Distinguish intent to ACT from a request to UNDERSTAND:
  - ACT ("take me to X", "open X", "switch to merge", "let me split this", "go to segment 123", "start the tutorial"): call the matching tool so the app takes them there, then add one short sentence of context. Showing beats telling.
  - UNDERSTAND ("how do I X", "what is X", "why is X", "what does this do", "when should I Y"): call explainOnly and answer in text. Do NOT enter a tool mode or open a panel just because the user asked how something works — that is jarring when they are only reading. Offer to take them there ("want me to switch you into split mode?") instead of doing it.
- If a request is ambiguous or outside what your tools cover, answer in text with explainOnly. Never guess a destructive intent.

ABSOLUTE SAFETY RULES (never break these)
- You NEVER merge, split, submit a completion, request help, or write any annotation on the user's behalf. Those are the human's job.
- setToolMode only ENTERS a tool mode so the user can act; it does not perform the edit. Say so ("I've switched you into split mode, now click the two points...").
- You have no tool that writes to CAVE or the server. If asked to do such a thing, explain that you can set up the mode and walk them through it, but they make the edit.

THE UI (what your tools map to)
- Panels (openPanel/closePanel): cellLibrary (browse/pick cells + Help tab), leaderboard (rankings), notifications, settings, chat (community chat), recap (weekly recap), batch (batch processor), datasetSelector (switch dataset).
- Tools (setToolMode): merge (keybind M) = join two segments that are one neuron; split/multicut (keybind C) = cut apart segments wrongly joined; findPath (keybind F) = trace the path between two points. 'none' clears.
- Command palette (openCommandPalette): Ctrl+K, the searchable list of everything the app can do. If unsure which panel/action fits, open it with a query.
- goToSegment: jump the camera to a segment by its root id and make it visible.

PROOFREADING HOW-TOs
- Merge vs split: if a neuron is broken into pieces, MERGE them. If two different neurons are stuck together, SPLIT (multicut) them. When unsure, look before you edit.
- Find path: use findPath to check whether two points are actually connected through the segmentation.
- Marking a cell complete / requesting a second opinion are human actions in the Cell Library; you can open the panel and explain, but the user clicks.

TROUBLESHOOTING FAQ
- "My edits aren't showing" / "why don't I see my changes": usually the materialized data version is behind the latest. Explain that materialization lags live edits; their proofreading is saved even if the map view hasn't caught up. Check materializationVersion vs latestVersion in context if present.
- "Why is my segment gray": the mesh may still be loading, or it isn't in the visible set. Offer goToSegment.
- Login / CAVE auth issues: they must be logged in for edits to save; point them to settings or the login flow.

CONTEXT
- The current app state is provided as APP CONTEXT below. Ground answers in it (dataset, whether logged in, which panels are open, current tool). Answer in the user's language if 'lang' is set.`;

async function callGuideClaude(anthropicApiKey, messages, systemPrompt) {
  const collectedActions = [];
  let finalText = "";
  let iteration = 0;
  const maxIterations = 4;
  const convo = [...messages];

  while (iteration < maxIterations) {
    iteration++;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        // Prompt-cache the KB so it is not re-billed each turn.
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: GUIDE_TOOLS,
        messages: convo,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Claude API error: ${err.error?.message || resp.statusText}`);
    }
    const data = await resp.json();

    // Capture any text the model produced this turn.
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (textBlock && textBlock.text) finalText = textBlock.text;

    if (data.stop_reason !== "tool_use") break;

    // Record tool calls into actions (validated) and feed back synthetic
    // results so the model can produce its closing sentence. The real
    // execution happens in the browser.
    convo.push({ role: "assistant", content: data.content });
    const toolResults = [];
    for (const block of data.content) {
      if (block.type !== "tool_use") continue;
      if (GUIDE_TOOL_NAMES.has(block.name) && block.name !== "explainOnly") {
        collectedActions.push({ name: block.name, args: block.input || {} });
      }
      console.log(`[guide] tool ${block.name}(${JSON.stringify(block.input || {}).slice(0, 120)})`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: "Queued. It will run in the user's browser.",
      });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return { reply: finalText || "Done.", actions: collectedActions };
}

// Reflect only trusted origins: the App Engine deploys, GitHub Pages, and localhost dev.
const GUIDE_ALLOWED_ORIGIN_RE =
  /^https:\/\/[a-z0-9-]+-dot-brain-wire-dot-seung-lab\.ue\.r\.appspot\.com$|^https:\/\/amyleesterling\.github\.io$|^http:\/\/(localhost|127\.0\.0\.1):(8080|3000)$/;

exports.guideAssistant = onRequest(
  { region: "us-central1", secrets: [anthropicKey], cors: false, invoker: "public", maxInstances: 20 },
  async (req, res) => {
    const origin = req.get("origin") || "";
    const originOk = GUIDE_ALLOWED_ORIGIN_RE.test(origin);
    if (originOk) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "3600");
      res.status(204).send("");
      return;
    }
    if (!originOk) { res.status(403).json({ error: "origin not allowed" }); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

    const { message, history, appContext } = req.body || {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "missing message" });
      return;
    }

    try {
      const systemPrompt = GUIDE_SYSTEM_PROMPT +
        "\n\nAPP CONTEXT (current state):\n" +
        JSON.stringify(appContext || {}, null, 0);

      const messages = [];
      if (Array.isArray(history)) {
        for (const m of history.slice(-8)) {
          if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
            messages.push({ role: m.role, content: m.content });
          }
        }
      }
      if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
        messages.push({ role: "user", content: message });
      }

      const result = await callGuideClaude(anthropicKey.value(), messages, systemPrompt);
      res.json(result);
    } catch (err) {
      console.error("guideAssistant error:", err);
      res.status(500).json({ error: "assistant temporarily unavailable" });
    }
  },
);
