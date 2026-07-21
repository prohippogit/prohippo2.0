/* ProHippo — Google Keep-style task board.
 *
 * Backs onto the existing `todos` collection, extended (backward-compatibly):
 *   { type:"note"|"checklist", title, text, items:[{text,done}],
 *     color, pinned, due, assessee, label, done, archived, createdAt }
 * Old simple todos ({text,done,tag,tagColor}) render as note cards, with `tag`
 * shown as a label chip.
 */
import React from 'react';
import { Icon, titleCase, fmtDate, daysFromNow } from './shared';
import { useData } from './store';

const TASK_COLORS = {
  chrome: "#FFFFFF",
  violet: "#EFE9FF",
  pink: "#FDE7F1",
  amber: "#FDF0D6",
  mint: "#DEF6EA",
  blue: "#E4EEFD",
  coral: "#FCE3DC",
};
const COLOR_KEYS = Object.keys(TASK_COLORS);

const BOARD_CSS = `
.kb-composer { display:flex; align-items:center; gap:8px; background:white; border:1px solid var(--p-line); border-radius:12px; padding:8px 12px; box-shadow:var(--p-shadow-sm); margin-bottom:16px; }
.kb-composer input { flex:1; border:none; background:transparent; font-family:inherit; font-size:13.5px; font-weight:600; color:var(--p-text); outline:none; }
.kb-composer input::placeholder { color:var(--p-text-3); font-weight:600; }
.kb-tool { width:30px; height:30px; border-radius:9px; display:grid; place-items:center; color:var(--p-text-3); cursor:pointer; background:transparent; border:none; }
.kb-tool.on, .kb-tool:hover { background:var(--p-lavender-2); color:var(--p-primary-2); }
.kb-eyebrow { font-size:10px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:var(--p-text-3); margin:2px 2px 10px; }
.kb-board { column-count:4; column-gap:12px; }
@media (max-width:1100px){ .kb-board{ column-count:3; } }
@media (max-width:800px){ .kb-board{ column-count:2; } }
@media (max-width:520px){ .kb-board{ column-count:1; } }
.kb-card { break-inside:avoid; margin:0 0 12px; background:var(--c,#fff); border:1px solid var(--p-line); border-radius:13px; padding:12px 13px; box-shadow:var(--p-shadow-sm); transition:box-shadow .15s, transform .15s; position:relative; }
.kb-card:hover { box-shadow:var(--p-shadow); transform:translateY(-2px); }
.kb-pin { position:absolute; top:8px; right:9px; width:24px; height:24px; border-radius:7px; display:grid; place-items:center; color:var(--p-text-3); cursor:pointer; background:transparent; border:none; opacity:0; transition:opacity .12s; }
.kb-card:hover .kb-pin, .kb-card.pinned .kb-pin { opacity:1; }
.kb-card.pinned .kb-pin { color:var(--p-primary-2); }
.kb-title { font-weight:800; font-size:13px; letter-spacing:-.01em; margin:0 24px 7px 0; width:100%; border:none; background:transparent; font-family:inherit; color:var(--p-text); outline:none; }
.kb-note { font-size:13px; color:var(--p-text-2); width:100%; border:none; background:transparent; font-family:inherit; resize:none; outline:none; line-height:1.45; }
.kb-item { display:flex; align-items:flex-start; gap:8px; padding:3px 0; font-size:12.5px; }
.kb-box { width:16px; height:16px; border-radius:5px; border:1.6px solid var(--p-text-3); flex-shrink:0; margin-top:2px; display:grid; place-items:center; color:#fff; cursor:pointer; background:transparent; }
.kb-item.done .kb-box { background:var(--p-primary); border-color:var(--p-primary); }
.kb-item input { flex:1; border:none; background:transparent; font-family:inherit; font-size:12.5px; color:var(--p-text); outline:none; }
.kb-item.done input { color:var(--p-text-3); text-decoration:line-through; }
.kb-item .kb-x { opacity:0; cursor:pointer; color:var(--p-text-3); background:none; border:none; padding:0 2px; }
.kb-item:hover .kb-x { opacity:1; }
.kb-add { display:flex; align-items:center; gap:8px; padding:4px 0; font-size:12px; color:var(--p-text-3); }
.kb-add input { flex:1; border:none; background:transparent; font-family:inherit; font-size:12.5px; color:var(--p-text); outline:none; }
.kb-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
.kb-chip { font-size:10.5px; font-weight:700; padding:3px 8px; border-radius:999px; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
.kb-chip.who { background:rgba(108,92,231,.14); color:var(--p-primary-2); cursor:pointer; }
.kb-chip.tag { background:rgba(20,16,45,.06); color:var(--p-text-2); }
.kb-foot { display:flex; align-items:center; gap:4px; margin-top:10px; padding-top:9px; border-top:1px solid rgba(20,16,45,.06); opacity:0; transition:opacity .12s; flex-wrap:wrap; }
.kb-card:hover .kb-foot, .kb-card.editing .kb-foot { opacity:1; }
.kb-sw { width:15px; height:15px; border-radius:50%; cursor:pointer; border:1.5px solid rgba(0,0,0,.08); }
.kb-sw.sel { outline:2px solid var(--p-primary-3); outline-offset:1px; }
.kb-fbtn { width:26px; height:26px; border-radius:8px; display:grid; place-items:center; color:var(--p-text-3); cursor:pointer; background:transparent; border:none; margin-left:2px; }
.kb-fbtn:hover { background:rgba(20,16,45,.06); color:var(--p-primary-2); }
.kb-fbtn.del:hover { color:var(--p-danger); }
`;

function TaskCard({ card, assessees, onUpdate, onRemove, onOpenAssessee }) {
  const [newItem, setNewItem] = React.useState("");
  const [showAssignee, setShowAssignee] = React.useState(false);
  const color = card.color || "chrome";
  const dueDays = card.due ? daysFromNow(card.due) : null;
  const isCheck = card.type === "checklist";
  const items = Array.isArray(card.items) ? card.items : [];

  const setItem = (i, patch) => onUpdate({ items: items.map((it, idx) => idx === i ? { ...it, ...patch } : it) });
  const addItem = () => { const v = newItem.trim(); if (!v) return; onUpdate({ items: [...items, { text: v, done: false }] }); setNewItem(""); };
  const delItem = (i) => onUpdate({ items: items.filter((_, idx) => idx !== i) });

  const dueChip = card.due ? { over: dueDays < 0, soon: dueDays >= 0 && dueDays <= 3 } : null;

  return (
    <div className={`kb-card ${card.pinned ? "pinned" : ""}`} style={{ "--c": TASK_COLORS[color] }}>
      <button className="kb-pin" title={card.pinned ? "Unpin" : "Pin"} onClick={() => onUpdate({ pinned: !card.pinned })}>
        <Icon name="tag" size={13}/>
      </button>

      {isCheck ? (
        <>
          <input className="kb-title" defaultValue={card.title || ""} placeholder="Title"
            onBlur={(e) => { if ((e.target.value || "") !== (card.title || "")) onUpdate({ title: e.target.value }); }}/>
          {items.map((it, i) => (
            <div key={i} className={`kb-item ${it.done ? "done" : ""}`}>
              <div className="kb-box" onClick={() => setItem(i, { done: !it.done })}>{it.done && <Icon name="check" size={11} stroke={3}/>}</div>
              <input defaultValue={it.text} onBlur={(e) => { if (e.target.value !== it.text) setItem(i, { text: e.target.value }); }}/>
              <button className="kb-x" title="Remove" onClick={() => delItem(i)}><Icon name="x" size={11}/></button>
            </div>
          ))}
          <div className="kb-add">
            <span style={{ display: "grid", placeItems: "center", width: 16 }}><Icon name="plus" size={12}/></span>
            <input placeholder="List item" value={newItem} onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addItem(); }} onBlur={addItem}/>
          </div>
        </>
      ) : (
        <>
          {card.title && <div className="kb-title" style={{ marginBottom: 5 }}>{card.title}</div>}
          <textarea className="kb-note" rows={Math.min(8, Math.max(1, String(card.text || "").split("\n").length))}
            defaultValue={card.text || ""} placeholder="Note…"
            onBlur={(e) => { if (e.target.value !== (card.text || "")) onUpdate({ text: e.target.value }); }}/>
        </>
      )}

      {(card.due || card.assessee || card.label || card.tag) && (
        <div className="kb-chips">
          {dueChip && (
            <span className="kb-chip" style={{ background: dueChip.over ? "rgba(224,70,74,.14)" : dueChip.soon ? "rgba(232,137,12,.16)" : "rgba(20,16,45,.06)", color: dueChip.over ? "#C23B3F" : dueChip.soon ? "#A5670A" : "var(--p-text-2)" }}>
              <Icon name="calendar" size={10}/>{dueDays < 0 ? `${Math.abs(dueDays)}d over` : dueDays === 0 ? "Today" : `${fmtDate(card.due)}`}
            </span>
          )}
          {card.assessee && <span className="kb-chip who" onClick={() => onOpenAssessee && onOpenAssessee(card.assessee)}>@ {titleCase(card.assessee)}</span>}
          {(card.label || card.tag) && <span className="kb-chip tag">{card.label || card.tag}</span>}
        </div>
      )}

      <div className="kb-foot">
        {COLOR_KEYS.map((k) => (
          <span key={k} className={`kb-sw ${color === k ? "sel" : ""}`} title={k} style={{ background: TASK_COLORS[k] }} onClick={() => onUpdate({ color: k })}/>
        ))}
        <label className="kb-fbtn" title="Due date" style={{ position: "relative" }}>
          <Icon name="calendar" size={13}/>
          <input type="date" value={card.due || ""} onChange={(e) => onUpdate({ due: e.target.value })}
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%" }}/>
        </label>
        <button className="kb-fbtn" title="Link assessee" onClick={() => setShowAssignee((v) => !v)}><Icon name="user" size={13}/></button>
        <button className="kb-fbtn del" title="Delete" onClick={onRemove}><Icon name="trash" size={13}/></button>
      </div>
      {showAssignee && (
        <select autoFocus value={card.assessee || ""} onChange={(e) => { onUpdate({ assessee: e.target.value }); setShowAssignee(false); }}
          style={{ marginTop: 8, width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--p-line-2)", background: "white", color: "var(--p-text)" }}>
          <option value="">— No assessee —</option>
          {assessees.map((a) => <option key={a.id} value={a.name}>{titleCase(a.name)}</option>)}
        </select>
      )}
    </div>
  );
}

export function KeepBoard({ onOpenAssessee }) {
  const { data, addTodo, updateTodo, removeTodo } = useData();
  const [draft, setDraft] = React.useState("");
  const [draftType, setDraftType] = React.useState("note");

  const cards = (data.todos || []).filter((t) => !t.archived).map((t) => ({ type: t.type || "note", ...t }));
  const pinned = cards.filter((c) => c.pinned);
  const others = cards.filter((c) => !c.pinned);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (draftType === "checklist") addTodo({ type: "checklist", title: v, items: [], color: "chrome", done: false });
    else addTodo({ type: "note", text: v, color: "chrome", done: false });
    setDraft("");
  };

  const renderCard = (c) => (
    <TaskCard key={c.id} card={c} assessees={data.assessees}
      onUpdate={(patch) => updateTodo(c.id, patch)}
      onRemove={() => removeTodo(c.id)}
      onOpenAssessee={onOpenAssessee}/>
  );

  return (
    <div className="card">
      <style>{BOARD_CSS}</style>
      <div className="card-head">
        <div>
          <div className="card-title">Tasks &amp; notes</div>
          <div className="card-sub">{others.length + pinned.length} card{cards.length !== 1 ? "s" : ""}{pinned.length ? ` · ${pinned.length} pinned` : ""}</div>
        </div>
      </div>

      <div className="kb-composer">
        <input placeholder={draftType === "checklist" ? "New checklist title…" : "Take a note or add a task…"}
          value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}/>
        <button className={`kb-tool ${draftType === "note" ? "on" : ""}`} title="Note" onClick={() => setDraftType("note")}><Icon name="edit" size={15}/></button>
        <button className={`kb-tool ${draftType === "checklist" ? "on" : ""}`} title="Checklist" onClick={() => setDraftType("checklist")}><Icon name="check" size={15}/></button>
        <button className="btn btn-secondary btn-sm" onClick={add}>Add</button>
      </div>

      {cards.length === 0 && (
        <div className="muted" style={{ fontSize: 13, textAlign: "center", padding: "22px 0" }}>Nothing yet — add a note or a checklist above.</div>
      )}

      {pinned.length > 0 && <>
        <div className="kb-eyebrow">Pinned</div>
        <div className="kb-board">{pinned.map(renderCard)}</div>
        {others.length > 0 && <div className="kb-eyebrow">Others</div>}
      </>}
      <div className="kb-board">{others.map(renderCard)}</div>
    </div>
  );
}
