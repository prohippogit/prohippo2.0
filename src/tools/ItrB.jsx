/*
 * Tools → ITR-B. The block assessment return for a search case.
 *
 * WHAT THE PAGE IS FOR. A block return under s.158BC covers seven years behind
 * one PAN, and sixty days from the service of the notice is not long to settle
 * seven years of figures with a client who has just been searched. Almost
 * everything the return needs is already in this app — the PAN and the contact
 * details from the assessee register, the income declared in each year from the
 * ITR JSONs the portal sync has on file — so the work that is genuinely the
 * practitioner's is the undisclosed income and the manner it was derived in.
 * This page asks for that and nothing else, and hands back a working paper to
 * take into the portal.
 *
 * It does NOT file anything. The document it produces says so on its face.
 *
 * WHERE THE LOGIC IS. Not here. The block period (blockPeriod.js), the read of a
 * filed return (declared.js), the tax (compute.js), the draft's shape
 * (draft.js) and the document (pdf.js) are all pure modules under itrb/, tested
 * with `node --test`. This file is the form over them: it holds one draft
 * object in state, hands it to those modules, and renders what comes back.
 */
import React from 'react';
import { ref as storageRef, getDownloadURL, uploadBytes, deleteObject } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { storage, functions, auth } from '../firebase';
import { Icon, EmptyState, FormField, SelectInput, ComboBox, Toggle, Table, fmtINR, fmtDateLong, titleCase } from '../shared';
import { useData } from '../store';
import { saveBlob } from '../downloadFile';
import { blockPeriod, statedPeriodAgrees } from './itrb/blockPeriod';
import { readDeclared } from './itrb/declared';
import { computeItrB, UNDISCLOSED_HEADS, RATE_113, RATE_CESS, RATE_158BFA } from './itrb/compute';
import { HEADS } from './itrb/declared';
import {
  blankDraft, withBlockPeriod, fromAssessee, fromNotice, withDeclared, withFiledParticulars, withDetermined, withDueDate,
  readiness, STATUSES, SEARCH_SECTIONS, RETURN_SECTIONS,
} from './itrb/draft';
import { DII_ITEMS, furnishingMode, ASSESSED_UNDER, FILED_UNDER, PENDING_UNDER } from './itrb/form';
import { columnsFor, labelFor, appliesTo, determinedFromReturn, intimationToRead, withOrderReading } from './itrb/partC';
import { variantFor, FIELD_NUMBERS, FILED_UNDER_RECENT, partYearIncome } from './itrb/partA';
import { PART_B_ROWS, computePartB } from './itrb/partB';
import { completeness, summarise, STATUS } from './itrb/completeness';
import { findBlockProceedings, fieldsFromNotices, describeScan, readingOrder } from './itrb/findProceeding';
import { checkUpload, uploadPath, shortName, MAX_UPLOADS } from './itrb/uploads';

const TABS = ["Details", "Block period", "Tax", "Review"];

/* A rupee field.
 *
 * `type="text"` with an inputMode rather than type="number": a number input
 * scrolls its value when the wheel passes over it, and on a page carrying
 * seventy money fields that is a quiet way to change a figure nobody meant to
 * touch.
 *
 * No placeholder by default either. A greyed "0" sitting in every empty field
 * is indistinguishable at a glance from a keyed nil, and this is a form where
 * "not worked out yet" and "nil" are different answers. Where a field has a
 * real default — the statutory rates on the Tax tab — the caller passes it. */
function Amount({ value, onChange, placeholder = "", align = "right", width, disabled }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      disabled={disabled}
      value={value === null || value === undefined ? "" : value}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value.replace(/[,\s₹]/g, "");
        if (raw === "" || raw === "-" || /^-?\d*\.?\d*$/.test(raw)) onChange(raw);
      }}
      style={{
        textAlign: align, fontVariantNumeric: "tabular-nums", width, minWidth: 0,
        ...(disabled ? { background: "var(--p-card-tint)" } : null),
      }}
    />
  );
}

const money = (v) => (v === null || v === undefined || v === "" ? "—" : fmtINR(Number(v) || 0));

/* The income returned for a year, or a dash.
 *
 * computeItrB() coerces an unread year's declared total to 0 so the arithmetic
 * has a number to work with. Printing that as "₹0" would say the assessee
 * returned nil income for the year, which is a statement about the assessee
 * rather than about this draft. A year is only shown a figure once a return has
 * actually been read into it, or somebody has keyed one. */
const returned = (y) => (y.declaredSource || y.declaredTotal ? fmtINR(y.declaredTotal) : "—");

/* fmtDateLong, not fmtDate: shared's short form prints "15 Nov" with no year,
   and every date on this page spans years — a block period reading
   "01 Apr to 15 Nov" says nothing at all. An absent date reads as a dash rather
   than as "Invalid Date", which is what Date("") formats to. */
const dateOf = (iso) => (iso ? fmtDateLong(iso) : "—");

/* Read one ITR JSON out of Storage. The CORS failure is named rather than
   passed on: a browser reports it as a bare "Failed to fetch", and the fix
   (storage.cors.json) is not something anyone guesses from that. */
async function readStoredJson(path) {
  try {
    const url = await getDownloadURL(storageRef(storage, path));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the stored return could not be read (HTTP ${res.status})`);
    return await res.json();
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        "Couldn't read the filed return from storage. The storage bucket is not allowing this site to read files — "
        + "apply storage.cors.json (see docs/PORTAL_SYNC_SETUP.md) and try again.",
        { cause: err }
      );
    }
    throw err;
  }
}

export default function ItrB({ draftId, seedNotice, onBack }) {
  const { data, notify, addItrbDraft, updateItrbDraft, removeItrbDraft } = useData();
  const saved = draftId ? (data.itrbDrafts || []).find((d) => d.id === draftId) : null;

  const [draft, setDraft] = React.useState(() => {
    if (saved) return { ...blankDraft(), ...saved };
    if (seedNotice) {
      /* Arrived from the notice. Part A fills from the notice and from the
         assessee it belongs to, so the only thing still to key on this screen
         is the pair of search dates — which are on the panchnama, not on the
         notice, and are the practitioner's to supply. */
      const pan = (seedNotice.pan || "").toUpperCase();
      const a = (data.assessees || []).find((x) => pan && (x.pan || "").toUpperCase() === pan)
        || (data.assessees || []).find((x) => x.name && x.name === seedNotice.assessee);
      return fromNotice(blankDraft(), seedNotice, a);
    }
    return blankDraft();
  });
  const [id, setId] = React.useState(draftId || null);
  const [tab, setTab] = React.useState("Details");
  // A draft seeded from a notice has unsaved content from the moment it opens.
  const [dirty, setDirty] = React.useState(Boolean(seedNotice) && !saved);
  const [saving, setSaving] = React.useState(false);
  const [busyYear, setBusyYear] = React.useState("");
  const fileRef = React.useRef(null);

  const edit = (patch) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); };
  const editYear = (key, patch) => {
    setDraft((d) => ({ ...d, years: d.years.map((y) => (y.key === key ? { ...y, ...patch } : y)) }));
    setDirty(true);
  };

  const result = React.useMemo(() => computeItrB(draft), [draft]);
  const gaps = React.useMemo(() => readiness(draft, result), [draft, result]);
  const period = React.useMemo(
    () => blockPeriod(draft.searchDate, draft.lastAuthDate),
    [draft.searchDate, draft.lastAuthDate]
  );
  const furnishing = React.useMemo(
    () => furnishingMode({ status: draft.status, auditUs44AB: draft.auditUs44AB, politicalParty: draft.politicalParty }),
    [draft.status, draft.auditUs44AB, draft.politicalParty]
  );

  /* ---- assessee, and the block period it hangs off ---- */

  const pickAssessee = (a) => {
    setDraft((d) => withDueDate(fromAssessee(d, a)));
    setDirty(true);
    notify(`Part A filled from ${titleCase(a.name)}'s record.`);
  };

  const setPeriodDate = (patch) => {
    setDraft((d) => withBlockPeriod(d, patch));
    setDirty(true);
  };

  /* Write what the scan found. Split in two on purpose: `fields` are the
     notice's own recorded particulars and go straight in, `dates` came out of a
     language model reading a scan and arrive only when the practitioner has
     looked at the quote and pressed the button. Both re-cut the block period
     where a search date moves. */
  const applyScan = (patch) => {
    setDraft((d) => {
      const next = withDueDate({ ...d, ...patch });
      return patch.searchDate !== undefined || patch.lastAuthDate !== undefined
        ? withBlockPeriod(next, { searchDate: next.searchDate, lastAuthDate: next.lastAuthDate })
        : next;
    });
    setDirty(true);
  };

  const setServiceDate = (iso) => {
    setDraft((d) => withDueDate({ ...d, serviceDate: iso, dueDate: "" }));
    setDirty(true);
  };

  /* ---- filling declared income ---- */

  /* The return this practice already holds for a year, if the portal sync has
     been run. Matched on PAN and assessment year, which is how returns are
     keyed in Firestore. */
  const syncedReturn = React.useCallback((ay) => {
    const pan = (draft.pan || "").toUpperCase();
    if (!pan) return null;
    return (data.returns || []).find((r) => (r.pan || "").toUpperCase() === pan && r.ay === ay) || null;
  }, [data.returns, draft.pan]);

  /* Apply one reading to the row its assessment year belongs to.
   *
   * Deliberately routed by the A.Y. IN THE FILE rather than by the row the
   * button sits on. Seven JSONs downloaded from the portal in one go are named
   * by acknowledgement number, and a practitioner picking the wrong one out of
   * that list would otherwise put one year's declared income against another —
   * silently, and in a figure that reduces the undisclosed income. */
  const applyReading = (reading, source, expectedAy, ret = null) => {
    if (!reading) { notify("That file isn't an ITR JSON downloaded from the portal.", "alert"); return false; }
    const pan = (draft.pan || "").toUpperCase();
    if (pan && reading.pan && reading.pan !== pan) {
      notify(`That return is for PAN ${reading.pan}, not ${pan}.`, "alert");
      return false;
    }
    const row = draft.years.find((y) => y.ay === reading.ay);
    if (!row) {
      notify(
        reading.ay
          ? `That return is for A.Y. ${reading.ay}, which is outside this block period.`
          : "That file doesn't say which assessment year it is for.",
        "alert"
      );
      return false;
    }
    /* The figures out of the file, then the filing particulars out of the
       record. Both, because they answer different questions and neither source
       has the other's answers: the JSON has the income, the portal's record has
       the acknowledgement number and the date it was filed. */
    setDraft((d) => ({
      ...d,
      years: d.years.map((y) => (y.ay === row.ay ? withFiledParticulars(withDeclared(y, reading, source), ret) : y)),
    }));
    setDirty(true);
    if (expectedAy && expectedAy !== row.ay) {
      notify(`That file is A.Y. ${row.ay}, so it was filed against that year instead.`, "info");
    }
    return true;
  };

  /* Part C column [B], off the s.143(1) intimation.
   *
   * The rest of this screen fills from data the department produced — the ITR
   * JSON, the portal's record of the return. [B] is the exception: the income
   * CPC determined is printed in the intimation and stated in no record, so the
   * PDF has to be read. Where the practice has already read it (from the
   * Intimations screen) the figure is there for the taking; where it has not,
   * this reads it — one order, the newest, once, on a press the practitioner
   * made.
   *
   * IT ALWAYS SAYS WHY IT FOUND NOTHING. The first version returned null on
   * four different failures — no order on file, no PDF on the order, the read
   * throwing, the order carrying no total-income row — and the practitioner saw
   * an empty box and no explanation, which is indistinguishable from the
   * feature not working. Each of those is a different next step: run a returns
   * sync, fetch the order by e-mail, try again, or key it by hand. So each is
   * named. */
  const fillDetermined = async (ay, ret) => {
    if (!ret) return { ok: false, why: `no return on file for A.Y. ${ay}` };

    let found = determinedFromReturn(ret);
    let read = false;

    if (!found) {
      const orders = Array.isArray(ret.orders) ? ret.orders : [];
      if (!orders.length) {
        return { ok: false, why: `no s.143(1) intimation on file for A.Y. ${ay} — run a returns sync for this assessee, or key [B] by hand` };
      }
      const order = intimationToRead(ret);
      if (!order) {
        /* Nothing left to read, and the three reasons for that are three
           different jobs. LOCKED is the one worth spelling out: CPC encrypts
           every intimation with the PAN and the date of birth, the sync unlocks
           it at upload, and where the date of birth was not on the assessee's
           record at that moment the PDF went into Storage still encrypted. It
           stays that way until the sync runs again — adding the date of birth
           afterwards does not reach back and unlock what is already there. */
        const locked = orders.filter((o) => o && o.locked && o.lockReason !== "request-only");
        const readable = orders.filter((o) => o && o.storagePath && !o.locked);
        if (readable.length) {
          return { ok: false, why: `the intimation for A.Y. ${ay} has been read and states no total-income row — key [B] off the order` };
        }
        if (locked.length) {
          return { ok: false, why: `the intimation PDF for A.Y. ${ay} is still locked — CPC encrypts it with the PAN and the date of birth, and the date of birth was not on this assessee's record when it synced. Re-run the returns sync now that it is` };
        }
        return { ok: false, why: `the intimation for A.Y. ${ay} has no PDF on file — CPC sends some years' orders only by e-mail` };
      }
      try {
        const res = await httpsCallable(functions, "readIntimationOrder", { timeout: 120000 })({
          returnId: ret.id, commRefNo: order.commRefNo,
        });
        const reading = res?.data?.reading;
        if (!reading) return { ok: false, why: `the intimation for A.Y. ${ay} could not be read` };
        read = true;
        found = determinedFromReturn(withOrderReading(ret, order.commRefNo, reading));
        if (!found) {
          return { ok: false, why: `the intimation for A.Y. ${ay} was read but states no total-income row — key [B] off the order` };
        }
      } catch (e) {
        console.warn("itr-b: couldn't read the intimation for", ay, e);
        // Not fatal to the fill: the figures out of the JSON are already in.
        return { ok: false, why: `the intimation for A.Y. ${ay} couldn't be read — ${String(e?.message || e).slice(0, 90)}` };
      }
    }

    setDraft((d) => ({ ...d, years: d.years.map((y) => (y.ay === ay ? withDetermined(y, found) : y)) }));
    setDirty(true);
    return { ok: true, ...found, read };
  };

  /** One sentence about column [B], for the notification after a fill. */
  const saidAboutB = (out) => {
    if (!out) return "";
    if (!out.ok) return ` Column [B] is still yours: ${out.why}.`;
    return ` Column [B] is ${fmtINR(out.amount)}, ${out.read ? "read off" : "from"} the intimation${out.orderDate ? ` dated ${dateOf(out.orderDate)}` : ""}.`;
  };

  const fillFromSync = async (year) => {
    const ret = syncedReturn(year.ay);
    if (!ret) { notify(`No return on file for A.Y. ${year.ay}.`, "alert"); return; }

    /* A record with no JSON behind it still answers half the questions. The
       acknowledgement number and the date of filing come from the portal's own
       list of returns, not from the file, so a year whose JSON was never synced
       can still have its Part A particulars filled instead of being refused
       outright — which is what used to happen. */
    if (!ret.jsonPath) {
      setDraft((d) => ({ ...d, years: d.years.map((y) => (y.ay === year.ay ? withFiledParticulars(y, ret) : y)) }));
      setDirty(true);
      /* Column [B] does not come from the JSON — it comes from the intimation —
         so a year with no JSON synced can still have it, and refusing to look
         would leave a column blank for a reason that has nothing to do with it. */
      setBusyYear(year.key);
      const only = await fillDetermined(year.ay, ret);
      setBusyYear("");
      notify(`A.Y. ${year.ay}: filing particulars filled.${saidAboutB(only)} The ITR JSON hasn't been synced, so upload it for the declared income.`);
      return;
    }

    setBusyYear(year.key);
    try {
      const json = await readStoredJson(ret.jsonPath);
      if (applyReading(readDeclared(json), "sync", year.ay, ret)) {
        const determined = await fillDetermined(year.ay, ret);
        notify(`A.Y. ${year.ay} filled from the return on file.${saidAboutB(determined)}`, determined?.ok === false ? "info" : "check");
      }
    } catch (e) {
      console.error("itr-b: sync fill", e);
      notify(e?.message?.slice(0, 240) || "Couldn't read that return.", "alert");
    } finally {
      setBusyYear("");
    }
  };

  const fillAllFromSync = async () => {
    const todo = draft.years.filter((y) => syncedReturn(y.ay));
    if (!todo.length) { notify("No returns on file for this block period yet — run a returns sync first.", "alert"); return; }
    setBusyYear("all");

    /* Two different fills, and a year may get either. The figures need the ITR
       JSON; the acknowledgement number and the date of filing need only the
       portal's record of the return, which exists for years whose JSON was
       never synced. Doing only the first left those years blank beside a line
       on screen stating both facts. */
    let read = 0;
    let columnB = 0;
    let intimationsRead = 0;
    const noB = [];
    const particularsOnly = [];
    for (const y of todo) {
      const ret = syncedReturn(y.ay);
      if (!ret.jsonPath) {
        setDraft((d) => ({ ...d, years: d.years.map((r) => (r.ay === y.ay ? withFiledParticulars(r, ret) : r)) }));
        setDirty(true);
        particularsOnly.push(y.ay);
      } else {
        try {
          const json = await readStoredJson(ret.jsonPath);
          if (applyReading(readDeclared(json), "sync", y.ay, ret)) read += 1;
        } catch (err) {
          console.error("itr-b: sync fill", y.ay, err);
        }
      }
      // Column [B] comes from the intimation, not the JSON, so it is looked for
      // on every year with a return — including those with no JSON synced.
      const determined = await fillDetermined(y.ay, ret);
      if (determined?.ok) { columnB += 1; if (determined.read) intimationsRead += 1; }
      else if (determined?.why) noB.push(determined.why);
    }
    setBusyYear("");

    if (!read && !particularsOnly.length) { notify("Couldn't read any of the returns on file.", "alert"); return; }
    notify([
      read ? `Filled ${read} year${read === 1 ? "" : "s"} from the returns on file.` : "",
      columnB
        ? `Column [B] filled for ${columnB} year${columnB === 1 ? "" : "s"}${intimationsRead ? `, reading ${intimationsRead} intimation${intimationsRead === 1 ? "" : "s"} to do it` : ""}.`
        : "",
      /* Named rather than counted, and named even when other years DID fill:
         each of these needs a different next step — run a returns sync, fetch
         the order by e-mail, key it by hand — and a bare count of successes
         leaves the years that failed looking like years nobody looked at. */
      noB.length ? `Column [B] not filled where ${[...new Set(noB)].slice(0, 2).join("; and where ")}.` : "",
      particularsOnly.length
        ? `A.Y. ${particularsOnly.join(", ")}: acknowledgement and date only — no ITR JSON synced, so upload ${particularsOnly.length === 1 ? "it" : "them"} for the declared income.`
        : "",
    ].filter(Boolean).join(" "), "check");
  };

  const onFiles = async (files, expectedAy) => {
    let done = 0;
    for (const file of files) {
      try {
        const reading = readDeclared(JSON.parse(await file.text()));
        if (applyReading(reading, "json", expectedAy, reading.ay ? syncedReturn(reading.ay) : null)) done += 1;
      } catch (e) {
        console.error("itr-b: upload", file.name, e);
        notify(`${file.name} couldn't be read as an ITR JSON.`, "alert");
      }
    }
    if (done) notify(`${done} return${done === 1 ? "" : "s"} read into the block period.`);
  };

  /* ---- saving, and the documents ---- */

  const persist = async () => {
    /* `id` is the Firestore document id, not part of the draft. It arrives on
       the object because the store spreads it onto every snapshot row, and
       writing it back would store the id inside the document it names. */
    const payload = { ...draft, updatedAt: new Date().toISOString() };
    delete payload.id;
    setSaving(true);
    try {
      if (id) {
        await updateItrbDraft(id, payload);
      } else {
        const created = await addItrbDraft(payload);
        // The store has already said why it failed; saying "saved" over the
        // top of that would be the one message the practitioner remembers.
        if (!created?.id) return false;
        setId(created.id);
      }
      setDraft((d) => ({ ...d, ...payload }));
      setDirty(false);
      return true;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => { if (await persist()) notify("Draft saved."); };

  const download = async (sections) => {
    try {
      const { buildItrBPDF, itrbFilename } = await import("./itrb/pdf.js");
      const doc = buildItrBPDF({ draft, result, profile: data.profile });
      saveBlob(doc.output("blob"), itrbFilename(draft, sections));
      // A document that has been handed over should correspond to something on
      // file, so the draft it was built from is saved with it.
      if (dirty) await persist();
      notify(sections === "computation" ? "Computation downloaded." : "Mock ITR-B downloaded.");
    } catch (e) {
      console.error("itr-b: pdf", e);
      notify("Couldn't build the document.", "alert");
    }
  };

  const exportJson = () => {
    saveBlob(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
      `${(draft.name || "ITR-B draft").replace(/[\\/:*?"<>|]+/g, "")}.json`
    );
  };

  const discard = async () => {
    if (!id) { onBack(); return; }
    if (!window.confirm("Delete this ITR-B draft? This cannot be undone.")) return;
    await removeItrbDraft(id);
    notify("Draft deleted.");
    onBack();
  };

  /* ---- render ---- */

  const assesseeOptions = (data.assessees || []).map((a) => ({
    value: a.name, label: titleCase(a.name), sub: `${a.pan || "No PAN"} · ${a.status || ""}`, a,
  }));

  return (
    <div className="animate-in">
      <div className="topbar">
        <div style={{minWidth: 0}}>
          <button className="btn btn-ghost btn-sm" onClick={onBack} style={{marginBottom: 6, marginLeft: -8}}>
            <Icon name="arrow-left" size={13}/>All tools
          </button>
          <div className="page-title" style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap"}}>
            ITR-B
            <span className="pill pill-warning" style={{fontSize: 11}}>BETA</span>
          </div>
          <div className="page-sub">
            Block assessment return under s.158BC — Chapter XIV-B, rule 12AE. A working paper, not a filing.
          </div>
        </div>
        <div className="topbar-actions">
          {dirty && <span className="pill pill-warning" style={{fontSize: 11}}>Unsaved</span>}
          <button className="btn btn-secondary btn-sm" onClick={save} disabled={saving}>
            <Icon name="check" size={13}/>{saving ? "Saving…" : "Save draft"}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => download("both")}>
            <Icon name="pdf" size={13}/>Download
          </button>
        </div>
      </div>

      {draft.noticeId && (
        <div style={{margin: "0 0 12px", padding: "10px 14px", borderRadius: 12, background: "var(--p-mint)", color: "#1B8C5C", fontSize: 12.5, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap"}}>
          <Icon name="link" size={14}/>
          <span>
            Started from the notice on file{draft.noticeDin ? ` — DIN ${draft.noticeDin}` : ""}. Part A's notice details came across with it;
            the two search dates are on the panchnama and still need entering.
          </span>
        </div>
      )}
      <SummaryBar draft={draft} result={result}/>

      <div className="utabs">
        {TABS.map((t) => (
          <div key={t} className={`utab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      {tab === "Details" && (
        <DetailsTab
          draft={draft} edit={edit} period={period} furnishing={furnishing}
          assesseeOptions={assesseeOptions} onPickAssessee={pickAssessee}
          onPeriodDate={setPeriodDate} onServiceDate={setServiceDate}
          onApplyScan={applyScan}
        />
      )}

      {tab === "Block period" && (
        <BlockTab
          draft={draft} result={result} editYear={editYear}
          period={period} busyYear={busyYear}
          syncedReturn={syncedReturn}
          onFillYear={fillFromSync} onFillAll={fillAllFromSync} onReadIntimation={fillDetermined}
          onFiles={onFiles} fileRef={fileRef}
        />
      )}

      {tab === "Tax" && <TaxTab draft={draft} result={result} edit={edit} editYear={editYear}/>}

      {tab === "Review" && (
        <ReviewTab
          draft={draft} result={result} gaps={gaps} edit={edit}
          onDownload={download} onExport={exportJson} onDiscard={discard}
          onGoto={setTab}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/* The three figures that decide everything, kept on screen on every tab. A
   block return is a long form and the total undisclosed income is the number a
   practitioner is steering by throughout it. */
function SummaryBar({ draft, result }) {
  const items = [
    { label: "BLOCK PERIOD", value: draft.blockFrom ? `${dateOf(draft.blockFrom)} – ${dateOf(draft.blockTo)}` : "Not set", plain: true },
    { label: "UNDISCLOSED INCOME", value: fmtINR(result.totalUndisclosed) },
    { label: `TAX u/s 113 @ ${result.tax.rate}%`, value: fmtINR(Math.round(result.tax.aggregate)) },
    // "Refund due" only when there genuinely is one. An empty draft nets to
    // nil, and labelling that a refund is a promise the return does not make.
    { label: result.refundDue > 0 ? "REFUND DUE" : "NET PAYABLE", value: fmtINR(result.refundDue > 0 ? result.refundDue : result.netPayable), emph: true },
  ];
  return (
    <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, margin: "4px 0 16px"}}>
      {items.map((it) => (
        <div key={it.label} className="card" style={{padding: "13px 15px", background: it.emph ? "var(--p-lavender-2)" : "white"}}>
          <div className="muted" style={{fontSize: 10, fontWeight: 700, letterSpacing: "0.08em"}}>{it.label}</div>
          <div style={{fontSize: it.plain ? 13 : 17, fontWeight: 800, marginTop: 4, color: it.emph ? "var(--p-primary-2)" : "var(--p-text)"}}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ Part A ------------------------------ */

function DetailsTab({ draft, edit, period, furnishing, assesseeOptions, onPickAssessee, onPeriodDate, onServiceDate, onApplyScan }) {
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">The assessee</div>
            <div className="card-sub">Pick the client and Part A fills itself from their record — the PAN, the status, the address and the contact details, all as already held.</div>
          </div>
        </div>
        <div className="form-grid">
          <FormField label="Assessee" full>
            <ComboBox
              value={draft.assessee}
              onChange={(v) => edit({ assessee: v })}
              onPick={(o) => onPickAssessee(o.a)}
              options={assesseeOptions}
              placeholder="Search the assessee register by name or PAN…"
              subMono
            />
          </FormField>
          <FormField label="PAN" required>
            <input value={draft.pan} onChange={(e) => edit({ pan: e.target.value.toUpperCase() })} placeholder="AAAPZ1234A"
              style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "0.04em"}}/>
          </FormField>
          <FormField label="Status">
            <SelectInput value={draft.status} onChange={(v) => edit({ status: v })} options={STATUSES}/>
          </FormField>
          <FormField label="Date of birth / incorporation">
            <input type="date" value={draft.dob || ""} onChange={(e) => edit({ dob: e.target.value })}/>
          </FormField>
          <FormField label="Aadhaar (individuals)">
            <input value={draft.aadhaar} onChange={(e) => edit({ aadhaar: e.target.value })} placeholder="Optional"/>
          </FormField>
          <FormField label="Address" full>
            <input value={draft.address} onChange={(e) => edit({ address: e.target.value })}/>
          </FormField>
          <FormField label="Mobile">
            <input value={draft.mobile} onChange={(e) => edit({ mobile: e.target.value })}/>
          </FormField>
          <FormField label="E-mail">
            <input value={draft.email} onChange={(e) => edit({ email: e.target.value })}/>
          </FormField>
          <FormField label="Residential status">
            <SelectInput value={draft.residentialStatus} onChange={(v) => edit({ residentialStatus: v })}
              options={["Resident", "Resident but not ordinarily resident", "Non-resident"]}/>
          </FormField>
        </div>
      </div>

      <ProceedingScan draft={draft} onApply={onApplyScan}/>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">The search and the notice</div>
            <div className="card-sub">
              A19 and A20 together derive the whole block period — the form calls it "derived by system based on A19-A20". The date of
              service and the period the notice allowed fix the due date.
            </div>
          </div>
        </div>
        <div className="form-grid">
          <FormField label="Initiated under" required>
            <SelectInput value={draft.searchSection} onChange={(v) => edit({ searchSection: v })} options={SEARCH_SECTIONS}/>
          </FormField>
          <FormField label="First authorisation executed / requisition made" required>
            <input type="date" value={draft.searchDate || ""} onChange={(e) => onPeriodDate({ searchDate: e.target.value })}/>
          </FormField>
          {/* A20. Together with A19 this derives the whole block period, which
              is why the form calls the period itself "derived by system based
              on A19-A20" — and why a second date is not optional detail. */}
          <FormField label="Last of the authorisations executed">
            <input type="date" value={draft.lastAuthDate || ""} onChange={(e) => onPeriodDate({ lastAuthDate: e.target.value })}/>
          </FormField>
          <FormField label="Date of last panchnama">
            <input type="date" value={draft.lastPanchnamaDate || ""} onChange={(e) => edit({ lastPanchnamaDate: e.target.value })}/>
          </FormField>
          <FormField label="Return furnished under">
            <SelectInput value={draft.returnSection} onChange={(v) => edit({ returnSection: v })} options={RETURN_SECTIONS}/>
          </FormField>
          <FormField label="Notice u/s 158BC dated">
            <input type="date" value={draft.noticeDate || ""} onChange={(e) => edit({ noticeDate: e.target.value })}/>
          </FormField>
          <FormField label="DIN of the notice" required>
            <input value={draft.noticeDin} onChange={(e) => edit({ noticeDin: e.target.value })} placeholder="ITBA/…"
              style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5}}/>
          </FormField>
          <FormField label="Date of service" required>
            <input type="date" value={draft.serviceDate || ""} onChange={(e) => onServiceDate(e.target.value)}/>
          </FormField>
          <FormField label="Period allowed by the notice">
            <SelectInput
              value={String(draft.dueDateDays || 60)}
              onChange={(v) => edit({ dueDateDays: Number(v), dueDate: "" })}
              options={[
                { value: "60", label: "60 days — s.158BC(1)(a)" },
                { value: "90", label: "90 days — extended under the fifth proviso" },
              ]}
            />
          </FormField>
          <FormField label="Due date for filing">
            <input type="date" value={draft.dueDate || ""} onChange={(e) => edit({ dueDate: e.target.value })}/>
          </FormField>
          <FormField label="Date this return is furnished">
            <input type="date" value={draft.filedOn || ""} onChange={(e) => edit({ filedOn: e.target.value })}/>
          </FormField>
        </div>
        <div style={{display: "flex", gap: 24, flexWrap: "wrap", marginTop: 14}}>
          <label style={{display: "flex", alignItems: "center", gap: 10, fontSize: 13}}>
            <Toggle checked={!!draft.auditUs44AB} onChange={(v) => edit({ auditUs44AB: v })} label="Accounts audited u/s 44AB"/>
            Accounts audited u/s 44AB
          </label>
          <label style={{display: "flex", alignItems: "center", gap: 10, fontSize: 13}}>
            <Toggle checked={!!draft.booksFound} onChange={(v) => edit({ booksFound: v })} label="Books or documents found in the search"/>
            Books or documents found in the search
          </label>
        </div>

        {draft.searchDate && !period.ok && (
          <div style={{marginTop: 14, padding: "11px 13px", borderRadius: 12, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5, fontWeight: 500}}>
            <Icon name="alert" size={14}/> {period.reason}
          </div>
        )}
        {period.ok && (
          <div style={{marginTop: 14, padding: "11px 13px", borderRadius: 12, background: "var(--p-lavender-2)", fontSize: 12.5}}>
            Block period: <strong>{dateOf(period.from)} to {dateOf(period.to)}</strong> — Y6 to Y1 are A.Y. {period.years[0].ay} to
            A.Y. {period.years[5].ay}.{" "}
            {period.spansYears
              ? `The last authorisation was executed in a later previous year, so Y0 (A.Y. ${period.years[6].ay}) is a complete year and Y+1 (A.Y. ${period.years[7].ay}) is the part period up to ${dateOf(period.to)}.`
              : `Y0 (A.Y. ${period.years[6].ay}) is the part period from 1 April to ${dateOf(period.to)}.`}
          </div>
        )}
        <div style={{marginTop: 12, fontSize: 12.5}} className="muted">
          Rule 12AE(2) — this return must be furnished electronically under <strong>{furnishing.label}</strong>
          {furnishing.reason ? `, because the assessee is ${furnishing.reason}` : ""}.
        </div>
      </div>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">Verification</div>
            <div className="card-sub">The declaration printed at the foot of the return. Rule 12AE requires a digital signature for a company, a political party, and anyone whose accounts are audited u/s 44AB.</div>
          </div>
        </div>
        <div className="form-grid">
          <FormField label="Verified by">
            <input value={draft.verifierName} onChange={(e) => edit({ verifierName: e.target.value })}/>
          </FormField>
          <FormField label="Son / daughter of">
            <input value={draft.verifierFather} onChange={(e) => edit({ verifierFather: e.target.value })}/>
          </FormField>
          <FormField label="Capacity">
            <SelectInput value={draft.verifierCapacity} onChange={(v) => edit({ verifierCapacity: v })}
              options={["Self", "Karta", "Partner", "Director", "Principal Officer", "Trustee", "Authorised representative"]}/>
          </FormField>
          <FormField label="PAN of the verifier">
            <input value={draft.verifierPan} onChange={(e) => edit({ verifierPan: e.target.value.toUpperCase() })}
              style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"}}/>
          </FormField>
          <FormField label="Place">
            <input value={draft.verificationPlace} onChange={(e) => edit({ verificationPlace: e.target.value })}/>
          </FormField>
          <FormField label="Date">
            <input type="date" value={draft.verificationDate || ""} onChange={(e) => edit({ verificationDate: e.target.value })}/>
          </FormField>
        </div>
      </div>
    </>
  );
}

/* --------------------------- Parts B and C --------------------------- */

/* `draft` AND `result` both, deliberately.
 *
 * The header of each year card reads the computed row — the totals, the floor,
 * the credits added up. The panel inside it edits the DRAFT row, because
 * computeItrB() coerces every blank to a number for the arithmetic, and an
 * input bound to that shows a nil in every field nobody has filled in yet. A
 * form full of zeroes reads as a return that has been completed. */
function BlockTab({ draft, result, editYear, period, busyYear, syncedReturn, onFillYear, onFillAll, onReadIntimation, onFiles, fileRef }) {
  const [open, setOpen] = React.useState("");

  if (!period.ok) {
    return (
      <div className="card">
        <EmptyState
          icon="calendar"
          title="Enter the date of the search first"
          sub={period.reason || "The block period is the six previous years before the year of the search, plus the part of that year up to the date of the search. Everything on this tab follows from that one date."}
        />
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="card-head" style={{flexWrap: "wrap", gap: 12}}>
          <div>
            <div className="card-title">Income already declared</div>
            <div className="card-sub">
              Part C asks for the income already determined, assessed or declared for each year alongside the undisclosed income you
              declare in column [A]. Read it out of each year's filed return rather than keying it — the figure the department will
              reconcile against is the one in the return.
            </div>
          </div>
          <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
            <button className="btn btn-secondary btn-sm" onClick={onFillAll} disabled={busyYear === "all"}>
              <Icon name="refresh" size={13}/>{busyYear === "all" ? "Reading…" : "Fill from synced returns"}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={13}/>Upload ITR JSONs
            </button>
            <input
              ref={fileRef} type="file" accept="application/json,.json" multiple hidden
              onChange={(e) => { onFiles([...e.target.files], ""); e.target.value = ""; }}
            />
          </div>
        </div>
        <div className="muted" style={{fontSize: 11.5}}>
          Upload as many years at once as you like — each file is filed against the assessment year it states, not the row it was dropped on.
          {" "}Part C column [B] comes from the s.143(1) intimation rather than from the return, so where one is on file and has not
          been read yet, filling reads it once.
        </div>
      </div>

      <div style={{display: "flex", flexDirection: "column", gap: 12, marginTop: 14}}>
        {result.years.map((y) => {
          const ret = syncedReturn(y.ay);
          const expanded = open === y.key;
          return (
            <div key={y.key} className="card" style={{padding: 0, overflow: "hidden"}}>
              <div
                onClick={() => setOpen(expanded ? "" : y.key)}
                style={{display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", cursor: "pointer", flexWrap: "wrap"}}
              >
                <div style={{minWidth: 116, display: "flex", gap: 9, alignItems: "baseline"}}>
                  {/* The form's own row name, so the two sheets read alike. */}
                  <span className="pill pill-muted" style={{fontSize: 10.5, fontWeight: 700}}>{y.slot}</span>
                  <div>
                    <div style={{fontWeight: 700, fontSize: 14}}>A.Y. {y.ay}</div>
                    <div className="muted" style={{fontSize: 11}}>
                      P.Y. {y.py}{y.part ? ` · to ${dateOf(y.to)}` : ""}
                    </div>
                  </div>
                </div>
                {y.part && <span className="pill pill-info" style={{fontSize: 10.5}}>Part period</span>}
                <div style={{flex: 1, minWidth: 130}}>
                  <div className="muted" style={{fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em"}}>DECLARED</div>
                  <div style={{fontSize: 13.5, fontWeight: 600}}>
                    {returned(y)}
                    {y.declaredSource && (
                      <span className="pill pill-muted" style={{marginLeft: 8, fontSize: 10}}>
                        {y.declaredSource === "sync" ? "from sync" : y.declaredSource === "json" ? "from JSON" : "keyed"}
                        {y.declaredForm ? ` · ${y.declaredForm}` : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{minWidth: 130}}>
                  <div className="muted" style={{fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em"}}>UNDISCLOSED</div>
                  <div style={{fontSize: 13.5, fontWeight: 700, color: y.totalUndisclosed ? "var(--p-primary-2)" : "var(--p-text-3)"}}>
                    {y.totalUndisclosed ? fmtINR(y.totalUndisclosed) : "—"}
                  </div>
                </div>
                {ret?.jsonPath && !y.declaredSource && <span className="pill pill-success" style={{fontSize: 10.5}}>Return on file</span>}
                {y.floored && <span className="pill pill-warning" style={{fontSize: 10.5}} title="Heads net to a loss; the year is carried at nil — s.158BB(4)">Loss disregarded</span>}
                <Icon name={expanded ? "chevron-down" : "chevron-right"} size={16}/>
              </div>

              {expanded && (
                <div style={{padding: "0 18px 18px", borderTop: "1px solid var(--p-line)"}}>
                  <YearPanel
                    year={draft.years.find((row) => row.key === y.key) || y}
                    computed={y}
                    ret={ret} busy={busyYear === y.key} spansYears={result.spansYears} result={result}
                    onFill={() => onFillYear(y)}
                    onReadIntimation={() => onReadIntimation(y.ay, ret)}
                    onFiles={(files) => onFiles(files, y.ay)}
                    editYear={editYear}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card" style={{marginTop: 14}}>
        <div className="card-head">
          <div className="card-title">Block period totals</div>
        </div>
        <Table wide>
          <thead>
            <tr>
              <th>Head of income</th>
              {result.years.map((y) => <th key={y.key} style={{textAlign: "right"}}>{y.ay}</th>)}
              <th style={{textAlign: "right"}}>Total</th>
            </tr>
          </thead>
          <tbody>
            {UNDISCLOSED_HEADS.map((h) => (
              <tr key={h.key}>
                <td>{h.short}</td>
                {result.years.map((y) => (
                  <td key={y.key} style={{textAlign: "right"}}>{y.undisclosed[h.key] ? fmtINR(y.undisclosed[h.key]) : "—"}</td>
                ))}
                <td style={{textAlign: "right", fontWeight: 600}}>{result.byHead[h.key] ? fmtINR(result.byHead[h.key]) : "—"}</td>
              </tr>
            ))}
            <tr style={{fontWeight: 700}}>
              <td>Total undisclosed income</td>
              {result.years.map((y) => <td key={y.key} style={{textAlign: "right"}}>{y.totalUndisclosed ? fmtINR(y.totalUndisclosed) : "—"}</td>)}
              <td style={{textAlign: "right"}}>{fmtINR(result.totalUndisclosed)}</td>
            </tr>
          </tbody>
        </Table>
      </div>
    </>
  );
}

function YearPanel({ year, computed, result, ret, busy, spansYears, onFill, onReadIntimation, onFiles, editYear }) {
  const upload = React.useRef(null);
  const set = (patch) => editYear(year.key, patch);
  const setPartC = (key, v) => set({ partC: { ...year.partC, [key]: v } });
  const setPartA = (key, v) => set({ partA: { ...year.partA, [key]: v } });

  /* Which of Part A's three sets of questions this row gets, and the form's own
     field numbers for them — so the sheet and the portal screen agree. */
  const variant = variantFor(year, spansYears);
  // Part B is asked of the part period and of nothing else.
  const isPartBRow = result?.partBRow?.key === year.key;
  const numbers = {
    ...FIELD_NUMBERS[variant],
    __label: variant === "brief" ? "A26–A30" : variant === "full" ? (year.slot === "Y1" ? "A31" : "A33") : (year.slot === "Y0" ? "A32" : "A34"),
  };

  /* Column [B] read off the s.143(1) intimation this practice already holds.
     Offered, never applied: it comes from a language model's reading of a PDF,
     and everything else this tool fills in comes from a JSON the department
     itself produced. That difference should be visible, so this one waits to
     be accepted. */
  const suggestion = React.useMemo(() => determinedFromReturn(ret), [ret]);

  /* Column [B]'s own read, on its own button.
   *
   * It was only ever reachable through the whole-year fill, and when it failed
   * it said so in a notification that had gone by the time anybody looked at
   * the column. The figure is printed in the intimation and nowhere else, so
   * the one place that has to explain itself is the column — and the one place
   * to retry from is beside it. */
  const [bRead, setBRead] = React.useState({ busy: false, why: "" });
  const readIntimation = async () => {
    setBRead({ busy: true, why: "" });
    const out = await onReadIntimation();
    setBRead({ busy: false, why: out?.ok ? "" : (out?.why || "nothing came back") });
  };
  const cols = columnsFor(spansYears).filter((c) => appliesTo(c, year, spansYears));
  const setUndisclosed = (key, v) => set({ undisclosed: { ...year.undisclosed, [key]: v } });
  const setItem = (key, v) => set({ items: { ...year.items, [key]: v } });
  const setCredit = (key, v) => set({ credits: { ...year.credits, [key]: v } });

  /* Part D-II rows 11 and 12 are marked on the form "to be filled only in case
     Y0 is a complete year". For a part period s.158BB(3) puts that income
     outside the block return altogether (Note 4), so the fields are disabled
     rather than merely warned about — the amount does not belong here at all,
     and the aggregate VALUE of those transactions is what the form asks for
     instead, in A32/A34. */
  const blocked = (item) => item.completeYearOnly && year.part;

  return (
    <div style={{paddingTop: 16, display: "flex", flexDirection: "column", gap: 18}}>
      {/* ---- Part A, this year on the form ---- */}
      <div>
        <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4}}>
          <div style={{fontWeight: 700, fontSize: 12.5}}>Part A — the return for this year</div>
          <span className="pill pill-muted" style={{fontSize: 10}}>{numbers.__label}</span>
          <div style={{flex: 1}}/>
          <button className="btn btn-secondary btn-xs" onClick={onFill} disabled={busy || !ret}
            title={ret?.jsonPath
              ? "Read this year's return details from the copy already synced"
              : ret ? "Fill the acknowledgement number and date of filing from the portal's record" : "No return on file for this year"}>
            <Icon name="refresh" size={11}/>{busy ? "Reading…" : "From synced return"}
          </button>
          <button className="btn btn-secondary btn-xs" onClick={() => upload.current?.click()}>
            <Icon name="upload" size={11}/>Upload JSON
          </button>
          <input ref={upload} type="file" accept="application/json,.json" hidden
            onChange={(e) => { onFiles([...e.target.files]); e.target.value = ""; }}/>
        </div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
          {ret
            ? `On file: ${ret.form || "ITR"} · ack ${ret.ackNum || "—"} · filed ${dateOf(ret.filedOn)}${ret.jsonPath ? "" : " · the JSON for this year hasn't been synced, so upload it instead"}`
            : "The form asks a different set of questions of each part of the block; these are the ones it asks of this row."}
        </div>

        {variant === "partYear" ? (
          <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10}}>
            <div className="field">
              <label style={{fontSize: 11}}>{numbers.partYearIncome} Income of the period</label>
              {/* Derived, not asked for: the form sends the break-up of this to
                  Part B and states the same figure in Part C's part-period
                  columns. Three places for one number is two places to disagree. */}
              <input readOnly disabled value={fmtINR(partYearIncome(year, result))}
                style={{textAlign: "right", background: "var(--p-card-tint)", fontVariantNumeric: "tabular-nums"}}/>
              <span className="muted" style={{fontSize: 10.5, marginTop: 4}}>From Part C; break it up in Part B on the portal</span>
            </div>
            <div className="field">
              <label style={{fontSize: 11}}>{numbers.intlTxnValue} Aggregate value of international transactions</label>
              <Amount value={year.intlTxnValue} onChange={(v) => set({ intlTxnValue: v })}/>
            </div>
            <div className="field">
              <label style={{fontSize: 11}}>{numbers.sdtValue} Aggregate value of specified domestic transactions</label>
              <Amount value={year.sdtValue} onChange={(v) => set({ sdtValue: v })}/>
            </div>
          </div>
        ) : (
          <>
            {variant === "full" && (
              <label style={{display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, marginBottom: 12}}>
                <Toggle checked={year.returnFiled !== false} onChange={(v) => set({ returnFiled: v })} label="Return of income furnished"/>
                {numbers.returnFiled} Have you furnished a return of income for this year?
              </label>
            )}

            {variant === "full" && year.returnFiled === false ? (
              <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10}}>
                <div className="field">
                  <label style={{fontSize: 11}}>{numbers.dueDateExpired} Has the s.139(1) due date expired?</label>
                  <SelectInput value={year.partA?.dueDateExpired || ""} onChange={(v) => setPartA("dueDateExpired", v)}
                    options={["Yes", "No"]} placeholder="Select"/>
                </div>
                {year.partA?.dueDateExpired === "No" && (
                  <div className="field">
                    <label style={{fontSize: 11}}>{numbers.itrFormChosen} ITR form the income will be furnished in</label>
                    <SelectInput value={year.partA?.itrFormChosen || ""} onChange={(v) => setPartA("itrFormChosen", v)}
                      options={["ITR-1", "ITR-2", "ITR-3", "ITR-4", "ITR-5", "ITR-6", "ITR-7"]} placeholder="Select"/>
                  </div>
                )}
                <div className="muted" style={{fontSize: 11, gridColumn: "1 / -1"}}>
                  Where the due date has not expired, the income for the year goes in on a provisional basis and is
                  <strong> not</strong> treated as a return under s.139(1) — it still has to be included in the return for that
                  year when it is filed (Notes 2 and 3 to the form).
                </div>
              </div>
            ) : (
              <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10}}>
                <div className="field">
                  <label style={{fontSize: 11}}>{numbers.filedOn || numbers.returnFiled} Date of filing of the last return</label>
                  <input type="date" value={year.filedOn || ""} onChange={(e) => set({ filedOn: e.target.value })}/>
                </div>
                <div className="field">
                  <label style={{fontSize: 11}}>{numbers.filedSection} Section under which filed</label>
                  <SelectInput value={year.partA?.filedSection || ""} onChange={(v) => setPartA("filedSection", v)}
                    options={variant === "full" ? FILED_UNDER_RECENT : FILED_UNDER} placeholder="Select"/>
                </div>
                {variant === "full" && (
                  <div className="field">
                    <label style={{fontSize: 11}}>{numbers.itrForm} Type of ITR form filed</label>
                    <SelectInput value={year.declaredForm || ""} onChange={(v) => set({ declaredForm: v })}
                      options={["ITR-1", "ITR-2", "ITR-3", "ITR-4", "ITR-5", "ITR-6", "ITR-7"]} placeholder="Select"/>
                  </div>
                )}
                <div className="field">
                  <label style={{fontSize: 11}}>{numbers.ackNum} Acknowledgement or receipt no.</label>
                  <input value={year.ackNum || ""} onChange={(e) => set({ ackNum: e.target.value })}
                    style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5}}/>
                </div>
                {variant === "brief" && (
                  <div className="field">
                    <label style={{fontSize: 11}}>{numbers.pending} Assessment pending at the date of initiation?</label>
                    <SelectInput value={year.partA?.pending || ""} onChange={(v) => setPartA("pending", v)}
                      options={["No", ...PENDING_UNDER.map((x) => `Yes — s.${x}`)]} placeholder="Select"/>
                  </div>
                )}
                {variant === "full" && (
                  <>
                    <div className="field">
                      <label style={{fontSize: 11}}>{numbers.declaredTotal} Total income declared in the return</label>
                      <Amount value={year.declaredTotal} onChange={(v) => set({ declaredTotal: v, declaredSource: year.declaredSource || "manual" })}/>
                    </div>
                    <div className="field">
                      <label style={{fontSize: 11}}>{numbers.determined} Total income after processing u/s 143(1)</label>
                      {/* The same figure as Part C's column [B]. Shown, not asked
                          for twice: two inputs for one number is two answers. */}
                      <input readOnly disabled
                        value={year.partC?.determined === "" || year.partC?.determined === undefined ? "" : fmtINR(Number(year.partC.determined) || 0)}
                        style={{textAlign: "right", background: "var(--p-card-tint)", fontVariantNumeric: "tabular-nums"}}/>
                      <span className="muted" style={{fontSize: 10.5, marginTop: 4}}>Entered as Part C column [B] below</span>
                    </div>
                    <div className="field">
                      <label style={{fontSize: 11}}>{numbers.intlTxnValue} Aggregate value of international transactions</label>
                      <Amount value={year.intlTxnValue} onChange={(v) => set({ intlTxnValue: v })}/>
                    </div>
                    <div className="field">
                      <label style={{fontSize: 11}}>{numbers.sdtValue} Aggregate value of specified domestic transactions</label>
                      <Amount value={year.sdtValue} onChange={(v) => set({ sdtValue: v })}/>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* What the return itself said, head by head. Not a Part A field —
                context for the figures above, and read-only because it is what
                the department's own JSON states. */}
            {year.declaredSource && (
              <div style={{marginTop: 12}}>
                <div className="muted" style={{fontSize: 11, marginBottom: 6}}>As the return states it</div>
                <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8}}>
                  {HEADS.map((h) => (
                    <div key={h.key} className="field">
                      <label style={{fontSize: 10.5}}>{h.short}</label>
                      <input readOnly disabled
                        value={year.declared?.[h.key] === null || year.declared?.[h.key] === undefined ? "—" : year.declared[h.key]}
                        style={{textAlign: "right", background: "var(--p-card-tint)", fontVariantNumeric: "tabular-nums"}}/>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- undisclosed ---- */}
      <div>
        <div style={{fontWeight: 700, fontSize: 12.5, marginBottom: 4}}>Undisclosed income determined on the material found</div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
          Enter what the search brought out over and above the return, head by head. A head left blank is nil.
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 10}}>
          {UNDISCLOSED_HEADS.map((h) => (
            <div key={h.key} className="field">
              <label style={{fontSize: 11}}>{h.short}</label>
              <Amount value={year.undisclosed[h.key]} onChange={(v) => setUndisclosed(h.key, v)}/>
            </div>
          ))}
        </div>
        <div className="form-grid" style={{marginTop: 12}}>
          <FormField label="Manner in which the income was derived — s.158BC(1)(a)" full>
            <textarea rows={2} value={year.manner} onChange={(e) => set({ manner: e.target.value })}
              placeholder="e.g. Cash sales suppressed and kept out of the books."/>
          </FormField>
          <FormField label="Material it is based on" full>
            <input value={year.evidence} onChange={(e) => set({ evidence: e.target.value })}
              placeholder="e.g. Annexure A-3, pages 12–31, seized from the business premises"/>
          </FormField>
        </div>
      </div>

      {/* ---- Part B, on the one row it belongs to ---- */}
      {isPartBRow && <PartBSchedule year={year} result={result} set={set}/>}

      {/* ---- Part C, columns [B] to [H] ---- */}
      <div>
        <div style={{fontWeight: 700, fontSize: 12.5, marginBottom: 4}}>Part C — income already on record</div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
          What was already determined, assessed or declared for this year. None of it is added to or taken off the undisclosed income
          in column [A] — the form states it so the officer can see what the block income sits on top of.
        </div>

        {/* WHERE COLUMN [B] CAME FROM, IN THREE STATES.
            Filled by the sync fill — say so, and say which order and which row,
            because this is the one figure on the screen that came out of a
            model reading a PDF rather than out of the department's own data.
            Not yet filled — offer it. Filled by hand while an intimation on
            file says something else — leave the figure alone and print what the
            order reads, which is a cross-check worth having. */}
        {year.partC?.determinedFrom ? (
          <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "9px 12px", borderRadius: 10, background: "var(--p-mint)", color: "#1B8C5C", fontSize: 12}}>
            <Icon name="check" size={13}/>
            <span>
              Column [B] read off the intimation
              {year.partC.determinedFrom.orderDate ? ` dated ${dateOf(year.partC.determinedFrom.orderDate)}` : ""}
              {year.partC.determinedFrom.head ? `, against “${year.partC.determinedFrom.head}”` : ""} — check it against the order.
            </span>
          </div>
        ) : suggestion ? (
          <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "9px 12px", borderRadius: 10, background: "var(--p-lavender-2)", fontSize: 12}}>
            <Icon name="sparkle" size={13}/>
            <span>
              The intimation on file reads <strong>{fmtINR(suggestion.amount)}</strong> against “{suggestion.head}”
              {suggestion.orderDate ? ` (order dated ${dateOf(suggestion.orderDate)})` : ""}.
            </span>
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => set({ partC: { ...year.partC, determined: suggestion.amount, determinedSection: "143(1)" } })}
            >
              Use for column [B]
            </button>
          </div>
        ) : (
          /* NOT FILLED, AND SAYING SO WHERE THE COLUMN IS.
             [B] is the income CPC determined. It is printed in the intimation
             and stated in no record, so when it is blank the question is always
             the same — what happened to the intimation? — and the answer has to
             be here rather than in a notification that has already gone. */
          <div style={{marginBottom: 12, padding: "9px 12px", borderRadius: 10, background: bRead.why ? "var(--p-amber)" : "var(--p-card-tint)", fontSize: 12}}>
            <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap"}}>
              <span style={{flex: 1, minWidth: 220, color: bRead.why ? "#8A5B10" : "var(--p-text-2)"}}>
                {bRead.why
                  ? <>Column [B] is still yours — {bRead.why}.</>
                  : <>Column [B] is the income CPC determined. It is printed in the s.143(1) intimation and in no record, so it has to be read off the order.</>}
              </span>
              <button className="btn btn-secondary btn-xs" onClick={readIntimation} disabled={bRead.busy || !ret}
                title={ret ? "Read this year's intimation and fill column [B]" : "No return on file for this year"}>
                <Icon name="sparkle" size={11}/>{bRead.busy ? "Reading…" : "Read the intimation"}
              </button>
            </div>
          </div>
        )}

        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12}}>
          {cols.map((c) => (
            <div key={c.key} className="field">
              <label style={{fontSize: 11}}>
                [{c.letter}] {c.short}
                <span className="muted" style={{fontWeight: 500}}> · s.{c.ref}</span>
              </label>
              <div title={labelFor(c, spansYears)}>
                <Amount value={year.partC?.[c.key]} onChange={(v) => setPartC(c.key, v)}/>
              </div>
              {c.hasSection && (
                <div style={{marginTop: 6}}>
                  <SelectInput
                    value={year.partC?.[`${c.key}Section`] || ""}
                    onChange={(v) => setPartC(`${c.key}Section`, v)}
                    options={c.key === "returned" ? ["139(1)", "142(1)"] : ASSESSED_UNDER}
                    placeholder="Section"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        {cols.length < columnsFor(spansYears).length && (() => {
          const missing = columnsFor(spansYears).filter((c) => !appliesTo(c, year, spansYears));
          const one = missing.length === 1;
          return (
            <div className="muted" style={{fontSize: 11, marginTop: 8}}>
              {one ? "Column" : "Columns"} {missing.map((c) => `[${c.letter}]`).join(" ")} {one ? "describes another period" : "describe other periods"} of
              the block and {one ? "is" : "are"} not filled against {year.slot}.
            </div>
          );
        })()}
      </div>

      {/* ---- Part D-II ---- */}
      <div>
        <div style={{display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4}}>
          <div style={{fontWeight: 700, fontSize: 12.5}}>Part D-II — item-wise break-up</div>
          {computed.itemTotal > 0 && (
            <span className={`pill ${computed.itemMismatch ? "pill-danger" : "pill-success"}`} style={{fontSize: 10.5}}>
              {computed.itemMismatch
                ? `${fmtINR(computed.itemTotal)} against ${fmtINR(computed.totalUndisclosed)} in Part D-I`
                : "Ties to Part D-I"}
            </span>
          )}
        </div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
          The same undisclosed income, described item by item. The form requires this to total exactly what Part D-I totals.
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10}}>
          {DII_ITEMS.map((item) => (
            <div key={item.key} className="field">
              <label style={{fontSize: 11}}>
                {item.no}. {item.label}
                {blocked(item) && <span className="muted"> — not in a part period</span>}
              </label>
              <Amount
                value={blocked(item) ? "" : year.items?.[item.key]}
                onChange={(v) => setItem(item.key, v)}
                disabled={blocked(item)}
              />
            </div>
          ))}
        </div>

        {year.part && (
          <div style={{marginTop: 14, padding: "12px 14px", borderRadius: 12, background: "var(--p-lavender-2)"}}>
            <div style={{fontWeight: 700, fontSize: 12.5, marginBottom: 4}}>
              International and specified domestic transactions — s.158BB(3)
            </div>
            <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
              Undisclosed income on this account for a part period is assessed under the ordinary provisions and is
              <strong> not part of this return</strong> (Note 4 to the form). What the form asks for here is the aggregate
              <em> value</em> of the transactions in the part period, not income.
            </div>
            <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10}}>
              <div className="field">
                <label style={{fontSize: 11}}>Aggregate value of international transactions</label>
                <Amount value={year.intlTxnValue} onChange={(v) => set({ intlTxnValue: v })}/>
              </div>
              <div className="field">
                <label style={{fontSize: 11}}>Aggregate value of specified domestic transactions</label>
                <Amount value={year.sdtValue} onChange={(v) => set({ sdtValue: v })}/>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ---- credits ---- */}
      <div>
        <div style={{fontWeight: 700, fontSize: 12.5, marginBottom: 4}}>Taxes already paid for this year</div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
          Advance tax and self-assessment tax paid earlier go to <strong>Part G</strong>; TDS and TCS <em>not claimed in any
          earlier return</em> go to <strong>Part H</strong>. Rule 12AE(4): every credit here except self-assessment tax for
          the block period itself is allowed only on the Assessing Officer&apos;s verification and satisfaction.
          {" "}All four fill from the return. <strong>Part H needs cutting down</strong>: what the return states is the credit
          it <em>did</em> claim, so the figure that lands there is a starting point, not an answer — reduce it by whatever has
          already been allowed.
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 10}}>
          {[["advance", "Advance tax — Part G"], ["selfAssessment", "Self-assessment tax — Part G"], ["tds", "TDS — Part H"], ["tcs", "TCS — Part H"]].map(([k, label]) => (
            <div key={k} className="field">
              <label style={{fontSize: 11}}>{label}</label>
              <Amount value={year.credits?.[k]} onChange={(v) => setCredit(k, v)}/>
              {/* PART H IS FILLED WITH A FIGURE THAT NEEDS REDUCING.
                  It asks for credit "not claimed in any earlier return", and
                  what the return states is the credit it DID claim — so this
                  box starts at the return's figure and has to come down by
                  whatever was already allowed. Said in amber, under the box,
                  every time: the officer catches an unreduced figure under rule
                  12AE(4), but late, and by somebody else. */}
              {(k === "tds" || k === "tcs") && year.claimed?.[k] !== null && year.claimed?.[k] !== undefined && (
                <span style={{fontSize: 10.5, marginTop: 4, color: "#8A5B10"}}>
                  {fmtINR(year.claimed[k])} was claimed in the return — reduce this by whatever has already been allowed
                </span>
              )}
              {/* Part G IS filled, and says where from. The check it cannot make
                  for anybody: whether that payment has already been given credit
                  in the regular assessment for the year. */}
              {(k === "advance" || k === "selfAssessment") && year.declaredSource && year.credits?.[k] !== "" && (
                <span className="muted" style={{fontSize: 10.5, marginTop: 4}}>
                  From the return for A.Y. {year.ay} — check it has not already been credited there
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Documents the practitioner has that the portal never sent.
 *
 * The panchnama is the reason this exists. It is handed over on paper on the
 * day the search concludes and reaches the portal only if somebody later files
 * it as an annexure to a reply — so on a great many cases there is nothing in
 * this app to read, and the two dates the whole block period hangs off are
 * sitting on a scanner in the practitioner's office. This takes them.
 *
 * They go to the same reader as everything else, and come back in the same
 * manifest with the same quotes: for the purpose of reading a date out of a
 * document, where it came from makes no difference.
 *
 * PDF ONLY, REFUSED BY ITS BYTES. The rules are in itrb/uploads.js. A file is
 * checked before it is uploaded rather than after, because the alternative is a
 * read that costs money and comes back empty with nobody able to say why. */
function SearchDocUploads({ docs, onChange, notify }) {
  const inputRef = React.useRef(null);
  const [busy, setBusy] = React.useState("");

  const add = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const uid = auth.currentUser?.uid;
    if (!uid) { notify("Sign in again before uploading.", "alert"); return; }

    const added = [];
    for (const file of files) {
      let head;
      try { head = new Uint8Array(await file.slice(0, 8).arrayBuffer()); } catch { head = new Uint8Array(); }
      const check = checkUpload(file, head, docs.length + added.length);
      if (!check.ok) { notify(check.reason, "alert"); continue; }

      setBusy(file.name);
      const path = uploadPath(uid, crypto.randomUUID());
      try {
        await uploadBytes(storageRef(storage, path), file, {
          contentType: "application/pdf",
          contentDisposition: `attachment; filename="${file.name.replace(/["\\]/g, "")}"`,
        });
        added.push({ name: file.name, storagePath: path, bytes: file.size, at: new Date().toISOString() });
      } catch (e) {
        console.error("itr-b: upload", e);
        notify(`Couldn't upload ${file.name} — ${e?.code || e?.message || "error"}`, "alert");
      }
    }
    setBusy("");
    if (added.length) {
      onChange([...docs, ...added]);
      notify(`${added.length} document${added.length === 1 ? "" : "s"} added. Press “Read the search dates”.`);
    }
  };

  /* Removed from Storage as well as from the draft. A document uploaded by
     mistake — the wrong client's panchnama — should not stay in the practice's
     files because somebody only unticked it. */
  const remove = async (doc) => {
    onChange(docs.filter((d) => d.storagePath !== doc.storagePath));
    try { await deleteObject(storageRef(storage, doc.storagePath)); }
    catch (e) { console.warn("itr-b: couldn't delete upload", doc.storagePath, e); }
  };

  return (
    <div style={{marginTop: 10}}>
      <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap"}}>
        <div style={{flex: 1, minWidth: 200}}>
          <div style={{fontWeight: 700, fontSize: 12.5}}>Add the panchnama, or any notice</div>
          <div className="muted" style={{fontSize: 11.5}}>
            PDF only, up to {MAX_UPLOADS}. The panchnama is the document that states when the search concluded, and it is
            usually not on the portal at all — upload it here and it is read with everything else.
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => inputRef.current?.click()} disabled={Boolean(busy) || docs.length >= MAX_UPLOADS}>
          <Icon name="upload" size={13}/>{busy ? `Uploading ${shortName(busy, 22)}…` : "Add a PDF"}
        </button>
        <input
          ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden
          onChange={(e) => { add(e.target.files); e.target.value = ""; }}
        />
      </div>

      {docs.length > 0 && (
        <div style={{marginTop: 8, display: "flex", flexDirection: "column", gap: 5}}>
          {docs.map((d) => (
            <div key={d.storagePath} style={{
              display: "flex", alignItems: "center", gap: 9, padding: "7px 10px",
              background: "white", border: "1px solid var(--p-line-2)", borderRadius: 9, fontSize: 12,
            }}>
              <span style={{fontSize: 8.5, fontWeight: 800, padding: "2px 5px", borderRadius: 4, background: "var(--p-pink)", color: "#C13388", flexShrink: 0}}>PDF</span>
              <span style={{flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}} title={d.name}>{d.name}</span>
              {d.bytes ? <span className="muted" style={{fontSize: 10.5, flexShrink: 0}}>{Math.max(1, Math.round(d.bytes / 1024))} KB</span> : null}
              <button className="icon-btn danger" title={`Remove ${d.name}`} onClick={() => remove(d)}>
                <Icon name="trash" size={12}/>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* What the practice already holds about this search.
 *
 * A search case does not arrive here as an ITR-B draft. It arrives as a
 * proceeding under Matters, with the s.158BC notice in it and the panchnama
 * attached to it. This finds that proceeding and takes what it can.
 *
 * TWO SOURCES, SHOWN APART. The DIN, the notice date, the date of service and
 * the period allowed are recorded fields — as reliable as the portal sync that
 * wrote them, so they go in on one press. The two dates that fix the block
 * period are in the prose of the documents and come back from a language model
 * reading them, so they arrive with the sentence they were read from and go
 * nowhere until somebody has looked at it. One of these is a lookup and the
 * other is a reading, and they should not arrive looking alike. */
/* What became of every file the reader was given.
 *
 * The reader's first live run said "the documents don't state the search dates
 * in a form that could be read", which was not true and not checkable: what had
 * actually happened was that one notice was read out of three and its archive
 * was never opened. A statement about what a document does not say is worthless
 * unless the reader also says WHICH documents it opened — so this card is shown
 * on every run, found or not found, and it is open by default when nothing was
 * found, because that is when it is the answer rather than the footnote. */
const FILE_STATUS = {
  read: { label: "Read", bg: "var(--p-mint)", fg: "#1B8C5C" },
  archive: { label: "Opened", bg: "var(--p-lavender-2)", fg: "#5A4B9C" },
  encrypted: { label: "Password", bg: "var(--p-amber)", fg: "#8A5B10" },
  "too-large": { label: "Left out", bg: "var(--p-amber)", fg: "#8A5B10" },
  unreadable: { label: "Not opened", bg: "var(--p-amber)", fg: "#8A5B10" },
  skipped: { label: "Not a document", bg: "var(--p-lavender)", fg: "var(--p-text-3)" },
};

function FilesRead({ manifest, notices, uploads, passedOver, open, onToggle }) {
  if (!manifest?.length) return null;
  const read = manifest.filter((m) => m.status === "read").length;
  const opened = manifest.filter((m) => m.status === "archive").length;

  return (
    <div style={{marginTop: 12, border: "1px solid var(--p-line)", borderRadius: 12, overflow: "hidden"}}>
      <button
        onClick={onToggle}
        style={{width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 13px", background: "var(--p-card-tint)", border: 0, cursor: "pointer", textAlign: "left", font: "inherit"}}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={13}/>
        <span style={{fontWeight: 700, fontSize: 12.5}}>
          {read} of {manifest.filter((m) => m.status !== "archive").length} file{manifest.length === 1 ? "" : "s"} read
        </span>
        <span className="muted" style={{fontSize: 11.5}}>
          {[
            notices ? `across ${notices} notice${notices === 1 ? "" : "s"}` : "",
            uploads ? `${uploads} you uploaded` : "",
            opened ? `${opened} archive${opened === 1 ? "" : "s"} opened` : "",
          ].filter(Boolean).join(", ")}
        </span>
      </button>

      {open && (
        <div style={{padding: "4px 0"}}>
          {manifest.map((m, i) => {
            const tone = FILE_STATUS[m.status] || FILE_STATUS.skipped;
            return (
              <div key={`${m.name}-${i}`} style={{display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 13px", borderTop: i ? "1px solid var(--p-line)" : 0}}>
                {/* Files that came out of an archive are indented under it, so
                    the card reads as the bundle rather than as a flat list. */}
                <div style={{flex: 1, minWidth: 0, paddingLeft: m.from ? 18 : 0}}>
                  <div style={{fontSize: 12.5, wordBreak: "break-word"}}>{m.name}</div>
                  <div className="muted" style={{fontSize: 11}}>
                    {[m.from ? `in ${m.from}` : "", m.notice, m.detail, m.bytes ? `${Math.max(1, Math.round(m.bytes / 1024))} KB` : ""].filter(Boolean).join("  ·  ")}
                  </div>
                </div>
                <span style={{flexShrink: 0, padding: "2px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, background: tone.bg, color: tone.fg}}>{tone.label}</span>
              </div>
            );
          })}
          {/* What was deliberately NOT sent. A reply carries the client's
              ledgers and confirmations by the dozen and none of them can state
              when a search was authorised, so only the ones named as search
              documents are read — said out loud, so a miss is visible. */}
          {passedOver > 0 && (
            <div className="muted" style={{fontSize: 11, padding: "8px 13px", borderTop: "1px solid var(--p-line)"}}>
              {passedOver} other document{passedOver === 1 ? "" : "s"} in the replies already filed {passedOver === 1 ? "was" : "were"} not
              sent — nothing in {passedOver === 1 ? "its name" : "their names"} suggests a panchnama or a warrant of authorisation.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* What the practice already holds about this search.
 *
 * A search case does not arrive here as an ITR-B draft. It arrives as a
 * proceeding under Matters, with the s.158BC notice in it and the panchnama
 * attached to it. This finds that proceeding and takes what it can.
 *
 * TWO SOURCES, SHOWN APART. The DIN, the notice date, the date of service and
 * the period allowed are recorded fields — as reliable as the portal sync that
 * wrote them, so they go in on one press. The two dates that fix the block
 * period are in the prose of the documents and come back from a language model
 * reading them, so they arrive with the sentence they were read from and go
 * nowhere until somebody has looked at it. One of these is a lookup and the
 * other is a reading, and they should not arrive looking alike. */
function ProceedingScan({ draft, onApply }) {
  const { data, notify } = useData();
  const [scan, setScan] = React.useState(null);
  const [reading, setReading] = React.useState(false);
  const [dates, setDates] = React.useState(null);
  const [manifest, setManifest] = React.useState(null);
  const [passedOver, setPassedOver] = React.useState(0);
  const [filesOpen, setFilesOpen] = React.useState(false);

  const pan = (draft.pan || "").toUpperCase();
  const uploaded = draft.searchDocs || [];
  const readCount = readingOrder(scan || {}).length;
  const uploadCount = uploaded.length;
  // Kept apart on purpose: the sentence below has to say where each document
  // came from, and a total that mixes them says nothing useful.
  const portalCount = (scan?.attachments?.length || 0) + (scan?.replies?.picked?.length || 0);
  const docCount = portalCount + uploadCount;

  const run = () => {
    const found = findBlockProceedings(data, pan);
    const { fields, conflicts, source } = fieldsFromNotices(found.notices);
    setScan({ ...found, fields, conflicts, source });
    setDates(null);
    setManifest(null);
    setPassedOver(0);
    if (found.notices.length) {
      onApply(fields);
      notify(describeScan(found));
    } else {
      notify("Nothing on file for this PAN under s.158BC or s.158BD.", "alert");
    }
  };

  /* The two dates, read out of EVERY notice on the proceeding and everything
     attached to them, archives opened.
     
     Not the notice that starts the return alone: that one calls for the return
     and states when the search began, while the date it CONCLUDED is in the
     panchnama, which arrives separately and usually inside a ZIP. The reader is
     given the whole bundle in one call and reports back what it opened. */
  const readDates = async () => {
    const order = readingOrder(scan || {});
    const uploads = (draft.searchDocs || []).map((d) => ({ name: d.name, storagePath: d.storagePath }));
    if (!order.length && !uploads.length) return;
    setReading(true);
    try {
      const call = httpsCallable(functions, "readBlockSearchDates");
      // Uploads are not cached against anything, so a read that includes one is
      // always fresh — `force` keeps a cached answer from an earlier run of the
      // notices alone from being handed back instead.
      const res = await call({ noticeId: order[0], noticeIds: order, uploads, force: uploads.length > 0 });
      const out = res?.data || {};
      const bs = out.blockSearch;

      // The manifest is kept whatever happened — it is the only thing that can
      // tell "the panchnama says nothing" apart from "no panchnama was ever
      // uploaded", and those need different work from the practitioner.
      setManifest(bs?.manifest || out.manifest || null);
      setPassedOver(bs?.repliesPassedOver ?? out.repliesPassedOver ?? 0);

      if (out.ok === false) {
        setDates(null);
        setFilesOpen(true);
        notify(out.message || "None of the files on this proceeding could be opened.", "alert");
        return;
      }
      if (!bs || (!bs.initiationDate && !bs.lastAuthorisationDate)) {
        setDates(null);
        setFilesOpen(true);
        notify(
          `Read ${bs?.read || 0} file${bs?.read === 1 ? "" : "s"} and none of them states the search dates. `
          + "The panchnama is what usually does — check it is on the proceeding, or enter the dates by hand.",
          "alert"
        );
        return;
      }
      setDates(bs);
      setFilesOpen(false);
    } catch (e) {
      console.error("itr-b: search dates", e);
      notify(e?.message?.slice(0, 240) || "Couldn't read the documents.", "alert");
    } finally {
      setReading(false);
    }
  };

  const applyDates = ({ sameDay = false } = {}) => {
    const patch = {};
    if (dates.initiationDate) patch.searchDate = dates.initiationDate;
    if (dates.lastAuthorisationDate) patch.lastAuthDate = dates.lastAuthorisationDate;
    /* The same-day reading, taken only when the practitioner presses the button
       that says so. A19 is set to the end of the printed block period — not
       because the search began that day, but because it is the one value that
       makes the derived period match the period the department printed. */
    if (sameDay && !dates.initiationDate && dates.lastAuthorisationDate) patch.searchDate = dates.lastAuthorisationDate;
    if (dates.panchnamaDates?.length) patch.lastPanchnamaDate = dates.panchnamaDates[dates.panchnamaDates.length - 1];
    if (dates.searchSection) patch.searchSection = dates.searchSection;

    /* THE NOTICE'S PARTICULARS, ONLY WHERE THERE IS NOTHING THERE.
     *
     * Read out of an uploaded notice, which by definition is one the portal
     * never sent — so for those fields there is no record to prefer, and
     * leaving them blank helps nobody. But a value that DID come from the
     * portal sync is authoritative and a language model reading a scan does not
     * get to argue with it. Hence: fill the empty, never touch the filled. */
    for (const [field, value] of [
      ["noticeDin", dates.notice?.din], ["noticeDate", dates.notice?.date],
      ["serviceDate", dates.notice?.serviceDate], ["dueDate", dates.notice?.dueDate],
      ["returnSection", dates.notice?.section],
    ]) {
      if (value && !draft[field]) patch[field] = value;
    }
    onApply(patch);
    notify(sameDay
      ? "Block period set to the one printed on the notice. A19 is the same day as A20 — correct it from the panchnama if the search began earlier."
      : "Search dates applied — the block period follows from them, so check it.");
  };

  return (
    <div className="card" style={{marginTop: 16}}>
      <div className="card-head" style={{flexWrap: "wrap", gap: 12}}>
        <div>
          <div className="card-title">From the proceeding on file</div>
          <div className="card-sub">
            The s.158BC notice is very likely already under this assessee&apos;s Matters — take the particulars from there
            rather than keying them again. The panchnama usually is not, so upload it below and it is read with the rest.
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={run} disabled={!pan}
          title={pan ? "Search this assessee's matters and notices" : "Pick the assessee first"}>
          <Icon name="search" size={13}/>Find the s.158BC proceeding
        </button>
      </div>

      {scan && (
        <div style={{display: "flex", flexDirection: "column", gap: 10}}>
          <div style={{fontSize: 12.5}}>{describeScan(scan)}</div>

          {scan.matters.length > 0 && (
            <div className="muted" style={{fontSize: 11.5}}>
              {scan.matters.map((m) => `${m.type || "Proceeding"}${m.section ? ` u/s ${m.section}` : ""}${m.bench ? ` · ${m.bench}` : ""}`).join("  ·  ")}
            </div>
          )}

          {scan.source && (
            <div style={{padding: "10px 13px", borderRadius: 10, background: "var(--p-mint)", color: "#1B8C5C", fontSize: 12.5}}>
              Filled from the notice dated {dateOf(scan.source.date)}
              {scan.source.din ? ` — DIN ${scan.source.din}` : ""}:{" "}
              {Object.keys(scan.fields).length ? Object.keys(scan.fields).map((k) => ({
                noticeDin: "DIN", noticeDate: "notice date", serviceDate: "date of service",
                dueDate: "due date", returnSection: "the limb of s.158BC",
              })[k] || k).join(", ") : "nothing it did not already have"}.
            </div>
          )}

          {scan.conflicts.map((c) => (
            <div key={c.field} style={{padding: "10px 13px", borderRadius: 10, background: "var(--p-amber)", color: "#8A5B10", fontSize: 12.5}}>
              {c.field} differs between the notices on file — {c.seen.map(dateOf).join(" and ")}. Left blank; read the notices and enter it.
            </div>
          ))}

        </div>
      )}

      {/* THE SEARCH DATES, WHATEVER THE PROCEEDING HOLDS.
          Outside the scan block on purpose. A practitioner whose client has
          just been searched may have nothing on the portal yet and the
          panchnama on their desk — that is the case this feature is FOR, and
          gating the upload behind a scan that finds nothing would shut them
          out of it. */}
      <div style={{borderTop: "1px solid var(--p-line)", marginTop: 12, paddingTop: 12}}>
              <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap"}}>
                <div style={{flex: 1, minWidth: 200}}>
                  <div style={{fontWeight: 700, fontSize: 12.5}}>The two search dates</div>
                  <div className="muted" style={{fontSize: 11.5}}>
                    A19 and A20 are in the prose of the notice and the panchnama, not in any record.{" "}
                    {docCount === 0
                      ? "Nothing to read yet — find the proceeding above, or upload the panchnama below."
                      : `${[
                          portalCount && `${portalCount} document${portalCount === 1 ? "" : "s"} on ${readCount} notice${readCount === 1 ? "" : "s"}`,
                          uploadCount && `${uploadCount} you uploaded`,
                        ].filter(Boolean).join(", and ")} ${docCount === 1 ? "is" : "are"} read together, and any ZIP among them is opened first.`}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={readDates} disabled={reading || !docCount}
                  title={docCount ? `Read ${docCount} document${docCount === 1 ? "" : "s"}` : "Find the proceeding, or add a PDF, first"}>
                  <Icon name="sparkle" size={13}/>{reading ? "Reading…" : "Read the search dates"}
                </button>
              </div>

              <SearchDocUploads docs={uploaded} onChange={(next) => onApply({ searchDocs: next })} notify={notify}/>

              {dates && (
                <div style={{marginTop: 12, padding: "12px 14px", borderRadius: 12, background: "var(--p-lavender-2)"}}>
                  {[
                    ["A19  Search initiated", dates.initiationDate, dates.quotes?.initiationDate],
                    ["A20  Last authorisation executed", dates.lastAuthorisationDate,
                      dates.lastAuthFrom === "blockPeriod"
                        ? dates.quotes?.blockPeriod || "from the block period printed on the notice"
                        : dates.quotes?.lastAuthorisationDate],
                  ].map(([label, value, quote]) => (
                    <div key={label} style={{marginBottom: 8}}>
                      <div style={{fontSize: 12.5}}>
                        <span className="muted">{label}</span> — <strong>{value ? dateOf(value) : "not stated in the documents"}</strong>
                      </div>
                      {/* The sentence it was read from. These two dates decide
                          seven years of assessment between them; a date offered
                          without its source cannot be checked. */}
                      {quote && <div className="muted" style={{fontSize: 11, fontStyle: "italic", marginTop: 2}}>“{quote}”</div>}
                    </div>
                  ))}
                  {dates.panchnamaDates?.length > 0 && (
                    <div style={{fontSize: 12.5, marginBottom: 8}}>
                      <span className="muted">Panchnama</span> — {dates.panchnamaDates.map(dateOf).join(", ")}
                    </div>
                  )}
                  {/* THE BLOCK PERIOD AS THE DEPARTMENT PRINTED IT.
                      Every notice in a block assessment carries it in the
                      letterhead. Its end date is A20 by definition — s.158B(b)
                      says the period ends when the last authorisation was
                      executed — and its start date fixes the YEAR of initiation
                      and not the day, which is why A19 is still offered
                      separately and labelled for what it is. */}
                  {dates.statedPeriod && (() => {
                    const check = statedPeriodAgrees(dates.statedPeriod);
                    return (
                      <div style={{marginTop: 4, marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "white"}}>
                        <div style={{fontSize: 12.5}}>
                          The notice prints the block period as{" "}
                          <strong>{dateOf(dates.statedPeriod.from)} — {dateOf(dates.statedPeriod.to)}</strong>.
                        </div>
                        {dates.statedPeriod.quote && (
                          <div className="muted" style={{fontSize: 11, fontStyle: "italic", marginTop: 2}}>“{dates.statedPeriod.quote}”</div>
                        )}
                        <div className="muted" style={{fontSize: 11.5, marginTop: 6}}>
                          {check?.agrees
                            ? "Its end date is A20 — s.158B(b) defines the block period as ending on the date the last authorisation was executed. Its start date fixes the year the search began, not the day, so taking that same day for A19 reproduces exactly this period."
                            : `Its start date does not line up: a search concluding ${dateOf(dates.statedPeriod.to)} gives a block period from ${dateOf(check?.derivedFrom)}. Read the documents before relying on either.`}
                        </div>
                      </div>
                    );
                  })()}
                  <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
                    <button className="btn btn-primary btn-sm" onClick={() => applyDates()} disabled={!dates.initiationDate && !dates.lastAuthorisationDate}>
                      <Icon name="check" size={13}/>Use these dates
                    </button>
                    {!dates.initiationDate && dates.statedPeriod && statedPeriodAgrees(dates.statedPeriod)?.agrees && (
                      <button className="btn btn-secondary btn-sm" onClick={() => applyDates({sameDay: true})}>
                        <Icon name="check" size={13}/>Use the printed block period — A19 and A20 both {dateOf(dates.statedPeriod.to)}
                      </button>
                    )}
                  </div>
                  <div className="muted" style={{fontSize: 11, marginTop: 8}}>Read from a scan — check them against the documents.</div>
                </div>
              )}

              {/* THE PAN ON THE DOCUMENT AGAINST THE PAN ON THE DRAFT.
                  Uploading the wrong client's panchnama is an easy mistake and
                  a serious one — it would set a block period from another
                  person's search. Nothing is blocked, because a document may
                  legitimately name a different person, but it is said. */}
              {dates?.notice?.pan && pan && dates.notice.pan !== pan && (
                <div style={{marginTop: 10, padding: "10px 13px", borderRadius: 10, background: "var(--p-amber)", color: "#8A5B10", fontSize: 12.5}}>
                  These documents are addressed to <strong>{dates.notice.pan}</strong>, and this draft is for <strong>{pan}</strong>.
                  Check you have uploaded the right client&apos;s papers before using anything read from them.
                </div>
              )}

              <FilesRead
                manifest={manifest}
                passedOver={passedOver}
                notices={dates?.notices ?? readCount}
                uploads={uploadCount}
                open={filesOpen}
                onToggle={() => setFilesOpen((v) => !v)}
              />
      </div>
    </div>
  );
}

/* Where each part of the form stands.
 *
 * The flat list below this one says what is WRONG with a draft. This says what
 * is BLANK, and says it per part, because that is how somebody keying the
 * portal works — down the form, one part at a time, needing to know which parts
 * they can leave. A hole nobody can see is the failure mode a transcription
 * sheet has and a computation does not: a computation is visibly wrong when a
 * figure is missing, and a sheet just looks finished. */
function PartsPanel({ draft, result }) {
  const parts = React.useMemo(() => completeness(draft, result), [draft, result]);
  const { done, total, complete } = summarise(parts);
  const tone = {
    [STATUS.DONE]: { bg: "var(--p-mint)", fg: "#1B8C5C", label: "Done" },
    [STATUS.PARTIAL]: { bg: "var(--p-amber)", fg: "#8A5B10", label: "Partly" },
    [STATUS.EMPTY]: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)", label: "Not started" },
    [STATUS.NA]: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)", label: "N/A" },
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Where the form stands</div>
          <div className="card-sub">
            {complete
              ? "Every part has something in it. Check the figures against the seized material before filing."
              : `${done} of ${total} parts complete. Nothing here stops the documents being produced.`}
          </div>
        </div>
      </div>
      <div style={{display: "flex", flexDirection: "column", gap: 8}}>
        {parts.map((p) => {
          const t = tone[p.status];
          return (
            <div key={p.id} style={{display: "flex", alignItems: "flex-start", gap: 12, padding: "9px 12px", borderRadius: 10, border: "1px solid var(--p-line)"}}>
              <span className="pill" style={{background: t.bg, color: t.fg, fontSize: 10.5, flexShrink: 0, minWidth: 74, justifyContent: "center"}}>{t.label}</span>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontSize: 12.5, fontWeight: 600}}>{p.title}</div>
                {p.detail && <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{p.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Part B — the part period's income, head by head.
 *
 * Its own component because it is the only schedule in the form with a nesting
 * of its own: seventeen figures under five heads with seven subtotals between
 * them, and the subtotals are computed rather than typed because the form
 * prints their formulae and a sheet whose totals can be keyed independently is
 * a sheet that can disagree with itself. */
function PartBSchedule({ year, result, set }) {
  const worked = React.useMemo(() => computePartB(year.partB || {}), [year.partB]);
  const tie = result?.partBTie;

  return (
    <div>
      <div style={{display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4}}>
        <div style={{fontWeight: 700, fontSize: 12.5}}>Part B — break-up of this part period&apos;s income</div>
        <span className="pill pill-muted" style={{fontSize: 10}}>s.158BB(1A)(c)(ii) and (iii)</span>
        {tie?.entered && (
          <span className={`pill ${tie.ties ? "pill-success" : "pill-danger"}`} style={{fontSize: 10.5}}>
            {tie.ties ? "Ties to Part C" : `Row 6 is ${fmtINR(tie.partBTotal)} against Part C's ${fmtINR(tie.partCTotal)}`}
          </span>
        )}
      </div>
      <div className="muted" style={{fontSize: 11.5, marginBottom: 12}}>
        Only this row is asked for it — the part period is the one stretch of the block the return breaks up head by head.
        Subtotals are worked out here; the form prints their formulae, so they are not yours to key.
      </div>

      <div style={{display: "flex", flexDirection: "column", gap: 2}}>
        {PART_B_ROWS.map((row) => {
          if (row.heading) {
            return (
              <div key={row.no} style={{fontWeight: 700, fontSize: 11.5, marginTop: 10, marginBottom: 2, paddingLeft: (row.indent || 0) * 16}}>
                {row.no}. {row.heading}
              </div>
            );
          }
          const computed = Boolean(row.of);
          return (
            <div key={row.no} style={{display: "flex", alignItems: "center", gap: 10, paddingLeft: (row.indent || 0) * 16}}>
              <div style={{flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: computed || row.grand ? 700 : 400, color: computed ? "var(--p-text)" : "var(--p-text-2)"}}>
                <span className="muted" style={{marginRight: 6, fontVariantNumeric: "tabular-nums"}}>{row.no}</span>
                {row.label}
                {row.nilIfLoss && <span className="muted" style={{fontSize: 10.5}}> · enter nil if loss</span>}
              </div>
              <div style={{width: 150, flexShrink: 0}}>
                {computed ? (
                  <input readOnly disabled value={fmtINR(worked.rows[row.key] || 0)}
                    style={{textAlign: "right", background: row.grand ? "var(--p-lavender-2)" : "var(--p-card-tint)", fontWeight: 700, fontVariantNumeric: "tabular-nums"}}/>
                ) : (
                  <Amount value={year.partB?.[row.key]} onChange={(v) => set({ partB: { ...year.partB, [row.key]: v } })}/>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {worked.floored.length > 0 && (
        <div style={{marginTop: 12, padding: "10px 13px", borderRadius: 10, background: "var(--p-amber)", color: "#8A5B10", fontSize: 11.5}}>
          Carried at nil because the form says so on {worked.floored.length === 1 ? "that row" : "those rows"}:{" "}
          {worked.floored.map((f) => `${f.no} (${fmtINR(f.was)})`).join(", ")}. A head that lost money in the part period cannot
          shelter income in another head of the same period.
        </div>
      )}
    </div>
  );
}

/* ---------------------------- Parts D and E ---------------------------- */

function TaxTab({ draft, result, edit, editYear }) {
  const t = result.tax;
  const line = (label, basis, value, opts = {}) => (
    <tr key={label} style={opts.strong ? {fontWeight: 700} : null}>
      <td>{label}</td>
      <td className="muted">{basis}</td>
      <td style={{textAlign: "right", fontVariantNumeric: "tabular-nums"}}>{fmtINR(Math.round(value))}</td>
    </tr>
  );

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Rates</div>
            <div className="card-sub">
              s.113 charges the undisclosed income of the block period at a flat 60%. The surcharge is whatever the Finance Act of the
              year the search was initiated levies, which is why it is a field here and not a fixed number.
            </div>
          </div>
        </div>
        <div className="form-grid">
          <FormField label={`Tax rate % — s.113 (default ${RATE_113})`}>
            <Amount value={draft.taxRate} onChange={(v) => edit({ taxRate: v })} placeholder={String(RATE_113)} align="left"/>
          </FormField>
          <FormField label="Surcharge %">
            <Amount value={draft.surchargeRate} onChange={(v) => edit({ surchargeRate: v })} placeholder="0" align="left"/>
          </FormField>
          <FormField label={`Health & education cess % (default ${RATE_CESS})`}>
            <Amount value={draft.cessRate} onChange={(v) => edit({ cessRate: v })} placeholder={String(RATE_CESS)} align="left"/>
          </FormField>
          <FormField label={`Interest % per month — s.158BFA(1) (default ${RATE_158BFA})`}>
            <Amount value={draft.interestRate} onChange={(v) => edit({ interestRate: v })} placeholder={String(RATE_158BFA)} align="left"/>
          </FormField>
          <FormField label="Months of delay">
            <Amount value={draft.interestMonths} onChange={(v) => edit({ interestMonths: v })}
              placeholder={`${t.derivedMonths} — from the dates`} align="left"/>
          </FormField>
        </div>
        <div className="muted" style={{fontSize: 11.5, marginTop: 10}}>
          {draft.dueDate && draft.filedOn
            ? `Due ${dateOf(draft.dueDate)}, furnished ${dateOf(draft.filedOn)} — ${t.derivedMonths} month${t.derivedMonths === 1 ? "" : "s"} of delay, counting a part of a month as a whole one. Leave the field blank to use that.`
            : "Enter the date of service and the date this return is furnished on the Details tab and the months of delay follow from them."}
        </div>
      </div>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div className="card-title">Tax on the undisclosed income</div>
        </div>
        <Table>
          <thead><tr><th>Particulars</th><th>Basis</th><th style={{textAlign: "right"}}>Amount</th></tr></thead>
          <tbody>
            {line("Total undisclosed income of the block period", "Part C", result.totalUndisclosed)}
            {line("Rounded off", "s.288B", result.roundedUndisclosed)}
            {line("Tax on undisclosed income", `s.113 @ ${t.rate}%`, t.amount)}
            {line("Add: surcharge", `@ ${t.surchargeRate}%`, t.surcharge)}
            {line("Add: health and education cess", `@ ${t.cessRate}%`, t.cess)}
            {line("Tax, surcharge and cess", "", t.grossLiability, { strong: true })}
            {line("Add: interest for late furnishing", `s.158BFA(1) @ ${t.interestRate}% × ${t.interestMonths}`, t.interest)}
            {line("Aggregate liability", "", t.aggregate, { strong: true })}
            {line("Less: credit for taxes paid", "Part E", -result.credits.total)}
            {line(result.netPayable > 0 ? "Tax payable" : "Refund due", "", result.netPayable > 0 ? result.netPayable : result.refundDue, { strong: true })}
          </tbody>
        </Table>
        <div style={{marginTop: 14, padding: "11px 13px", borderRadius: 12, background: "var(--p-amber)", color: "#8A5B10", fontSize: 12.5}}>
          <strong>Penalty exposure — s.158BFA(2): {fmtINR(Math.round(result.penaltyExposure))}.</strong>{" "}
          Fifty per cent of the tax on the undisclosed income. No penalty is leviable on undisclosed income declared in this return where the
          tax on it is paid and evidence of payment is furnished with the return, so this is what is at stake in what is left out — not what is put in.
        </div>
      </div>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">Taxes paid, year by year</div>
            <div className="card-sub">The same figures as on each year's card, together — this is Part E of the return.</div>
          </div>
        </div>
        <Table wide>
          <thead>
            <tr>
              <th>A.Y.</th><th style={{textAlign: "right"}}>TDS</th><th style={{textAlign: "right"}}>TCS</th>
              <th style={{textAlign: "right"}}>Advance tax</th><th style={{textAlign: "right"}}>Self-assessment tax</th>
              <th style={{textAlign: "right"}}>Total</th>
            </tr>
          </thead>
          <tbody>
            {result.years.map((y) => (
              <tr key={y.key}>
                <td>{y.ay}</td>
                {["tds", "tcs", "advance", "selfAssessment"].map((k) => (
                  <td key={k} style={{textAlign: "right"}}>
                    <Amount value={y.credits[k] || ""} onChange={(v) => editYear(y.key, { credits: { ...y.credits, [k]: v } })} width={100}/>
                  </td>
                ))}
                <td style={{textAlign: "right", fontWeight: 600}}>{y.credits.total ? fmtINR(y.credits.total) : "—"}</td>
              </tr>
            ))}
            <tr style={{fontWeight: 700}}>
              <td>Total</td>
              <td style={{textAlign: "right"}}>{fmtINR(result.credits.tds)}</td>
              <td style={{textAlign: "right"}}>{fmtINR(result.credits.tcs)}</td>
              <td style={{textAlign: "right"}}>{fmtINR(result.credits.advance)}</td>
              <td style={{textAlign: "right"}}>{fmtINR(result.credits.selfAssessment)}</td>
              <td style={{textAlign: "right"}}>{fmtINR(result.credits.total)}</td>
            </tr>
          </tbody>
        </Table>
      </div>
    </>
  );
}

/* ------------------------------- Review ------------------------------- */

function ReviewTab({ draft, result, gaps, edit, onDownload, onExport, onDiscard, onGoto }) {
  return (
    <>
      <PartsPanel draft={draft} result={result}/>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">Before this is filed</div>
            <div className="card-sub">What a reviewer would ask for. None of it stops the document being produced — it is a working paper.</div>
          </div>
        </div>
        {gaps.length === 0 ? (
          <div style={{display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 12, background: "var(--p-mint)", color: "#1B8C5C", fontSize: 13, fontWeight: 600}}>
            <Icon name="check" size={15}/> Everything the form asks for is here. Check the figures against the seized material before filing.
          </div>
        ) : (
          <ul style={{display: "flex", flexDirection: "column", gap: 8, margin: 0, paddingLeft: 0, listStyle: "none"}}>
            {gaps.map((g) => (
              <li key={g} style={{display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13}}>
                <span style={{color: "var(--p-warning, #B07512)", marginTop: 1, flexShrink: 0}}><Icon name="alert" size={14}/></span>
                <span>{g}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">Summarised computation of income</div>
            <div className="card-sub">Head by head, for each previous year in the block period — this is what goes to the client with the return.</div>
          </div>
        </div>
        {result.years.length === 0 ? (
          <EmptyState icon="calendar" title="No block period yet" sub="Enter the date of the search on the Details tab."
            action={<button className="btn btn-secondary btn-sm" onClick={() => onGoto("Details")}>Go to Details</button>}/>
        ) : (
          <Table wide>
            <thead>
              <tr>
                <th>Head of income</th>
                {result.years.map((y) => <th key={y.key} style={{textAlign: "right"}}>{y.ay}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr><td colSpan={result.years.length + 1} className="muted" style={{fontWeight: 600}}>Income disclosed in the return filed</td></tr>
              {HEADS.map((h) => (
                <tr key={`d-${h.key}`}>
                  <td>{h.label}</td>
                  {result.years.map((y) => <td key={y.key} style={{textAlign: "right"}}>{money(y.declared?.[h.key])}</td>)}
                </tr>
              ))}
              <tr style={{fontWeight: 600}}>
                <td>Total income returned</td>
                {result.years.map((y) => <td key={y.key} style={{textAlign: "right"}}>{returned(y)}</td>)}
              </tr>
              <tr><td colSpan={result.years.length + 1} className="muted" style={{fontWeight: 600}}>Undisclosed income determined on the material found</td></tr>
              {UNDISCLOSED_HEADS.map((h) => (
                <tr key={`u-${h.key}`}>
                  <td>{h.label}</td>
                  {result.years.map((y) => <td key={y.key} style={{textAlign: "right"}}>{y.undisclosed[h.key] ? fmtINR(y.undisclosed[h.key]) : "—"}</td>)}
                </tr>
              ))}
              <tr style={{fontWeight: 700}}>
                <td>Total income for the block assessment</td>
                {result.years.map((y) => <td key={y.key} style={{textAlign: "right"}}>{fmtINR(y.assessedTotal)}</td>)}
              </tr>
            </tbody>
          </Table>
        )}
      </div>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">Take it away</div>
            <div className="card-sub">
              Two documents doing two jobs. The <strong>transcription sheet</strong> sets every field out in the form's order under its own
              numbering, to key from. The <strong>computation of income</strong> is the working the client signs off. Together by default,
              so what is signed off is what was keyed.
            </div>
          </div>
        </div>
        <div style={{display: "flex", gap: 10, flexWrap: "wrap"}}>
          <button className="btn btn-primary btn-sm" onClick={() => onDownload("both")}>
            <Icon name="pdf" size={13}/>Both
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onDownload("return")}
            title="Every field the portal asks for, in the form's order and under its own numbering">
            <Icon name="pdf" size={13}/>Transcription sheet
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onDownload("computation")}
            title="The computation of income, for the client">
            <Icon name="pdf" size={13}/>Computation of income
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onExport}>
            <Icon name="download" size={13}/>Export draft as JSON
          </button>
          <div style={{flex: 1}}/>
          <button className="btn btn-ghost btn-sm" onClick={onDiscard} style={{color: "var(--p-danger)"}}>
            <Icon name="trash" size={13}/>Delete draft
          </button>
        </div>
        <div className="muted" style={{fontSize: 11.5, marginTop: 12}}>
          Nothing here is transmitted to the department. The return itself is furnished on the e-filing portal under s.158BC, verified as rule 12AE requires.
        </div>
      </div>

      <div className="card" style={{marginTop: 16}}>
        <div className="card-head">
          <div>
            <div className="card-title">Notes</div>
            <div className="card-sub">Printed under the computation, where the client reads it.</div>
          </div>
        </div>
        <textarea
          rows={3}
          value={draft.notes}
          onChange={(e) => edit({ notes: e.target.value })}
          placeholder="Anything that should print under the computation — how a figure was arrived at, what is still to be confirmed."
        />
      </div>
    </>
  );
}
