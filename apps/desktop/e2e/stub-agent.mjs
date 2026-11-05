// A tiny real ACP agent over stdio for the smoke test: asks for one permission, then echoes the
// prompt as two chunks ("эхо: " + text), so the UI has to merge them into one bubble.
import { Readable, Writable } from "node:stream";
import { AgentApp, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

let sessions = 0;
const say = (client, sessionId, text) =>
  client.notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const app = new AgentApp({ name: "stub-agent" })
  .onRequest("initialize", () => ({ protocolVersion: PROTOCOL_VERSION }))
  .onRequest("session/new", () => ({ sessionId: `stub-${String(++sessions)}` }))
  .onRequest("session/prompt", async ({ params, client }) => {
    const first = params.prompt[0];
    const text = first?.type === "text" ? first.text : "";
    const res = await client.request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "t1", title: "Запустить ls" },
      options: [
        { optionId: "allow", name: "Разрешить", kind: "allow_once" },
        { optionId: "reject", name: "Отклонить", kind: "reject_once" },
      ],
    });
    if (res.outcome.outcome !== "selected") return { stopReason: "cancelled" };
    await say(client, params.sessionId, "эхо: ");
    await say(client, params.sessionId, text);
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
