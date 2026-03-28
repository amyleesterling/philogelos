const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

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
