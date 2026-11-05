import type { LoomError } from "../core/errors.js";

interface Sink {
  readonly cb: (error: LoomError) => void;
  count: number;
}

/**
 * The receivers of an endpoint's protocol errors. Registrations under one key share a sink
 * (reference counted). Every registrant belongs to the one kernel of its side of the endpoint,
 * so reporting to all of them would raise the same `kernel.error` several times: only the oldest
 * registered sink reports, and the next one takes over when it is removed.
 */
export class ProtocolSinks {
  private readonly sinks = new Map<object, Sink>();

  add(key: object, cb: (error: LoomError) => void): () => void {
    const sink = this.sinks.get(key) ?? { cb, count: 0 };
    sink.count++;
    this.sinks.set(key, sink);
    return () => {
      if (--sink.count === 0 && this.sinks.get(key) === sink) this.sinks.delete(key);
    };
  }

  /** Delivers `error` to `options.onProtocolError` and the oldest sink; false when nobody received it. */
  report(error: LoomError, options: { onProtocolError?(error: LoomError): void }): boolean {
    const first = this.sinks.values().next();
    const receivers: ((error: LoomError) => void)[] = [];
    if (options.onProtocolError) receivers.push((e) => options.onProtocolError?.(e));
    if (!first.done) receivers.push(first.value.cb);
    for (const cb of receivers) {
      try {
        cb(error);
      } catch {
        // a failing sink must not throw into the transport
      }
    }
    return receivers.length > 0;
  }
}
