import { useCallback, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { SessionsRef } from "@loom/plugin-acp";
import { ChatSessionRef } from "@loom/plugin-chat";
import { useService } from "@loom/react";
import { attach, definePlugin } from "@loom/sdk";
import type { PluginDefinition } from "@loom/sdk";

const STARTING_PLACEHOLDER = "Сессия запускается…";
const SEND_FAILED = "Не удалось отправить";

/** Текст отказа: Error — message, остальное — строковый вид. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Сеанс ещё запускается: поле неактивно, отправлять нечего. */
function StartingField(): ReactNode {
  return <textarea aria-label="Сообщение" disabled placeholder={STARTING_PLACEHOLDER} />;
}

/** Поле активного сеанса: Enter отправляет, кнопки Отправить/Стоп, ошибка под полем. */
function ActiveField(props: { sessionId: string; busy: boolean }): ReactNode {
  const { sessionId, busy } = props;
  const sessions = useService(SessionsRef);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const send = (): void => {
    const value = text.trim();
    if (sending || value === "") return;
    setError(undefined);
    setSending(true);
    void sessions
      .prompt(sessionId, value)
      .then(() => {
        setSending(false);
        setText("");
      })
      .catch((cause: unknown) => {
        setSending(false);
        setError(errorMessage(cause));
      });
  };

  const stop = (): void => {
    // отказ отмены не показываем: сбои транспорта видны через баннер ленты
    void sessions.cancel(sessionId).catch(() => undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // обычный Enter не вставляет перевод строки, даже когда отправка невозможна
    e.preventDefault();
    if (!busy) send();
  };

  return (
    <div>
      <textarea
        aria-label="Сообщение"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {error !== undefined ? <p role="alert">{`${SEND_FAILED}: ${error}`}</p> : null}
      {busy ? (
        <button type="button" onClick={stop}>
          Стоп
        </button>
      ) : (
        <button type="button" disabled={sending} onClick={send}>
          Отправить
        </button>
      )}
    </div>
  );
}

/** Композер: подписан на снимок сеанса; до готовности — неактивное поле. */
function ComposerView(): ReactNode {
  const session = useService(ChatSessionRef);
  const subscribe = useCallback((notify: () => void) => session.subscribe(notify), [session]);
  const snapshot = useSyncExternalStore(subscribe, () => session.snapshot());
  if (snapshot === undefined) return <StartingField />;
  return <ActiveField sessionId={snapshot.sessionId} busy={snapshot.busy} />;
}

const composerInput = attach("app/screens/chat", "composer", {
  id: "main",
  component: ComposerView,
});

/** Композер: поле ввода сообщения под лентой чата. */
const plugin: PluginDefinition = definePlugin({
  id: "composer",
  version: "0.1.0",
  dependsOn: { chat: "^0.1.0", acp: "^0.1.0" },
  extensions: [composerInput],
});

export default plugin;
