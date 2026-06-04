/** Rollback marker card — shown after a rollback to indicate the state was rewound. */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { useDispatch } from "../state/provider.js";
import type { AgentEvent } from "../state/events.js";
import type { Card } from "../state/cards.js";
import { FG, TONE } from "../theme/tokens.js";
import { useKeystroke } from "../keystroke-context.js";
import { formatRelativeTime } from "./time.js";

export interface RollbackCardProps {
  card: Extract<Card, { kind: "rollbackMarker" }>;
}

/** Renders a rollback marker with an "undo rollback" prompt. */
export function RollbackCard({ card }: RollbackCardProps): React.ReactElement {
  const dispatch = useDispatch();

  const handleUndo = React.useCallback(() => {
    const ev: AgentEvent = {
      type: "undoRollback.show",
      rollbackId: card.rollbackId,
      targetCardId: card.targetCardId,
      targetText: card.targetText,
    };
    dispatch(ev);
  }, [card.rollbackId, card.targetCardId, card.targetText, dispatch]);

  // Keyboard: Ctrl+Z for undo rollback
  useKeystroke((ev: { input: string; ctrl?: boolean }) => {
    if (card.isActive && ev.ctrl && ev.input === "z") {
      handleUndo();
    }
  });

  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingX={1}
      paddingY={1}
      borderStyle="round"
      borderColor={TONE.accent}
    >
      <Box flexDirection="row" gap={1}>
        <Text bold color={TONE.accent}>
          ↩ Rolled Back
        </Text>
        <Text color={FG.faint}>{formatRelativeTime(card.ts)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="row" gap={1}>
        <Text color={FG.sub}>↳</Text>
        <Text color={FG.meta}>{card.targetText}</Text>
      </Box>
      {card.isActive ? (
        <Box marginTop={1}>
          <Text color={FG.faint}>
            Press <Text bold color={TONE.accent}>^Z</Text> to undo this rollback
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FG.faint}>(Rollback merged — no longer active)</Text>
        </Box>
      )}
    </Box>
  );
}
