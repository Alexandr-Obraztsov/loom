import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode, Ref, UIEvent } from "react";
import { HostRef } from "@loom/host";
import { SessionsRef } from "@loom/plugin-acp";
import type { SessionSnapshot, Sessions } from "@loom/plugin-acp";
import { createServiceRef } from "@loom/sdk";
import type { ResolvedNode, ServiceRef } from "@loom/sdk";
import { Render, useHookRunner, useService } from "@loom/react";
import { RenderItemHook } from "./api.js";
import type { ChatSession, RenderItemContext } from "./api.js";
import { renderDefaultItem } from "./items.js";

/** Внутренняя ручка экрана чата: публичный ChatSession плюс запись снимков. */
export interface ChatSessionDriver extends ChatSession {
  update(snapshot: SessionSnapshot): void;
}

/** Хранится тем же объектом, что и {@link ChatSessionRef} (см. api.ts). */
export const ChatSessionDriverRef: ServiceRef<ChatSessionDriver> =
  createServiceRef<ChatSessionDriver>("chat.session.driver");

export function createChatSession(): ChatSessionDriver {
  let current: SessionSnapshot | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => current,
    sessionId: () => current?.sessionId,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    update(snapshot: SessionSnapshot): void {
      current = snapshot;
      for (const fn of listeners) fn();
    },
  };
}

/** Задержки повтора после сбоя транспорта: 1с, 2с, дальше 5с. */
function backoffMs(failures: number): number {
  if (failures <= 0) return 1000;
  if (failures === 1) return 2000;
  return 5000;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface SessionLoopDeps {
  readonly sessions: Sessions;
  readonly driver: ChatSessionDriver;
  readonly projectDir: string;
  readonly isDisposed: () => boolean;
  readonly onOffline: (offline: boolean) => void;
}

/** ensure → бесконечный waitUpdates; выходит, когда isDisposed() стал true. */
async function runSession(deps: SessionLoopDeps): Promise<void> {
  const first = await deps.sessions.ensure({ agentId: "claude-code", cwd: deps.projectDir });
  if (deps.isDisposed()) return;
  deps.driver.update(first);
  let seq = first.seq;
  let failures = 0;
  for (;;) {
    let next: SessionSnapshot;
    try {
      next = await deps.sessions.waitUpdates(first.sessionId, seq);
    } catch {
      deps.onOffline(true);
      await sleep(backoffMs(failures));
      failures += 1;
      if (deps.isDisposed()) return;
      continue;
    }
    if (deps.isDisposed()) return;
    failures = 0;
    deps.onOffline(false);
    deps.driver.update(next);
    seq = next.seq;
  }
}

/** Порог «пользователь у низа»: дальше от низа автопрокрутка выключена. */
const STICK_PX = 40;

export function isPinned(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
}

type RunItem = (ctx: RenderItemContext, fallback: (c: RenderItemContext) => ReactNode) => ReactNode;

/** Лента снимка: список по элементам и метка низа для автопрокрутки. */
function TimelineItems(props: { snapshot: SessionSnapshot; runItem: RunItem; endRef: Ref<HTMLDivElement> }): ReactNode {
  const { snapshot, runItem, endRef } = props;
  const sessions = useService(SessionsRef);
  const respond = (itemId: string, optionId: string): void => {
    // потеря отклика видна как сбой ближайшего waitUpdates (баннер), поэтому глотаем
    void sessions.respondPermission(snapshot.sessionId, itemId, optionId).catch(() => undefined);
  };
  return (
    <>
      <ul>
        {snapshot.items.map((item) => (
          <li key={item.id} data-item={item.id} data-kind={item.kind}>
            {runItem({ item }, (c) => renderDefaultItem(c.item, { respond }))}
          </li>
        ))}
      </ul>
      {snapshot.items.length > 0 ? <div data-end="" ref={endRef} /> : null}
    </>
  );
}

export function ChatView(props: { node: ResolvedNode }): ReactNode {
  const { node } = props;
  const sessions = useService(SessionsRef);
  const host = useService(HostRef);
  const driver = useService(ChatSessionDriverRef);
  const runItem = useHookRunner(RenderItemHook);
  const [offline, setOffline] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const subscribe = useCallback((notify: () => void) => driver.subscribe(notify), [driver]);
  const snapshot = useSyncExternalStore(subscribe, () => driver.snapshot());
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // прокси сервисов живые (ведут к текущей реализации), но их идентичность
  // меняется от рендера к рендеру — цикл опроса живёт ровно пока смонтирован экран
  useEffect(() => {
    let disposed = false;
    void runSession({
      sessions,
      driver,
      projectDir: host.projectDir,
      isDisposed: () => disposed,
      onOffline: setOffline,
    }).catch((e: unknown) => {
      if (disposed) return;
      setFatal(e instanceof Error ? e.message : String(e));
    });
    return () => {
      disposed = true;
    };
  }, []);

  // пока пользователь у низа, новые элементы прокручивают ленту вниз
  useLayoutEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView();
  }, [snapshot?.seq]);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    stick.current = isPinned(e.currentTarget);
  };

  const inline = node.inputs.inline as readonly ResolvedNode[] | undefined;
  const composer = node.inputs.composer as ResolvedNode | undefined;
  return (
    <section aria-label="Чат">
      {offline ? <div role="alert">Не удалось получить обновления</div> : null}
      <div onScroll={onScroll} data-timeline="">
        {fatal === undefined && snapshot !== undefined ? (
          <TimelineItems snapshot={snapshot} runItem={runItem} endRef={endRef} />
        ) : null}
        {fatal !== undefined ? (
          <ul>
            <li data-item="fatal">
              {renderDefaultItem(
                { kind: "error", id: "fatal", message: fatal },
                { respond: () => undefined },
              )}
            </li>
          </ul>
        ) : null}
      </div>
      {inline?.map((n) => (
        <Render key={n.id} node={n} />
      ))}
      <Render node={composer} />
    </section>
  );
}
