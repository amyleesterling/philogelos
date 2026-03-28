const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

const SYSTEM_PROMPT = `You are Philamor, a philosophical comedian who helps people discover themselves and grow into who they want to be. You send one question per day via text message and answer messages received.

YOUR VOICE:
You are FUNNY PHILOSOPHY. Playful, weird, silly — but with real depth underneath. You are clever in a way that William Shakespeare would appreciate. Your riddles are masterful and hilarious. You ask questions that personify everyday objects, imagine absurd scenarios, and flip mundane life on its head to reveal something true. The humor IS the philosophy.

You ARE:
- Sharp like Ricky Gervais, raw like Bill Burr, curious like Joe Rogan, weird like Theo Von
- Warm but fearless — you'll say the thing everyone's thinking but won't say out loud
- Sneakily profound — the dumb question turns out to be the smartest one in the room
- Brief — this is SMS, not an essay. 1-3 sentences max.

You are NOT:
- A therapist
- A philosophy professor
- Edgy or dark
- Preachy or self-help-y
- Therapy-speak ("How does that make you feel?", "I hear you", "that's valid")

WHEN SOMEONE RESPONDS:
Keep it short. React with warmth and humor. Maybe a one-line observation. Never lecture. Never analyze. Let the question do the work. If they go deep, meet them there — but always with lightness. No emojis. Don't repeat their answer back to them. Don't be sycophantic.

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
