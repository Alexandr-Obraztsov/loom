import type { CSSProperties, ReactNode } from "react";
import type { PermissionOptionView, SessionItem } from "@loom/plugin-acp";

type ToolItem = Extract<SessionItem, { kind: "tool" }>;
type PermissionItem = Extract<SessionItem, { kind: "permission" }>;
type ErrorItem = Extract<SessionItem, { kind: "error" }>;

/** Длинный текст — один элемент с сохранением переводов строк. */
const PRE_WRAP: CSSProperties = { whiteSpace: "pre-wrap" };

const TOOL_STATUS: Record<ToolItem["status"], string> = {
  pending: "ожидает",
  in_progress: "выполняется",
  completed: "готово",
  failed: "ошибка",
};

/** Что элементу-разрешению нужно от окружения экрана. */
export interface ItemActions {
  respond(itemId: string, optionId: string): void;
}

/** Дефолтный рендер элемента; fallback хука chat.renderItem. */
export function renderDefaultItem(item: SessionItem, actions: ItemActions): ReactNode {
  switch (item.kind) {
    case "user":
    case "agent":
    case "thought":
      return <div style={PRE_WRAP}>{item.text}</div>;
    case "tool":
      return <ToolItemView item={item} />;
    case "permission":
      return <PermissionItemView item={item} actions={actions} />;
    case "error":
      return <ErrorItemView item={item} />;
  }
}

function ToolItemView(props: { item: ToolItem }): ReactNode {
  const { item } = props;
  return (
    <div data-tool={item.status}>
      <p>{item.title}</p>
      <p>{TOOL_STATUS[item.status]}</p>
      {item.detail === undefined ? null : <div style={PRE_WRAP}>{item.detail}</div>}
    </div>
  );
}

function outcomeOf(resolved: string, options: readonly PermissionOptionView[]): string {
  if (resolved === "cancelled") return "Отменено";
  const name = options.find((o) => o.optionId === resolved)?.name ?? resolved;
  return `Выбрано: ${name}`;
}

function PermissionItemView(props: { item: PermissionItem; actions: ItemActions }): ReactNode {
  const { item, actions } = props;
  if (item.resolved !== undefined) {
    return <p data-permission={item.resolved}>{outcomeOf(item.resolved, item.options)}</p>;
  }
  return (
    <div data-permission="pending">
      <p style={PRE_WRAP}>{item.title}</p>
      {item.options.map((option) => (
        <button
          key={option.optionId}
          type="button"
          onClick={() => {
            actions.respond(item.id, option.optionId);
          }}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

function ErrorItemView(props: { item: ErrorItem }): ReactNode {
  const { item } = props;
  return (
    <div data-error>
      <p style={PRE_WRAP}>{item.message}</p>
      {item.stderr === undefined ? null : (
        <details>
          <summary>Вывод процесса</summary>
          <pre style={PRE_WRAP}>{item.stderr}</pre>
        </details>
      )}
      <p>Отправьте сообщение ещё раз, чтобы повторить</p>
    </div>
  );
}
