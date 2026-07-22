// Portal JSON API — Playwright port of the direct-call helpers in
// extension/portal-net.js.
//
// KEY INSIGHT (from portal-net.js): the portal's "sn" header is NOT a secret
// token — it is just the serviceName echoed verbatim. The real authorisation is
// the session cookie. So once the context is logged in we can call any service
// directly with `sn: <serviceName>` + the session cookie — no token capture, no
// UI navigation, no MAIN-world probe.
//
// We run these calls with page.evaluate so they use the page's OWN fetch: same
// origin, same cookies, same Origin/Referer the portal expects — identical to
// what the extension did in-page.
"use strict";

// API paths + form header, from observed portal traffic (portal-login.js).
const PATHS = {
  GET_ENTITY: "/iec/returnservicesapi/auth/getEntity",
  SAVE_ENTITY: "/iec/returnservicesapi/auth/saveEntity",
  SERVICES_SAVE: "/iec/servicesapi/auth/saveEntity",
  SERVICES_GET: "/iec/servicesapi/auth/getEntity",
  DOC_BASE: "/iec/document/",
};
const FORM = { formName: "FO-041_PCDNG" };

// One JSON API call. Runs in the page. Port of portal-net.js apiCall().
function apiCall(page, { path, serviceName, method, payload }) {
  return page.evaluate(
    async ({ path, serviceName, method, payload }) => {
      const ORIGIN = window.location.origin;
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (serviceName) headers["sn"] = serviceName; // == serviceName, by design
      try {
        const resp = await fetch(ORIGIN + path, {
          method: method || "POST",
          credentials: "include",
          headers,
          body: payload != null ? JSON.stringify(payload) : undefined,
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { ok: resp.ok, status: resp.status, json, textSample: json ? null : (text || "").slice(0, 4000) };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
    { path, serviceName, method, payload }
  );
}

// Download a document (notice/order PDF) by id → base64 + filename. Runs in the
// page. Port of portal-net.js getDoc().
function getDoc(page, { docId }) {
  return page.evaluate(
    async ({ docId, DOC_BASE }) => {
      const ORIGIN = window.location.origin;
      try {
        const resp = await fetch(ORIGIN + DOC_BASE + encodeURIComponent(docId), {
          method: "GET",
          credentials: "include",
        });
        if (!resp.ok) return { ok: false, status: resp.status };
        const cd = resp.headers.get("content-disposition") || "";
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        const filename = m ? decodeURIComponent(m[1]).replace(/\.gz$/i, "") : docId + ".pdf";
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return {
          ok: true,
          status: resp.status,
          base64: btoa(bin),
          filename,
          contentType: resp.headers.get("content-type") || "application/pdf",
          bytes: bytes.length,
        };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
    { docId: String(docId), DOC_BASE: PATHS.DOC_BASE }
  );
}

// The paginated e-Proceedings list for one status flag. Port of
// portal-net.js fetchProceedings().
function proceedings(page, { pan, statusFlag, pageSize, pageNo }) {
  return apiCall(page, {
    path: PATHS.GET_ENTITY,
    serviceName: "eProceedingsPaginatedService",
    payload: {
      serviceName: "eProceedingsPaginatedService",
      pan: String(pan || "").toUpperCase(),
      prcdngStatusFlag: statusFlag || "FYA",
      prcdngTypeFlag: "self",
      pageConfig: { pageSize: pageSize || 100, pageNo: pageNo || 1, searchTerm: "", sortBy: "createdDt", sortAsc: false, filters: {} },
      header: FORM,
    },
  });
}

module.exports = { PATHS, FORM, apiCall, getDoc, proceedings };
