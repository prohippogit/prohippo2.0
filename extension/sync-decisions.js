/*
 * ProHippo Sync — what the sync may skip, decided from what the PORTAL says.
 *
 * THE EXTENSION'S COPY of connector/src/main/syncDecisions.js. Same rules, same
 * names, same answers: test/syncDecisions.test.mjs runs both over the same
 * payloads and fails if they ever disagree. There are two files because there
 * have to be — the connector's is CommonJS loaded by Electron, this one is a
 * content script in an isolated world with no module system at all — and the
 * pair is the reason the drift is catchable rather than silent.
 *
 * WHY THESE RULES EXIST, in one paragraph, because every one of them is written
 * against a real failure. An A.Y. 2024-25 scrutiny under s.143(3): four notices,
 * three replies filed with 22 attachments between them, and a closure order set
 * — the assessment order, the computation sheet and a demand notice u/s 156. The
 * app showed the four notices and nothing else. The practitioner synced four
 * times and was told each time that the assessee was up to date. Nothing had
 * failed: the sync had DECIDED not to look, because "the notice count has not
 * changed, and the proceeding is closed". Both halves are true and neither is
 * evidence. A closed proceeding is exactly where the replies and the order are
 * — the replies were filed while it was open, the order is what closed it, and
 * the notice count moves for neither. So:
 *
 *   ASK WHAT THE PORTAL SAYS HAS CHANGED. Never infer it from something else.
 *
 * The extension carried the fields to do this (`noticeReplies`, `procNeedsMeta`,
 * `lastResponseSubmittedOn`) for months without reading them: the app sent them,
 * background.js relayed them, and portal-login.js went on counting notices.
 *
 * Pure functions, no I/O, no chrome APIs. Isolated content-script world;
 * portal-login.js reads window.__PH_SYNC_DECISIONS.
 */
(function () {
  /* A portal timestamp as epoch milliseconds. Kept identical to toMillis() in
     src/syncKnowns.js — the numbers compared here are the ones that module
     produced, so a different parse on either side is a wrong comparison rather
     than an error. */
  function toMillis(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    const s = String(v).trim();
    if (/^\d{10,}$/.test(s)) return Number(s);
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }

  /* Whether the portal is telling us a reply exists against this notice.
   *
   * Four fields say it, and they do not all appear together: a notice replied to
   * carries `lastResponseSubmittedOn` and `respStatus: "S"`, and some payloads add
   * `isSubmitted` or a `respId`. Any one of them is the portal saying yes. */
  function portalReplyState(notice) {
    const n = notice || {};
    const last = toMillis(n.lastResponseSubmittedOn);
    const said =
      last > 0 ||
      String(n.respStatus || "").trim().toUpperCase() === "S" ||
      n.isSubmitted === true ||
      (n.respId != null && n.respId !== "");
    /* Did the payload address the question at all? A schema that carries none of
       these fields is not saying "no reply" — it is saying nothing, and the two
       must not be confused. Where the portal is silent we fall back to the old
       behaviour rather than inventing an answer. */
    const spoke =
      "lastResponseSubmittedOn" in n || "respStatus" in n ||
      "isSubmitted" in n || "respId" in n;
    return { replied: said, last, spoke };
  }

  /**
   * Should this notice's replies be fetched?
   *
   * @param notice  one row of eProceedingDetailsService
   * @param held    { n, last } from the knowns — replies already on file for it
   * @param isKnown whether the notice itself is already on file
   * @returns { fetch, why } — `why` is for the log, and is the thing that was
   *          missing when nobody could tell a skip from an empty portal.
   */
  function shouldFetchReplies(notice, held, isKnown) {
    const p = portalReplyState(notice);
    const have = { n: (held && held.n) || 0, last: (held && held.last) || 0 };

    if (p.replied) {
      // The portal says there is a reply. Two ways we can be behind it.
      if (!have.n) return { fetch: true, why: "portal reports a reply, none on file" };
      if (p.last && p.last > have.last) return { fetch: true, why: "portal reports a newer reply" };
      return { fetch: false, why: "replies on file are current" };
    }
    if (p.spoke) return { fetch: false, why: "portal reports no reply" };
    // The portal said nothing either way. A notice we have never seen is worth one
    // call; one already on file is not, which is what the old code did for every
    // notice and is safe only in this branch.
    return { fetch: !isKnown, why: isKnown ? "portal silent, notice already on file" : "portal silent, new notice" };
  }

  /**
   * May this whole proceeding be skipped without opening it?
   *
   * The count of notices is ONE of the things that can have moved, and it was
   * being used as though it were all of them. A proceeding is settled only when
   * everything the portal states about it is already on file.
   *
   * @param row     the mapped list row (viewNoticeCount, closureSeqNo,
   *                lastResponseSubmittedOn, tab, proceedingStatus)
   * @param known   knownByProc[proceedingReqId] — { n, o, r }
   * @param opts    { scope, needsMeta, needsDocs }
   * @returns { skip, why }
   */
  function proceedingSettled(row, known, opts) {
    const r = row || {};
    const kp = known || {};
    const o = opts || {};

    // Only ever a candidate for skipping in the two cases the sync was built
    // around: a closed proceeding (nothing new can be issued in it) and the fast
    // scope, which trades thoroughness for speed by design.
    const closed = /information/i.test(r.tab || "") || r.proceedingStatus === "C";
    if (!closed && o.scope !== "eproc") return { skip: false, why: "open proceeding, thorough scope" };

    if ((r.viewNoticeCount || 0) > (kp.n || 0)) return { skip: false, why: "the portal lists more notices than we hold" };
    if (o.needsMeta) return { skip: false, why: "a reply on file has no portal metadata" };
    if (o.needsDocs) return { skip: false, why: "a notice here is missing documents" };

    /* The reply the whole failure turned on. The portal's list row states when a
       reply was last filed anywhere in this proceeding; if that is newer than the
       newest we hold — or we hold none at all — there is something to fetch, and
       the notice count will never say so. */
    const portalReply = toMillis(r.lastResponseSubmittedOn);
    if (portalReply && portalReply > (kp.r || 0)) {
      return { skip: false, why: "a reply was filed since we last looked" };
    }

    /* The closure order. The portal names it on the row; holding none means the
       order that ended the proceeding is still only on the portal. */
    if (r.closureSeqNo && !kp.o) return { skip: false, why: "the portal states a closure order we do not hold" };

    return { skip: true, why: "nothing the portal states has moved" };
  }

  /**
   * Is it worth asking for this proceeding's closure order?
   *
   * The portal names the order on the list row (`proceedingClosureOrder`), so most
   * of the time this is answerable without a call. Two cases still ask blind: a
   * closed proceeding whose row does not mention one — the service has returned
   * documents for those before — and the synthetic row for a proceeding that has
   * just left the "for your action" list, which carries no fields at all.
   *
   * The fast scope asks only where the portal has said there is something, which
   * is what keeps a bulk sync over hundreds of closed proceedings cheap.
   */
  function shouldFetchClosureOrder(row, known, opts) {
    const r = row || {};
    const kp = known || {};
    const scope = (opts || {}).scope;
    const closed = /information/i.test(r.tab || "") || r.proceedingStatus === "C";

    if (r.closureSeqNo && kp.o) return { fetch: false, why: "the order is already on file" };
    if (r.closureSeqNo) return { fetch: true, why: "the portal states a closure order we do not hold" };
    if (r.justClosed) return { fetch: true, why: "this proceeding has just closed" };
    if (scope === "eproc") return { fetch: false, why: "fast scope asks only where the portal states an order" };
    if (closed && kp.o) return { fetch: false, why: "closed, and an order is already on file" };
    if (closed) return { fetch: true, why: "closed, and the row does not say either way" };
    return { fetch: true, why: "thorough scope" };
  }

  window.__PH_SYNC_DECISIONS = { toMillis, portalReplyState, shouldFetchReplies, proceedingSettled, shouldFetchClosureOrder };
})();
