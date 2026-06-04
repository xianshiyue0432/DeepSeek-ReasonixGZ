/** Rules panel — browse/add/edit/delete natural-language rules. */

import { memo, useState, useEffect, useCallback } from "react";
import { useLang } from "../i18n";
import type { RulesStoreEntry } from "../protocol";
import { I } from "../icons";

export type EditMode = "plan" | "review" | "auto" | "yolo";

function autoApproveItems(editMode: EditMode): { p: string; allow: boolean; desc: string }[] {
  if (editMode === "yolo") {
    return [{ p: "*", allow: true, desc: "yolo模式.所有工具调用自动批准" }];
  }
  if (editMode === "auto") {
    return [
      { p: "read_file, list_directory, search_files, *", allow: true, desc: "只读操作自动批准" },
      { p: "run_command (allowlist)", allow: true, desc: "已批准命令自动执行" },
      { p: "edit_file, write_file, run_command (other)", allow: false, desc: "写入操作需用户确认" },
    ];
  }
  if (editMode === "plan") {
    return [{ p: "*", allow: false, desc: "plan模式.需提交计划审批" }];
  }
  return [{ p: "*", allow: false, desc: "review模式.每个操作需用户确认" }];
}

export const RulesPanel = memo(function RulesPanel({
  entries,
  onList,
  onSave,
  onDelete,
  editMode,
}: {
  entries: RulesStoreEntry[];
  onList: (scope: "global" | "project") => void;
  onSave: (data: { name: string; description: string; body: string; scope: "global" | "project" }) => void;
  onDelete: (name: string, scope: "global" | "project") => void;
  editMode?: EditMode;
}) {
  useLang();
  const [scope, setScope] = useState<"global" | "project">("global");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<RulesStoreEntry | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editBody, setEditBody] = useState("");

  useEffect(() => { onList(scope); }, [scope, onList]);

  const filtered = entries.filter((e) =>
    e.scope === scope && (!search || e.name.includes(search) || e.description.includes(search))
  );

  const openNew = () => {
    setEditing({ name: "", description: "", body: "", scope, createdAt: "", updatedAt: "" });
    setEditName(""); setEditDesc(""); setEditBody("");
  };

  const openEdit = (e: RulesStoreEntry) => {
    setEditing(e); setEditName(e.name); setEditDesc(e.description); setEditBody(e.body);
  };

  const save = useCallback(() => {
    if (!editName.trim()) return;
    onSave({ name: editName.trim(), description: editDesc.trim(), body: editBody.trim(), scope });
    setEditing(null);
  }, [editName, editDesc, editBody, scope, onSave]);

  const autoRules = autoApproveItems(editMode ?? "review");

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
        {/* Auto-approval rules at top of global tab — original format */}
        {scope === "global" && editMode ? (
          <div className="mem-item legacy">
            <div className="mem-item-head">
              <span className="mem-item-name">自动批准：{editMode.toUpperCase()}</span>
            </div>
            {autoRules.map((r, i) => (
              <div className="rule-compact" key={i}>
                <div className="rule-compact-top">
                  <span className={`rule-compact-pat ${r.allow ? "" : "deny"}`}>{r.p}</span>
                  <span className={`rule-compact-badge ${r.allow ? "" : "deny"}`}>
                    {r.allow ? "ALLOW" : "ASK"}
                  </span>
                </div>
                <div className="rule-compact-desc">{r.desc}</div>
              </div>
            ))}
          </div>
        ) : null}
        {filtered.length === 0 ? (
          <div className="mem-empty">暂无规则</div>
        ) : (
          filtered.map((e) => (
            <div key={e.name} className="mem-item">
              <div className="mem-item-head">
                <span className="mem-item-name">{e.name}</span>
                <span className="mem-item-desc">{e.description}</span>
              </div>
              <div className="mem-item-actions">
                <button className="mem-action-btn" onClick={() => openEdit(e)} title="编辑">编辑</button>
                <button className="mem-action-btn del" onClick={() => { if (confirm("确定删除？")) onDelete(e.name, scope); }} title="删除">删除</button>
              </div>
            </div>
          ))
        )}
      </div>
      {editing !== null ? (
        <div className="mem-overlay" onClick={() => setEditing(null)}>
          <div className="mem-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="mem-dialog-head">
              <span>{editing.name ? "编辑规则" : "添加规则"}</span>
              <button className="mem-close" onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="mem-dialog-body">
              <label>名称</label>
              <input className="field" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="rule-name" />
              <label>描述</label>
              <input className="field" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="简短说明" />
              <label>规则内容（自然语言指令）</label>
              <textarea className="field mono" rows={6} value={editBody} onChange={(e) => setEditBody(e.target.value)} placeholder="例：打包前必须先给三个文件的版本号+1..." />
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
