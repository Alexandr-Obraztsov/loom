import type { Sessions, SessionSnapshot } from "@loom/plugin-acp";
import { SessionsRef } from "@loom/plugin-acp";
import { Render, useHookRunner, useService } from "@loom/react";
import type { ResolvedNode, ServiceRef } from "@loom/sdk";
import { createServiceRef, HostRef } from "@loom/sdk";
import type { ReactNode, Ref, UIEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ChatSession, RenderItemContext } from "./api.js";
import { RenderItemHook } from "./api.js";
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
      // сначала выход: отказ, пришедший после размонтирования, не трогает экран
      if (deps.isDisposed()) return;
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

/** Значение-узел входа расширения (не массив и не undefined). */
function isNode(value: unknown): value is ResolvedNode {
  return typeof value === "object" && value !== null && "id" in value && "pluginId" in value;
}

/** Одиночный вход расширения; неподходящее значение игнорируется. */
function singleInput(node: ResolvedNode, input: string): ResolvedNode | undefined {
  const value: unknown = node.inputs[input];
  return isNode(value) ? value : undefined;
}

/** Многократный вход расширения; неподходящее значение считается пустым. */
function multiInput(node: ResolvedNode, input: string): readonly ResolvedNode[] {
  const value: unknown = node.inputs[input];
  return Array.isArray(value) ? (value as readonly ResolvedNode[]) : [];
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
  const [failedRespondItemId, setFailedRespondItemId] = useState<string | undefined>(undefined);
  const respond = (itemId: string, optionId: string): void => {
    setFailedRespondItemId(undefined);
    // отказ виден в самой карточке: разрешение остаётся ждать ответа, повтор доступен
    void sessions.respondPermission(snapshot.sessionId, itemId, optionId).catch(() => {
      setFailedRespondItemId(itemId);
    });
  };
  return (
    <>
      <ul>
        {snapshot.items.map((item) => (
          <li key={item.id} data-item={item.id} data-kind={item.kind}>
            {runItem({ item }, (c) => renderDefaultItem(c.item, { respond, failedRespondItemId }))}
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
  const [isOffline, setOffline] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const subscribe = useCallback((notify: () => void) => driver.subscribe(notify), [driver]);
  const snapshot = useSyncExternalStore(subscribe, () => driver.snapshot());
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Прокси сервисов живые (ведут к текущей реализации), но их идентичность меняется
  // от рендера к рендеру — цикл опроса живёт ровно пока смонтирован экран.
  // Зависший waitUpdates при размонтировании не отменяется (long-poll): цикл просто
  // выйдет по флагу, когда ответ придёт. В StrictMode эффект монтируется дважды —
  // первый цикл выходит на ближайшей проверке, ensure идемпотентен (сессия на окно одна).
  useEffect(() => {
    let isDisposed = false;
    void runSession({
      sessions,
      driver,
      projectDir: host.projectDir,
      isDisposed: () => isDisposed,
      onOffline: setOffline,
    }).catch((e: unknown) => {
      if (isDisposed) return;
      setFatal(e instanceof Error ? e.message : String(e));
    });
    return () => {
      isDisposed = true;
    };
  }, []);

  // пока пользователь у низа, новые элементы прокручивают ленту вниз
  useLayoutEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView();
  }, [snapshot?.seq]);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    stick.current = isPinned(e.currentTarget);
  };

  return (
    <section aria-label="Чат">
      {isOffline ? <div role="alert">Не удалось получить обновления</div> : null}
      <div onScroll={onScroll} data-timeline="">
        {fatal === undefined && snapshot !== undefined ? (
          <TimelineItems snapshot={snapshot} runItem={runItem} endRef={endRef} />
        ) : null}
        {fatal !== undefined ? (
          <ul>
            <li data-item="fatal">
              {renderDefaultItem(
                { kind: "error", id: "fatal", message: fatal },
                { respond: () => undefined, failedRespondItemId: undefined },
              )}
            </li>
          </ul>
        ) : null}
      </div>
      {multiInput(node, "inline").map((n) => (
        <Render key={n.id} node={n} />
      ))}
      <Render node={singleInput(node, "composer")} />
    </section>
  );
}
