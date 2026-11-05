import { LoomError } from "../core/errors.js";
import type { Kernel, KernelInternals } from "../core/kernel.js";
import { kernelInternals } from "../core/kernel.js";
import type { HookRef, Next, TapOptions } from "../core/types.js";
import type { RpcChannel, RpcEndpoint } from "./endpoint.js";
import { channelOf } from "./endpoint.js";
import { startTimer, stopTimer } from "./platform.js";
import type { Outcome, TapMessage, TapRequest } from "./protocol.js";
import { describe, deserializeError, hookTarget, remoteError, serializeError } from "./protocol.js";

/** Where an outcome goes: invocation `id` on `channel`, as the result of `phase`. */
export interface OutcomeTarget {
  readonly channel: RpcChannel;
  readonly id: number;
  readonly phase: "next" | "tap";
}

/** Sends a tap-result; a value that cannot be sent becomes an RPC_REMOTE_ERROR outcome. */
function sendOutcome({ channel, id, phase }: OutcomeTarget, outcome: Outcome): void {
  try {
    channel.send({ type: "tap-result", id, for: phase, outcome });
  } catch (e) {
    const error = serializeError(remoteError(`Cannot send hook result: ${describe(e)}`));
    channel.sendReply({ type: "tap-result", id, for: phase, outcome: { ok: false, error } });
  }
}

export function settleOutcome(promise: Promise<unknown>, target: OutcomeTarget): void {
  promise.then(
    (value: unknown) => {
      sendOutcome(target, { ok: true, value });
    },
    (error: unknown) => {
      sendOutcome(target, { ok: false, error: serializeError(error) });
    },
  );
}

interface Invocation {
  next(ctx: unknown): void;
  done(outcome: Outcome): void;
}

const invocationMaps = new WeakMap<RpcChannel, Map<number, Invocation>>();

/** Invocations this side started (tap-invoke sent), keyed by invocation id; one dispatcher per endpoint. */
function invocationsOf(channel: RpcChannel): Map<number, Invocation> {
  const found = invocationMaps.get(channel);
  if (found) return found;
  const own = new Map<number, Invocation>();
  invocationMaps.set(channel, own);
  channel.onTapMessage((msg: TapMessage) => {
    if (msg.type === "tap-next") {
      const invocation = own.get(msg.id);
      if (invocation) invocation.next(msg.ctx);
      else {
        const error = new LoomError("RPC_CANCELLED", "The remote tap invocation is no longer running");
        sendOutcome({ channel, id: msg.id, phase: "next" }, { ok: false, error: serializeError(error) });
      }
    } else if (msg.type === "tap-result" && msg.for === "tap") own.get(msg.id)?.done(msg.outcome);
  });
  return own;
}

interface RemoteTap {
  readonly channel: RpcChannel;
  readonly internals: KernelInternals;
  readonly hookId: string;
  readonly owner: string;
  readonly tapId: number;
  readonly timeoutMs: number;
}

/**
 * Forwards one hook invocation to the tapping side and resolves with its tap-result.
 *
 * If the tap-result does not arrive within `timeoutMs`, reports HOOK_TIMEOUT naming the owner;
 * if the endpoint is or becomes closed, reports RPC_DISCONNECTED instead. Either way the run
 * continues with `next(ctx)`, or with the downstream result if the remote side already called next.
 *
 * The timeout covers the whole remote tap, including the downstream work behind its `next()`
 * (the remote fn may be fast and still be timed out by a slow downstream). A tap-result that
 * arrives after the timeout is ignored. The remote fn cannot be cancelled: a tap function takes
 * no signal, so a timed-out or disconnected invocation is simply abandoned on the tapping side.
 */
function invoke(tap: RemoteTap, ctx: unknown, next: Next<unknown, unknown>): Promise<unknown> {
  const { channel, internals, owner } = tap;
  const lost = (): LoomError =>
    new LoomError("RPC_DISCONNECTED", `Remote tap of "${owner}" on hook "${tap.hookId}" was disconnected`, { pluginIds: [owner] });
  if (channel.isClosed) {
    // a run that snapshotted the tap before the endpoint closed: skip it without sending
    internals.report(lost());
    return Promise.resolve().then(() => next(ctx));
  }
  const invocations = invocationsOf(channel);
  const id = channel.nextId();
  return new Promise<unknown>((resolve, reject) => {
    let downstream: Promise<unknown> | undefined;
    const callNext = (c: unknown): Promise<unknown> => {
      const result = Promise.resolve().then(() => next(c));
      downstream ??= result;
      return result;
    };
    const finish = (): void => {
      stopTimer(timer);
      invocations.delete(id);
      offClose();
    };
    const abandon = (error: LoomError): void => {
      finish();
      internals.report(error);
      resolve(downstream ?? callNext(ctx));
    };
    const timer = startTimer(() => {
      const message = `Remote tap of "${owner}" on hook "${tap.hookId}" did not finish within ${String(tap.timeoutMs)} ms`;
      abandon(new LoomError("HOOK_TIMEOUT", message, { pluginIds: [owner] }));
    }, tap.timeoutMs);
    // the channel is open here, so this callback never runs before `offClose` is assigned
    const offClose = channel.onClose(() => {
      abandon(lost());
    });
    invocations.set(id, {
      next: (c) => {
        settleOutcome(callNext(c), { channel, id, phase: "next" });
      },
      done: (outcome) => {
        finish();
        if (outcome.ok) resolve(outcome.value);
        else reject(deserializeError(outcome.error));
      },
    });
    try {
      channel.send({ type: "tap-invoke", id, tapId: tap.tapId, ctx });
    } catch (e) {
      finish();
      reject(remoteError(`Cannot send context of hook "${tap.hookId}": ${describe(e)}`, e));
    }
  });
}

function tapOptions(req: TapRequest): TapOptions<unknown> {
  const opts: TapOptions<unknown> = {};
  if (req.priority !== undefined) opts.priority = req.priority;
  if (req.before !== undefined) opts.before = req.before;
  if (req.after !== undefined) opts.after = req.after;
  return opts;
}

/**
 * Lets the peer of `endpoint` tap `hooks` with `tapRemote`. Each remote tap becomes a local tap
 * owned by `remote:<plugin id>` that forwards the context to the peer. Remote taps are removed
 * on untap, when the endpoint closes, and by the returned function (which also stops serving).
 * Protocol errors of the endpoint are reported to `kernel.error`. Only async hooks can be
 * exposed; a sync hook throws TAP_FAILED.
 */
export function exposeHooks(kernel: Kernel, endpoint: RpcEndpoint, hooks: readonly HookRef<unknown, unknown>[]): () => void {
  const channel = channelOf(endpoint);
  const internals = kernelInternals(kernel);
  for (const hook of hooks) {
    if (hook.mode === "sync") throw new LoomError("TAP_FAILED", `Sync hook "${hook.id}" cannot be tapped remotely`);
  }
  const taps = new Map<number, () => void>();
  const untap = (tapId: number): void => {
    taps.get(tapId)?.();
    taps.delete(tapId);
  };
  const untapAll = (): void => {
    for (const tapId of [...taps.keys()]) untap(tapId);
  };
  const removers = hooks.map((hook) =>
    endpoint.handle(hookTarget(hook.id), (method, args) => {
      const req = args[0] as TapRequest;
      if (method === "untap") untap(req.tapId);
      else if (method === "tap") {
        const tap: RemoteTap = { channel, internals, hookId: hook.id, owner: `remote:${req.owner}`, tapId: req.tapId, timeoutMs: req.timeoutMs };
        // a peer reusing a tapId replaces its earlier tap instead of leaking it until close
        untap(req.tapId);
        taps.set(req.tapId, internals.tap(hook, { ...tapOptions(req), owner: tap.owner }, (ctx, next) => invoke(tap, ctx, next)));
      } else return Promise.reject(remoteError(`Unknown hook request "${method}"`));
      return Promise.resolve(undefined);
    }),
  );
  const offClose = channel.onClose(untapAll);
  const offProtocol = channel.onProtocolError(kernel, (error) => {
    internals.report(error);
  });
  return () => {
    for (const remove of removers) remove();
    offClose();
    offProtocol();
    untapAll();
  };
}
