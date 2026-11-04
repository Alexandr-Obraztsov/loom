import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ToolCallHookContext } from "../api.js";
import type { SessionLog } from "./updates.js";

type Outcome = RequestPermissionResponse["outcome"];

const CANCELLED: Outcome = { outcome: "cancelled" };

/** Permission requests of one session: hooks decide first, otherwise the user does. */
export class PermissionBroker {
  private pending = new Map<string, (outcome: Outcome) => void>();

  constructor(
    private readonly log: SessionLog,
    private readonly runHook: (
      ctx: ToolCallHookContext,
    ) => Promise<{ optionId: string } | null | undefined>,
  ) {}

  async request(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const decision = await this.runHook({
      sessionId: this.log.sessionId,
      toolCall: params.toolCall,
      options: params.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
    });
    if (decision === null) return { outcome: CANCELLED };
    if (decision) return { outcome: { outcome: "selected", optionId: decision.optionId } };

    const id = this.log.newId("p");
    const answered = new Promise<Outcome>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.log.addItem({
      kind: "permission",
      id,
      title: params.toolCall.title ?? params.toolCall.toolCallId,
      options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    });
    return { outcome: await answered };
  }

  /** `null` cancels. Unknown or already answered ids are ignored (double clicks). */
  respond(itemId: string, optionId: string | null): void {
    const resolve = this.pending.get(itemId);
    if (!resolve) return;
    this.pending.delete(itemId);
    this.log.resolvePermission(itemId, optionId ?? "cancelled");
    resolve(optionId === null ? CANCELLED : { outcome: "selected", optionId });
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, null);
  }
}
