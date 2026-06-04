/** Memory panel — browse/add/edit/delete memory entries. */

import { memo, useState, useEffect, useCallback } from "react";
import { useLang } from "../i18n";
import type { MemoryEntryInfo, MemoryStoreEntry } from "../protocol";
import { I } from "../icons";

export const MemoryPanel = memo(function MemoryPanel({
  entries,
  onList,
  onSave,
  onDelete,
  legacyEntries,
  onReadLegacy,
  legacyDetail,
}: {
  entries: MemoryStoreEntry[];
  onList: (scope: "global" | "project") => void;
  onSave: (data: { name: string; description: string; body: string; scope: "global" | "project" }) => void;
  onDelete: (name: string, scope: "global" | "project") => void;
  legacyEntries?: MemoryEntryInfo[];
  onReadLegacy?: (path: string) => void;
  legacyDetail?: string;
}) {
  useLang();
  const [scope, setScope] = useState<"global" | "project">("global");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MemoryStoreEntry | null>(null);
  const [editName, setEditName] = useState("");
  const [selectedLegacy, setSelectedLegacy] = useState<string | null>(null);
  const [expandedStore, setExpandedStore] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editBody, setEditBody] = useState("");

  useEffect(() => { onList(scope); }, [scope, onList]);

  const filtered = entries.filter((e) =>
    e.scope === scope && (!search || e.name.includes(search) || e.description.includes(search))
  );

  const filteredLegacy = (legacyEntries ?? []).filter((e) =>
    e.scope === scope && (!search || e.name.includes(search) || e.description?.includes(search))
  );

  const openNew = () => {
    setEditing({ name: "", description: "", body: "", scope, type: "project", createdAt: "" });
    setEditName(""); setEditDesc(""); setEditBody("");
  };

  const openEdit = (e: MemoryStoreEntry) => {
    setEditing(e); setEditName(e.name); setEditDesc(e.description); setEditBody(e.body);
  };

  const save = useCallback(() => {
    if (!editName.trim()) return;
    onSave({ name: editName.trim(), description: editDesc.trim(), body: editBody.trim(), scope });
    setEditing(null);
  }, [editName, editDesc, editBody, scope, onSave]);

  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="mem-scope-tabs">
          <button className={`mem-scope-btn ${scope === "global" ? "active" : ""}`} onClick={() => setScope("global")}>全局</button>
          <button className={`mem-scope-btn ${scope === "project" ? "active" : ""}`} onClick={() => setScope("project")}>项目</button>
        </div>
        <button className="mem-add-btn" onClick={openNew}><I.plus size={12} /> 添加</button>
      </div>
      <input className="mem-search" placeholder="搜索..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="mem-list">
        {/* Legacy file-based entries (CLAUDE.md / REASONIX.md) */}
        {scope === "project" && filteredLegacy.map((e) => (
          <div key={e.name}>
            <div className={`mem-item legacy ${selectedLegacy === e.name ? "selected" : ""}`}
              onClick={() => {
                if (selectedLegacy === e.name) {
                  setSelectedLegacy(null);
                } else {
                  setSelectedLegacy(e.name);
                  onReadLegacy?.(e.path);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <div className="mem-item-head">
                <span className="mem-item-name">{e.name}</span>
                <span className="mem-item-desc">{e.description || "(文件记忆)"}</span>
              </div>
              <div className="mem-item-actions">
                <span className="mem-item-meta">只读</span>
              </div>
            </div>
            {selectedLegacy === e.name && legacyDetail ? (
              <pre className="mem-detail-block">{legacyDetail}</pre>
            ) : null}
          </div>
        ))}
        {filtered.length === 0 && filteredLegacy.length === 0 ? (
          <div className="mem-empty">暂无条目</div>
        ) : (
          filtered.map((e) => {
            const isExpanded = expandedStore === e.name;
            return (
              <div key={e.name} className="mem-item">
                <div className="mem-item-head" onClick={() => setExpandedStore(isExpanded ? null : e.name)} style={{ cursor: "pointer" }}>
                  <span className="mem-item-name">{e.name}</span>
                  <span className="mem-item-desc">{e.description}</span>
                  <span className="mem-item-toggle">{isExpanded ? "▲" : "▼"}</span>
                </div>
                {isExpanded ? (
                  <pre className="mem-detail-block">{e.body}</pre>
                ) : null}
                <div className="mem-item-actions">
                  <button className="mem-action-btn" onClick={(ev) => { ev.stopPropagation(); openEdit(e); }} title="编辑">编辑</button>
                  <button className="mem-action-btn del" onClick={(ev) => { ev.stopPropagation(); if (confirm("确定删除？")) onDelete(e.name, scope); }} title="删除">删除</button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {editing !== null ? (
        <div className="mem-overlay" onClick={() => setEditing(null)}>
          <div className="mem-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="mem-dialog-head">
              <span>{editing.name ? "编辑记忆" : "添加记忆"}</span>
              <button className="mem-close" onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="mem-dialog-body">
              <label>名称</label>
              <input className="field" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="my-memory" />
              <label>描述</label>
              <input className="field" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="简短说明" />
              <label>内容</label>
              <textarea className="field mono" rows={6} value={editBody} onChange={(e) => setEditBody(e.target.value)} placeholder="记忆内容..." />
            </div>
            <div className="mem-dialog-foot">
              <button className="h-btn" onClick={() => setEditing(null)}>取消</button>
              <button className="h-btn primary" onClick={save}>保存</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
