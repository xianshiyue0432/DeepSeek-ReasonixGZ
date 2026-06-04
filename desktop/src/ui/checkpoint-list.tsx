/** Checkpoint list modal — shows all rollback points for the current session. */

import { memo } from "react";
import { useLang } from "../i18n";
import type { CheckpointEntry } from "../protocol";

export const CheckpointListModal = memo(function CheckpointListModal({
  checkpoints,
  onClose,
  onRollback,
  onUndoRollback,
  onView,
  onCopy,
  viewData,
  viewingCardId,
  onToggleView,
}: {
  checkpoints: CheckpointEntry[];
  onClose: () => void;
  onRollback: (userCardId: string) => void;
  onUndoRollback: (rollbackStateId: string) => void;
  onView: (userCardId: string) => void;
  onCopy: (text: string) => void;
  viewData: { userText: string; assistantText: string } | null;
  viewingCardId: string | null;
  onToggleView: (userCardId: string) => void;
}) {
  useLang();

  return (
    <div className="checkpoint-overlay" onClick={onClose}>
      <div className="checkpoint-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="checkpoint-header">
          <span className="checkpoint-title">回滚点</span>
          <button type="button" className="checkpoint-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="checkpoint-list">
          {checkpoints.length === 0 ? (
            <div className="checkpoint-empty">暂无可用的回滚点</div>
          ) : (
            checkpoints.map((cp, i) => (
              <div key={cp.userCardId} className={`checkpoint-item ${cp.rollbackActive ? "active" : ""}`}>
                <div className="checkpoint-item-head">
                  <span className="checkpoint-num">#{i + 1}</span>
                  <span className="checkpoint-label">turn {cp.userCardId.replace("desktop-turn-", "")}</span>
                  <span className="checkpoint-preview">{cp.userText.slice(0, 50)}{cp.userText.length > 50 ? "…" : ""}</span>
                </div>
                <div className="checkpoint-item-actions">
                  <button
                    type="button"
                    className="checkpoint-action-btn view"
                    onClick={() => {
                      if (viewingCardId === cp.userCardId) {
                        onToggleView("");
                      } else {
                        onToggleView(cp.userCardId);
                        onView(cp.userCardId);
                      }
                    }}
                    title="查看完整消息"
                  >
                    {viewingCardId === cp.userCardId ? "收起" : "查看"}
                  </button>
                  <button
                    type="button"
                    className="checkpoint-action-btn rollback"
                    onClick={() => onRollback(cp.userCardId)}
                    title="回滚到此位置"
                  >
                    回滚
                  </button>
                  {cp.rollbackActive && cp.rollbackStateId ? (
                    <button
                      type="button"
                      className="checkpoint-action-btn undo"
                      onClick={() => { const id = cp.rollbackStateId; if (id) onUndoRollback(id); }}
                      title="撤销回滚"
                    >
                      撤销回滚
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="checkpoint-action-btn copy"
                    onClick={() => onCopy(cp.userText)}
                    title="复制消息内容"
                  >
                    复制
                  </button>
                </div>
                {viewingCardId === cp.userCardId && viewData ? (
                  <div className="checkpoint-view-content">
                    <div className="checkpoint-msg user-msg">
                      <div className="checkpoint-msg-label">用户</div>
                      <div className="checkpoint-msg-text">{viewData.userText}</div>
                    </div>
                    {viewData.assistantText ? (
                      <div className="checkpoint-msg assistant-msg">
                        <div className="checkpoint-msg-label">Reasonix</div>
                        <div className="checkpoint-msg-text">{viewData.assistantText}</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
});
