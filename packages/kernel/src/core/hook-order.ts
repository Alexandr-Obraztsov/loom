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

/** Owner rank used to break ties; absent, every owner ranks the same and registration order decides. */
export type RankOf = (owner: string) => number;
const NO_RANK: RankOf = () => 0;

/** Min-heap of rank indexes (rank 0 = highest priority, lowest owner rank, earliest registration). */
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

/** Constraint DAG over indexes into the plain-sorted taps, plus the edges dropped for closing a cycle. */
interface EdgeSet<T extends Orderable> {
  readonly indexOf: Map<T, number>;
  readonly succ: number[][];
  readonly seen: Set<string>;
  readonly dropped: Map<string, readonly [T, T]>;
}

function reaches(succ: readonly (readonly number[])[], from: number, to: number): boolean {
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
}

/** `holder` declared that it runs `direction` (`before` or `after`) `other`. */
interface Constraint<T> {
  readonly holder: T;
  readonly other: T;
  readonly direction: "before" | "after";
}

/** Adds the constraint's edge, or drops it if it would close a cycle. */
function considerEdge<T extends Orderable>(edges: EdgeSet<T>, constraint: Constraint<T>): void {
  const { holder, other, direction } = constraint;
  const from = direction === "before" ? holder : other;
  const to = direction === "before" ? other : holder;
  const key = `${String(from.seq)}>${String(to.seq)}`;
  if (from === to || edges.seen.has(key) || edges.dropped.has(key)) return;
  const f = edges.indexOf.get(from) as number;
  const t = edges.indexOf.get(to) as number;
  if (reaches(edges.succ, t, f)) edges.dropped.set(key, [holder, other]);
  else {
    edges.seen.add(key);
    edges.succ[f]?.push(t);
  }
}

function groupByOwner<T extends Orderable>(taps: readonly T[]): Map<string, T[]> {
  const byOwner = new Map<string, T[]>();
  for (const t of taps) {
    const list = byOwner.get(t.owner);
    if (list) list.push(t);
    else byOwner.set(t.owner, [t]);
  }
  return byOwner;
}

/** Kahn's algorithm: the lowest rank index with no unmet predecessor goes next. */
function topologicalOrder<T>(ranked: readonly T[], succ: readonly (readonly number[])[]): T[] {
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
  return order;
}

/**
 * Builds the order from scratch: constraint edges are added greedily in (owner rank, registration)
 * order of the declaring tap (its `before` entries, then `after`); an edge that would close a cycle
 * is dropped. Kahn's algorithm with a priority queue then orders the DAG (priority desc, then owner
 * rank, then registration).
 */
export function arrange<T extends Orderable>(
  taps: readonly T[],
  rankOf: RankOf = NO_RANK,
): Arranged<T> {
  // owner ranks are looked up once per tap, not once per comparison
  const rank = new Map<T, number>(taps.map((t) => [t, rankOf(t.owner)]));
  const rankDiff = (a: T, b: T): number => (rank.get(a) as number) - (rank.get(b) as number);
  const ranked = taps
    .slice()
    .sort((a, b) => b.priority - a.priority || rankDiff(a, b) || a.seq - b.seq);
  const declaring =
    rankOf === NO_RANK ? taps : taps.slice().sort((a, b) => rankDiff(a, b) || a.seq - b.seq);
  const edges: EdgeSet<T> = {
    indexOf: new Map<T, number>(ranked.map((t, i) => [t, i])),
    succ: ranked.map(() => []),
    seen: new Set<string>(),
    dropped: new Map<string, readonly [T, T]>(),
  };
  const byOwner = groupByOwner(taps);
  for (const t of declaring) {
    for (const o of t.before)
      for (const u of byOwner.get(o) ?? [])
        considerEdge(edges, { holder: t, other: u, direction: "before" });
    for (const o of t.after)
      for (const u of byOwner.get(o) ?? [])
        considerEdge(edges, { holder: t, other: u, direction: "after" });
  }
  return { order: topologicalOrder(ranked, edges.succ), dropped: edges.dropped };
}
