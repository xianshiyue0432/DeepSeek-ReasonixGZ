import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { t } from "../../../i18n/index.js";
import { CardHeader } from "../primitives/CardHeader.js";
import type { UserCard as UserCardData } from "../state/cards.js";
import { StoreCtx } from "../state/provider.js";
import type { AgentEvent } from "../state/events.js";
import type { AgentStore } from "../state/store.js";
import { CARD, FG, MESSAGE_BG } from "../theme/tokens.js";
import { formatRelativeTime } from "./time.js";
import { useKeystroke } from "../keystroke-context.js";

export function UserCard({ card }: { card: UserCardData }): React.ReactElement {
  // Always render the buttons. Dispatch from context directly (safe via null guard).
  const store = React.useContext(StoreCtx);
  const storeRef = React.useRef<AgentStore | null>(null);
  storeRef.current = store;

  const showRollbackConfirm = React.useCallback(() => {
    const s = storeRef.current;
    if (!s) return;
    const ev: AgentEvent = {
      type: "rollback.confirm.show",
      targetCardId: card.id,
      targetText: card.text,
    };
    s.dispatch(ev);
  }, [card.id, card.text]);

  const showDeleteConfirm = React.useCallback(() => {
    const s = storeRef.current;
    if (!s) return;
    const ev: AgentEvent = {
      type: "delete.confirm.show",
      targetCardId: card.id,
    };
    s.dispatch(ev);
  }, [card.id]);

  useKeystroke(
    (ev: { input: string; ctrl?: boolean }) => {
      if (ev.ctrl && ev.input === "r") {
        showRollbackConfirm();
      } else if (ev.ctrl && ev.input === "d") {
        showDeleteConfirm();
      }
    },
    true,
  );

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <CardHeader
        glyph={CARD.user.glyph}
        tone={CARD.user.color}
        title={t("cardTitles.you")}
        meta={[formatRelativeTime(card.ts)]}
      />
      <Box
        flexDirection="column"
        width="100%"
        backgroundColor={MESSAGE_BG.user}
        paddingX={1}
        paddingY={1}
      >
        <Box flexDirection="row" gap={1}>
          <Text color={FG.sub}>↳</Text>
          <Text>{card.text}</Text>
        </Box>

        {/* Rollback & Delete action buttons — always visible */}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text color="#00ff00">[</Text>
            <Text bold color="#00ff00">^R</Text>
            <Text color="#00ff00">]</Text>
            <Text color="#00ff00">rollback</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color="#ffdd00">[</Text>
            <Text bold color="#ffdd00">^D</Text>
            <Text color="#ffdd00">]</Text>
            <Text color="#ffdd00">delete</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
