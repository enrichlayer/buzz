import * as React from "react";
import {
  getThreadReplyIndentRem,
  THREAD_REPLY_BODY_OFFSET_REM,
} from "../lib/threadTreeLayout";

export type ThreadActivityFragment = {
  id: string;
  agentName?: string;
  agentId?: string;
  turnId?: string | null;
  afterMessageId: string;
  timestamp: string;
  content: React.ReactNode;
};
type Register = (owner: string, items: ThreadActivityFragment[] | null) => void;
const RegisterContext = React.createContext<Register | null>(null);
const ItemsContext = React.createContext<ThreadActivityFragment[]>([]);

/** Thread-owned slots keep published messages and observer evidence in one DOM reading order. */
export function ThreadSessionTimelineProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [owners, setOwners] = React.useState<
    Record<string, ThreadActivityFragment[]>
  >({});
  const register = React.useCallback<Register>((owner, items) => {
    setOwners((previous) => {
      if (previous[owner] === items || (!items && !previous[owner]))
        return previous;
      const next = { ...previous };
      if (items) next[owner] = items;
      else delete next[owner];
      return next;
    });
  }, []);
  const items = React.useMemo(
    () =>
      Object.values(owners)
        .flat()
        .sort(
          (a, b) =>
            a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
        ),
    [owners],
  );
  return (
    <RegisterContext.Provider value={register}>
      <ItemsContext.Provider value={items}>{children}</ItemsContext.Provider>
    </RegisterContext.Provider>
  );
}

export function useThreadActivityFragments(
  owner: string,
  items: ThreadActivityFragment[],
) {
  const register = React.useContext(RegisterContext);
  React.useLayoutEffect(() => {
    register?.(owner, items);
  }, [register, owner, items]);
  React.useLayoutEffect(() => () => register?.(owner, null), [register, owner]);
  return register !== null;
}

export function ThreadSessionActivitySlot({
  messageId,
  depth = 0,
  messageAuthor,
  isHead = false,
}: {
  messageId: string;
  depth?: number;
  messageAuthor?: string;
  isHead?: boolean;
}) {
  const allItems = React.useContext(ItemsContext);
  const items = allItems.filter((item) => item.afterMessageId === messageId);
  if (!items.length) return null;
  return (
    <section
      className={`space-y-2 pb-6 pt-2 pr-3 ${isHead ? "mx-2" : ""}`}
      style={{
        paddingInlineStart: `${getThreadReplyIndentRem(depth) + THREAD_REPLY_BODY_OFFSET_REM}rem`,
      }}
      aria-label="Coding activity"
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {item.agentName &&
          (index === 0
            ? item.agentId !== messageAuthor
            : item.agentId !== items[index - 1]?.agentId ||
              item.turnId !== items[index - 1]?.turnId) ? (
            <p className="text-xs font-medium text-muted-foreground">
              {item.agentName}
            </p>
          ) : null}
          {item.content}
        </React.Fragment>
      ))}
    </section>
  );
}

const VisibleMessagesContext = React.createContext<readonly string[] | null>(
  null,
);
export const ThreadSessionVisibleMessages = VisibleMessagesContext.Provider;
export function useThreadVisibleMessageIds() {
  return React.useContext(VisibleMessagesContext);
}
