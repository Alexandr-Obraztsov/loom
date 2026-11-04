// A tiny real ACP agent over stdio. Prompts: "crash" exits 1 after writing "boom" to stderr,
// "pid" answers with its pid, "permission" asks the client for a permission, anything else is echoed.
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
    const cmd = text.toLowerCase();
    if (cmd === "crash") {
      process.stderr.write("boom\n", () => process.exit(1));
      await new Promise(() => undefined);
    }
    if (cmd === "pid") await say(client, params.sessionId, `pid:${String(process.pid)}`);
    else if (cmd === "permission") {
      const res = await client.request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t1", title: "Run ls" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await say(
        client,
        params.sessionId,
        `perm:${res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"}`,
      );
    } else await say(client, params.sessionId, `echo:${text}`);
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
