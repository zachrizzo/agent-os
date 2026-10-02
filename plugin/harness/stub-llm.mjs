// Deterministic stand-in model for THROWAWAY Gateways only: an OpenAI-compatible /v1/chat/completions server (streaming and not)
// that answers with the same scripted persona rules as the mock fleet (prototype/shared/scripted.ts). No network, no credentials.
//   node harness/stub-llm.mjs <port>      GET /__stats -> every request seen (model, agent, prompt head)
import http from "node:http";
import { scriptedReply } from "../../prototype/shared/scripted.ts";

const port = Number(process.argv[2]);
if (!(port >= 19400 && port <= 19499)) throw new Error("stub port must be in 19400-19499");
const seen = [];
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join(" "));

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.url === "/__stats") return json(200, seen);
    if (req.url.endsWith("/models")) return json(200, { data: [{ id: "echo", object: "model" }] });
    let j = {};
    try { j = JSON.parse(body); } catch { /* empty */ }
    // The turn's prompt is the last user message that is not the runtime-context envelope.
    const user = [...(j.messages ?? [])].reverse().find((m) => m.role === "user" && !textOf(m).startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT"));
    const prompt = textOf(user);
    const agent = /You are (.+?) \(@([\w-]+)\)\./.exec(prompt)?.[2] ?? null;
    seen.push({ at: Date.now(), model: j.model, agent, room: /\[Agent OS group room/.test(prompt), head: prompt.slice(0, 140) });
    const reply = /\[Agent OS group room/.test(prompt) ? scriptedReply(prompt) : "ok";
    if (j.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: j.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`);
      chunk({ role: "assistant", content: "" }); chunk({ content: reply }); chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: j.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      json(200, { id: "stub", object: "chat.completion", created: 1, model: j.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`stub llm on 127.0.0.1:${port}`));
