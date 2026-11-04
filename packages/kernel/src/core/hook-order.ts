/** What the ordering needs to know about a tap. */
export interface Orderable {
  readonly owner: string;
  readonly priority: number;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly seq: number;
}

export interface Arranged<T extends Orderable> {
  readonly order: T[];
  /** Dropped edges by key, as [declaring tap, other tap]. */
  readonly dropped: Map<string, readonly [T, T]>;
}

function compareRank(a: Orderable, b: Orderable): number {
  return b.priority - a.priority || a.seq - b.seq;
}

/** Min-heap of rank indexes (rank 0 = highest priority, earliest registration). */
class RankHeap {
  private readonly items: number[] = [];
  push(v: number): void {
    const h = this.items;
    let i = h.push(v) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((h[parent] as number) <= v) break;
      h[i] = h[parent] as number;
      i = parent;
    }
    h[i] = v;
  }
  pop(): number | undefined {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (top === undefined || last === undefined || h.length === 0) return top;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= h.length) break;
      if (c + 1 < h.length && (h[c + 1] as number) < (h[c] as number)) c++;
      if ((h[c] as number) >= last) break;
      h[i] = h[c] as number;
      i = c;
    }
    h[i] = last;
    return top;
  }
}

/**
 * Builds the order from scratch: constraint edges are added greedily in registration order of the
 * declaring tap (its `before` entries, then `after`); an edge that would close a cycle is dropped.
 * Kahn's algorithm with a priority queue then orders the DAG (priority desc, then registration).
 */
export function arrange<T extends Orderable>(taps: readonly T[]): Arranged<T> {
  const ranked = taps.slice().sort(compareRank);
  const rankOf = new Map<T, number>(ranked.map((t, i) => [t, i]));
  const byOwner = new Map<string, T[]>();
  for (const t of taps) byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t]);
  const succ: number[][] = ranked.map(() => []);
  const seen = new Set<string>();
  const dropped = new Map<string, readonly [T, T]>();
  const reaches = (from: number, to: number): boolean => {
    const stack = [from];
    const visited = new Set<number>(stack);
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (n === to) return true;
      for (const m of succ[n] ?? []) {
        if (visited.has(m)) continue;
        visited.add(m);
        stack.push(m);
      }
    }
    return false;
  };
  const consider = (holder: T, other: T, from: T, to: T): void => {
    const key = `${String(from.seq)}>${String(to.seq)}`;
    if (from === to || seen.has(key) || dropped.has(key)) return;
    const [f, t] = [rankOf.get(from) as number, rankOf.get(to) as number];
    if (reaches(t, f)) dropped.set(key, [holder, other]);
    else {
      seen.add(key);
      succ[f]?.push(t);
    }
  };
  for (const t of taps) {
    for (const o of t.before) for (const u of byOwner.get(o) ?? []) consider(t, u, t, u);
    for (const o of t.after) for (const u of byOwner.get(o) ?? []) consider(t, u, u, t);
  }
  const indegree = ranked.map(() => 0);
  for (const targets of succ) for (const m of targets) indegree[m] = (indegree[m] ?? 0) + 1;
  const heap = new RankHeap();
  indegree.forEach((d, i) => {
    if (d === 0) heap.push(i);
  });
  const order: T[] = [];
  for (let r = heap.pop(); r !== undefined; r = heap.pop()) {
    order.push(ranked[r] as T);
    for (const m of succ[r] ?? []) {
      indegree[m] = (indegree[m] ?? 0) - 1;
      if (indegree[m] === 0) heap.push(m);
    }
  }
  return { order, dropped };
}
