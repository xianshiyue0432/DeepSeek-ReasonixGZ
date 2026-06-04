/** Rollback confirmation and merge/reproduce choice dialogs. */

import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { SingleSelect } from "../Select.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { useDispatch } from "../state/provider.js";
import type { AgentEvent } from "../state/events.js";
import type { Card } from "../state/cards.js";
import { t } from "../../../i18n/index.js";
import { FG, TONE } from "../theme/tokens.js";

// ---------------------------------------------------------------------------
// RollbackConfirmDialog
// ---------------------------------------------------------------------------

export interface RollbackConfirmDialogProps {
  card: Extract<Card, { kind: "rollbackConfirm" }>;
}

/** Confirmation dialog shown before performing a rollback or delete. */
export function RollbackConfirmDialog({
  card,
}: RollbackConfirmDialogProps): React.ReactElement {
  const dispatch = useDispatch();
  const isDelete = card.mode === "delete";

  const handleConfirm = React.useCallback(() => {
    if (isDelete) {
      const ev: AgentEvent = {
        type: "delete.perform",
        targetCardId: card.targetCardId,
      };
      dispatch(ev);
    } else {
      const ev: AgentEvent = {
        type: "rollback.perform",
        targetCardId: card.targetCardId,
        rollbackId: `rb-${Date.now().toString(36)}`,
        targetText: card.targetText,
      };
      dispatch(ev);
    }
  }, [card.targetCardId, card.targetText, dispatch, isDelete]);

  const handleCancel = React.useCallback(() => {
    const ev: AgentEvent = {
      type: "session.fork",
      cardId: card.id,
    };
    dispatch(ev);
  }, [card.id, dispatch]);

  const items: Array<{ value: string; label: string; hint?: string }> = isDelete
    ? [
        { value: "yes", label: "Yes, delete", hint: "Remove this message and all subsequent turns" },
        { value: "no", label: "Cancel" },
      ]
    : [
        { value: "yes", label: "Yes, rollback", hint: "Revert file state to before this message" },
        { value: "no", label: "Cancel" },
      ];

  return (
    <ApprovalCard
      tone="warn"
      title={isDelete ? "🗑 Delete this message?" : "↩ Rollback to this message?"}
      metaRight={t("shellConfirm.awaiting")}
    >
      <Box flexDirection="column" marginBottom={1}>
        {isDelete ? (
          <Text color={FG.body}>
            This will remove this message and all subsequent conversation turns.
            File state will NOT be affected.
          </Text>
        ) : (
          <>
            <Text color={FG.body}>
              Rolling back will revert all file changes to the state before:
            </Text>
            <Box marginLeft={1} marginTop={1}>
              <Text color={FG.meta} italic>
                &ldquo;{truncate(card.targetText, 80)}&rdquo;
              </Text>
            </Box>
          </>
        )}
      </Box>
      <SingleSelect
        initialValue="no"
        items={items}
        onSubmit={(v) => {
          if (v === "yes") handleConfirm();
          else handleCancel();
        }}
        onCancel={handleCancel}
      />
    </ApprovalCard>
  );
}

// ---------------------------------------------------------------------------
// MergeChoiceDialog
// ---------------------------------------------------------------------------

export interface MergeChoiceDialogProps {
  card: Extract<Card, { kind: "mergeChoice" }>;
}

/** Choice dialog shown when undoing a rollback and new changes exist. */
export function MergeChoiceDialog({
  card,
}: MergeChoiceDialogProps): React.ReactElement {
  const dispatch = useDispatch();

  const handleChoice = React.useCallback(
    (choice: "reproduce" | "merge") => {
      const ev: AgentEvent = {
        type: "mergeChoice.resolve",
        rollbackId: card.rollbackId,
        choice,
      };
      dispatch(ev);
    },
    [card.rollbackId, dispatch],
  );

  const handleCancel = React.useCallback(() => {
    const ev: AgentEvent = {
      type: "session.fork",
      cardId: card.id,
    };
    dispatch(ev);
  }, [card.id, dispatch]);

  const items: Array<{ value: string; label: string; hint?: string }> = [
    {
      value: "reproduce",
      label: "Reproduce",
      hint: "Undo new changes and replay the rolled-back content",
    },
    {
      value: "merge",
      label: "Merge",
      hint: "Keep new changes, merge old file changes into current state",
    },
    {
      value: "cancel",
      label: "Cancel",
    },
  ];

  return (
    <ApprovalCard
      tone="warn"
      title="New changes detected since rollback"
      metaRight={t("shellConfirm.awaiting")}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={FG.body}>
          {card.pendingChanges} new user message(s) found since the rollback.
          How would you like to proceed?
        </Text>
      </Box>
      <SingleSelect
        initialValue="reproduce"
        items={items}
        onSubmit={(v) => {
          if (v === "cancel") handleCancel();
          else handleChoice(v as "reproduce" | "merge");
        }}
        onCancel={handleCancel}
      />
    </ApprovalCard>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}
