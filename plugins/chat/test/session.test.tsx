import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSessionRef } from "../src/api.js";
import { FakeSessions, agent, user } from "./fixtures.js";
import { PROJECT_DIR, applyUpdate, bootChat, disposeKernels, renderApp, settle } from "./boot.js";

afterEach(async () => {
  cleanup();
  await disposeKernels();
});

describe("chat: сеанс", () => {
  it("ensure вызывается с claude-code и каталогом проекта", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await settle();
    expect(sessions.ensureCalls).toEqual([{ agentId: "claude-code", cwd: PROJECT_DIR }]);
  });

  it("обновления отображаются по порядку", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, user("u1", "запрос")] }));
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a1", "ответ")] }));
    const first = screen.getByText("запрос");
    const second = screen.getByText("ответ");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ChatSessionRef отдаёт живой снимок и sessionId", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({
      ...s,
      busy: true,
      items: [...s.items, user("u1", "привет")],
    }));
    await screen.findByText("привет");
    const session = kernel.services.use(ChatSessionRef);
    expect(session.sessionId()).toBe("s1");
    expect(session.snapshot()?.busy).toBe(true);
    expect(session.snapshot()?.items.map((i) => i.id)).toEqual(["u1"]);
    let notified = 0;
    const off = session.subscribe(() => {
      notified += 1;
    });
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a1", "ответ")] }));
    await screen.findByText("ответ");
    expect(notified).toBe(1);
    off();
  });
});

describe("chat: остановка", () => {
  it("размонтирование останавливает опрос", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    const view = renderApp(kernel);
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, user("u1", "привет")] }));
    await screen.findByText("привет");
    const calls = sessions.waitCalls;
    const seq = kernel.services.use(ChatSessionRef).snapshot()?.seq;
    view.unmount();
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a1", "ответ")] }));
    expect(sessions.waitCalls).toBe(calls);
    expect(kernel.services.use(ChatSessionRef).snapshot()?.seq).toBe(seq);
  });

  it("размонтирование до ответа ensure не трогает хранилище", async () => {
    const sessions = new FakeSessions();
    sessions.lockEnsure();
    const kernel = await bootChat(sessions);
    const view = renderApp(kernel);
    view.unmount();
    sessions.releaseEnsure();
    await settle();
    expect(sessions.waitCalls).toBe(0);
    expect(kernel.services.use(ChatSessionRef).snapshot()).toBeUndefined();
  });

  it("размонтирование во время задержки повтора останавливает цикл", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new FakeSessions();
      sessions.failWaitTimes = 1;
      const kernel = await bootChat(sessions);
      const view = renderApp(kernel);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sessions.waitCalls).toBe(1); // опрос упал, ждёт 1 с
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(sessions.waitCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chat: сбои", () => {
  it("сбой ensure показывается элементом-ошибкой, опрос не начинается", async () => {
    const sessions = new FakeSessions();
    sessions.ensureError = new Error("Не удалось запустить агента «Claude Code»: код 1");
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    expect(await screen.findByText(/Не удалось запустить агента/)).toBeTruthy();
    expect(screen.getByText("Отправьте сообщение ещё раз, чтобы повторить")).toBeTruthy();
    expect(sessions.waitCalls).toBe(0);
  });

  it("не-Error отказ ensure показывается строковым видом", async () => {
    const sessions = new FakeSessions();
    sessions.ensureError = "агент недоступен";
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    expect(await screen.findByText("агент недоступен")).toBeTruthy();
  });

  it("сбой опроса показывает баннер и повторяет с задержкой 1с/2с/5с", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new FakeSessions();
      sessions.failWaitTimes = 3;
      const kernel = await bootChat(sessions);
      renderApp(kernel);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sessions.waitCalls).toBe(1);
      expect(screen.getByRole("alert").textContent).toBe("Не удалось получить обновления");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(sessions.waitCalls).toBe(1); // прошёл не весь 1 с
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(sessions.waitCalls).toBe(2); // повтор через 1 с
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sessions.waitCalls).toBe(3); // повтор через 2 с
      await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, user("u1", "привет")] }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4999);
      });
      expect(sessions.waitCalls).toBe(3); // прошёл не весь 5 с
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(sessions.waitCalls).toBe(5); // успех и следующий опрос
      expect(screen.getByText("привет")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
