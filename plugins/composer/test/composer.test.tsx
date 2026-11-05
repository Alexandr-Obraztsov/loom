import { act, cleanup, createEvent, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { bootChat, disposeKernels, renderApp, settle } from "../../chat/test/boot.js";
import composer from "../src/renderer.js";
import { FakeSessions } from "./fixtures.js";

afterEach(async () => {
  cleanup();
  await disposeKernels();
});

/** Готовый к работе композер: сеанс запущен, поле активно. */
async function bootReady(sessions: FakeSessions): Promise<void> {
  const kernel = await bootChat(sessions, [composer]);
  renderApp(kernel);
  await settle();
}

function field(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>("Сообщение");
}

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(field(), { target: { value: text } });
    await Promise.resolve();
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(field(), { key: "Enter" });
    await Promise.resolve();
  });
}

/** Переключает busy сеанса и ждёт перерисовки композера. */
async function setBusy(sessions: FakeSessions, isBusy: boolean): Promise<void> {
  await act(async () => {
    sessions.emit((s) => ({ ...s, busy: isBusy }));
    await Promise.resolve();
  });
}

describe("composer: отправка", () => {
  it("Enter отправляет обрезанный текст и очищает поле", async () => {
    const sessions = new FakeSessions();
    await bootReady(sessions);
    await type("  привет  ");
    const plain = createEvent.keyDown(field(), { key: "Enter" });
    fireEvent(field(), plain);
    await act(async () => {
      await Promise.resolve();
    });
    expect(plain.defaultPrevented).toBe(true);
    expect(sessions.prompts).toEqual([["s1", "привет"]]);
    expect(field().value).toBe("");
  });

  it("многострочный текст уходит целиком", async () => {
    const sessions = new FakeSessions();
    await bootReady(sessions);
    await type("первая\nвторая");
    await pressEnter();
    expect(sessions.prompts).toEqual([["s1", "первая\nвторая"]]);
    expect(field().value).toBe("");
  });

  it("Shift+Enter и прочие клавиши не отправляют и не глушат ввод", async () => {
    const sessions = new FakeSessions();
    await bootReady(sessions);
    await type("текст");
    const shift = createEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    fireEvent(field(), shift);
    const letter = createEvent.keyDown(field(), { key: "a" });
    fireEvent(field(), letter);
    expect(shift.defaultPrevented).toBe(false);
    expect(letter.defaultPrevented).toBe(false);
    expect(sessions.prompts).toEqual([]);
    expect(field().value).toBe("текст");
  });

  it("пустой и пробельный текст не отправляется", async () => {
    const sessions = new FakeSessions();
    await bootReady(sessions);
    await type("   ");
    await pressEnter();
    expect(sessions.prompts).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field().value).toBe("   ");
  });
});

describe("composer: отказы отправки", () => {
  it("пока prompt в полёте, повторная отправка невозможна", async () => {
    const sessions = new FakeSessions();
    sessions.lockPrompt();
    await bootReady(sessions);
    await type("вопрос");
    await pressEnter();
    expect(sessions.prompts).toEqual([["s1", "вопрос"]]);
    await pressEnter(); // второй Enter — отправка не уходит
    expect(sessions.prompts).toHaveLength(1);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Отправить" });
    expect(button.disabled).toBe(true);
    sessions.releasePrompt();
    await act(async () => {
      await Promise.resolve();
    });
    expect(field().value).toBe("");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Отправить" }).disabled).toBe(
      false,
    );
  });

  it("черновик, набранный во время ответа, переживает конец хода", async () => {
    const sessions = new FakeSessions();
    sessions.lockPrompt();
    await bootReady(sessions);
    await type("первый");
    await pressEnter();
    expect(field().value).toBe("");
    await type("черновик");
    sessions.releasePrompt();
    await act(async () => {
      await Promise.resolve();
    });
    expect(field().value).toBe("черновик");
  });

  it("отказ prompt не затирает новый черновик", async () => {
    const sessions = new FakeSessions();
    sessions.lockPrompt();
    sessions.promptError = new Error("Агент завершился");
    await bootReady(sessions);
    await type("первый");
    await pressEnter();
    await type("второй");
    sessions.releasePrompt();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Не удалось отправить: Агент завершился",
    );
    expect(field().value).toBe("второй");
  });

  it("отказ prompt сохраняет текст и показывает ошибку; повтор успешен", async () => {
    const sessions = new FakeSessions();
    sessions.promptError = new Error("Сессия занята");
    await bootReady(sessions);
    await type("вопрос");
    await pressEnter();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Не удалось отправить: Сессия занята",
    );
    expect(field().value).toBe("вопрос");
    await pressEnter();
    expect(sessions.prompts).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field().value).toBe("");
  });

  it("не-Error отказ показывается строковым видом", async () => {
    const sessions = new FakeSessions();
    sessions.promptError = "потеря связи";
    await bootReady(sessions);
    await type("вопрос");
    await pressEnter();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Не удалось отправить: потеря связи",
    );
    expect(field().value).toBe("вопрос");
  });
});

describe("composer: занятость и остановка", () => {
  it("пока агент занят, вместо Отправить — Стоп, Enter не отправляет", async () => {
    const sessions = new FakeSessions();
    await bootReady(sessions);
    await type("вопрос");
    await setBusy(sessions, true);
    expect(screen.queryByRole("button", { name: "Отправить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Стоп" })).toBeTruthy();
    await pressEnter();
    expect(sessions.prompts).toEqual([]);
    expect(field().value).toBe("вопрос");
    await setBusy(sessions, false);
    expect(screen.getByRole("button", { name: "Отправить" })).toBeTruthy();
  });

  it("Стоп вызывает cancel с идентификатором сеанса", async () => {
    const sessions = new FakeSessions();
    await bootReady(sessions);
    await setBusy(sessions, true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Стоп" }));
      await Promise.resolve();
    });
    expect(sessions.cancels).toEqual(["s1"]);
  });

  it("отказ cancel не ломает композер", async () => {
    const sessions = new FakeSessions();
    sessions.cancelError = new Error("нет связи");
    await bootReady(sessions);
    await setBusy(sessions, true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Стоп" }));
      await Promise.resolve();
    });
    expect(sessions.cancels).toEqual(["s1"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("composer: запуск сеанса", () => {
  it("до готовности сеанса поле неактивно, кнопок нет", async () => {
    const sessions = new FakeSessions();
    sessions.lockEnsure();
    const kernel = await bootChat(sessions, [composer]);
    renderApp(kernel);
    await settle();
    const input = field();
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("placeholder")).toBe("Сессия запускается…");
    expect(screen.queryByRole("button", { name: "Отправить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Стоп" })).toBeNull();
    sessions.releaseEnsure();
    await settle();
    expect(field().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Отправить" })).toBeTruthy();
  });
});
