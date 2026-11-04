import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "@loom/kernel";
import type { PluginDefinition } from "@loom/kernel";
import { attach } from "@loom/sdk";
import type { ReactNode } from "react";
import type { SessionItem } from "@loom/plugin-acp";
import { RenderItemHook } from "../src/api.js";
import { isPinned } from "../src/timeline.js";
import { FakeSessions, agent, thought, tool, user } from "./fixtures.js";
import { applyUpdate, bootChat, disposeKernels, renderApp } from "./boot.js";

afterEach(async () => {
  cleanup();
  await disposeKernels();
});

const permission = (id: string, resolved?: string): SessionItem => ({
  kind: "permission",
  id,
  title: "Запуск команды",
  options: [
    { optionId: "allow", name: "Разрешить", kind: "allow" },
    { optionId: "reject", name: "Отклонить", kind: "reject" },
  ],
  ...(resolved === undefined ? {} : { resolved }),
});

describe("chat: разрешение и ошибки", () => {
  it("кнопки разрешения вызывают respondPermission с optionId, затем виден исход", async () => {
    const sessions = new FakeSessions();
    sessions.failRespondTimes = 1; // первый отклик теряется — молча, без краха
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, permission("p1")] }));
    await screen.findByText("Запуск команды");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Разрешить" }));
      await Promise.resolve();
    });
    expect(sessions.responses).toEqual([["s1", "p1", "allow"]]);
    expect(await screen.findByText("Выбрано: Разрешить")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
  });

  it("отменённое и неизвестное разрешения показывают исход без кнопок", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({
      ...s,
      items: [...s.items, permission("p1", "cancelled")],
    }));
    expect(await screen.findByText("Отменено")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, permission("p2", "gone")] }));
    expect(await screen.findByText("Выбрано: gone")).toBeTruthy();
  });

  it("элемент-ошибка показывает сообщение, stderr и подсказку", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({
      ...s,
      items: [
        ...s.items,
        {
          kind: "error",
          id: "e1",
          message: "Агент «Claude Code» завершился: код 1",
          stderr: "Error: boom\n    at f",
        },
      ],
    }));
    expect(await screen.findByText(/завершился/)).toBeTruthy();
    expect(screen.getByText(/Error: boom/)).toBeTruthy();
    expect(screen.getByText("Вывод процесса")).toBeTruthy();
    expect(screen.getByText("Отправьте сообщение ещё раз, чтобы повторить")).toBeTruthy();
  });
});

describe("chat: лента", () => {
  it("тап RenderItemHook подменяет отрисовку своего элемента", async () => {
    const sessions = new FakeSessions();
    const tapper: PluginDefinition = definePlugin({
      id: "tapper",
      version: "1.0.0",
      dependsOn: { chat: "^0.1.0" },
      setup(ctx) {
        ctx.tap(
          RenderItemHook,
          { match: (c) => c.item.kind === "agent" },
          (c, next) => (c.item.kind === "agent" ? <b data-tapped>{`>${c.item.text}<`}</b> : next(c)),
        );
      },
    });
    const kernel = await bootChat(sessions, [tapper]);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({
      ...s,
      items: [...s.items, user("u1", "вопрос"), agent("a1", "ответ")],
    }));
    expect(await screen.findByText(">ответ<")).toBeTruthy();
    expect(screen.getByText("вопрос")).toBeTruthy();
  });

  it("сообщение агента в 100 000 символов — один элемент с pre-wrap", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    const big = "д".repeat(100_000);
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a1", big)] }));
    const text = await screen.findByText(big);
    expect(text.getAttribute("style")).toContain("pre-wrap");
    const list = text.closest("ul");
    expect(list).toBeTruthy();
    expect(list?.querySelectorAll("li[data-item]")).toHaveLength(1);
    expect(text.textContent).toHaveLength(100_000);
  });

  it("элементы-инструменты и размышления отрисовываются", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    renderApp(kernel);
    await applyUpdate(sessions, (s) => ({
      ...s,
      items: [
        ...s.items,
        tool("t1", "Чтение файла", "in_progress", "src/index.ts"),
        tool("t2", "Поиск в файлах", "pending"),
        thought("h1", "изучаю файл"),
      ],
    }));
    expect(await screen.findByText("Чтение файла")).toBeTruthy();
    expect(screen.getByText("выполняется")).toBeTruthy();
    expect(screen.getByText("src/index.ts")).toBeTruthy();
    expect(screen.getByText("Поиск в файлах")).toBeTruthy();
    expect(screen.getByText("ожидает")).toBeTruthy();
    expect(screen.getByText("изучаю файл")).toBeTruthy();
  });
});

describe("chat: автопрокрутка", () => {
  it("лента следует за низом, пока пользователь у низа", async () => {
    const sessions = new FakeSessions();
    const kernel = await bootChat(sessions);
    const view = renderApp(kernel);
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, user("u1", "один")] }));
    const end = await screen.findByText("один").then(() =>
      view.container.querySelector("[data-end]"),
    );
    expect(end).toBeTruthy();
    const scrolls: number[] = [];
    (end as HTMLElement).scrollIntoView = () => {
      scrolls.push(0);
    };
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a1", "два")] }));
    expect(scrolls).toHaveLength(1); // пользователь у низа — прокрутили
    const box = view.container.querySelector("[data-timeline]") as HTMLElement;
    box.scrollTop = -100; // в happy-dom нет layout: прокрутка вверх — отрицательный остаток
    await act(async () => {
      fireEvent.scroll(box);
      await Promise.resolve();
    });
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a2", "три")] }));
    expect(scrolls).toHaveLength(1); // пользователь выше — не дёргаем
    box.scrollTop = 0;
    await act(async () => {
      fireEvent.scroll(box);
      await Promise.resolve();
    });
    await applyUpdate(sessions, (s) => ({ ...s, items: [...s.items, agent("a3", "четыре")] }));
    expect(scrolls).toHaveLength(2); // вернулся к низу — снова следим
  });

  it("isPinned: у низа — да, выше 40px — нет", () => {
    expect(isPinned({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 })).toBe(true);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 860, clientHeight: 100 })).toBe(true);
    expect(isPinned({ scrollHeight: 1000, scrollTop: 859, clientHeight: 100 })).toBe(false);
  });
});

describe("chat: раскладка экрана", () => {
  it("инлайны идут после ленты, композер — внизу", async () => {
    const sessions = new FakeSessions();
    const Composer = (): ReactNode => <form data-composer>composer body</form>;
    const Inline = (): ReactNode => <aside data-inline>inline body</aside>;
    const extras: PluginDefinition = definePlugin({
      id: "extras",
      version: "1.0.0",
      dependsOn: { chat: "^0.1.0" },
      extensions: [
        attach("app/screens/chat", "composer", { id: "main", component: Composer }),
        attach("app/screens/chat", "inline", { id: "hint", component: Inline }),
      ],
    });
    const kernel = await bootChat(sessions, [extras]);
    const view = renderApp(kernel);
    const timeline = await screen.findByRole("region", { name: "Чат" });
    expect(timeline.querySelector("[data-timeline]")).toBeTruthy();
    const composer = view.container.querySelector("[data-composer]");
    const inline = view.container.querySelector("[data-inline]");
    expect(composer).toBeTruthy();
    expect(inline).toBeTruthy();
    expect(
      timeline.compareDocumentPosition(inline as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (inline as Node).compareDocumentPosition(composer as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
