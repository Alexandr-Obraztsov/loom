import type { ReactNode } from "react";
import type { SessionItem, SessionSnapshot } from "@loom/plugin-acp";
import { createHook, createServiceRef } from "@loom/sdk";
import type { HookRef, ServiceRef } from "@loom/sdk";

/**
 * Живое состояние сеанса для композера и других потребителей.
 * Обновляется экраном чата; подписчики перерисовываются через subscribe.
 */
export interface ChatSession {
  snapshot(): SessionSnapshot | undefined;
  sessionId(): string | undefined;
  subscribe(fn: () => void): () => void;
}

export const ChatSessionRef: ServiceRef<ChatSession> = createServiceRef<ChatSession>(
  "chat.session",
);

export interface RenderItemContext {
  item: SessionItem;
}

/**
 * Отрисовка элемента ленты. Режим sync: тап возвращает готовый ReactNode
 * (вернуть Promise — ошибка валидации), по цепочке до дефолтного рендерера.
 */
export const RenderItemHook: HookRef<RenderItemContext, ReactNode> = createHook<
  RenderItemContext,
  ReactNode
>("chat.renderItem", { mode: "sync" });
