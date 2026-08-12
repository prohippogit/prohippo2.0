/* Who a WhatsApp message may go to, and whether it may go at all.
 *
 *   node --test test/whatsappSettings.test.mjs
 *
 * The point of these: every rule that decides whether a message reaches a real
 * client is here rather than inside a Cloud Function, so it can be checked
 * without a WhatsApp account. Two things matter more than the rest — a number
 * must reduce to ONE stored form however it was typed, and consent must be a
 * thing someone gave rather than a thing that defaulted to true.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  WHATSAPP_MESSAGES,
  MESSAGE_KEYS,
  resolveWhatsAppSettings,
  whatsAppEnabledFor,
  normaliseMobile,
  isValidMobile,
  mobileTen,
  waDigits,
  displayMobile,
  groupHead,
  headConsent,
  clientReachability,
  userReachability,
} from "../src/whatsappSettings.js";

/* ---------------- mobile numbers ---------------- */

test("every way a person types the same mobile reduces to one stored form", () => {
  const forms = [
    "9825011234",
    "98250 11234",
    "98250-11234",
    "+91 98250 11234",
    "+919825011234",
    "919825011234",
    "09825011234",
    "  +91-98250 11234  ",
  ];
  for (const f of forms) {
    assert.equal(normaliseMobile(f), "+919825011234", `failed for ${JSON.stringify(f)}`);
  }
});

test("a number that is not an Indian mobile is refused rather than mangled", () => {
  const bad = [
    "", null, undefined, "abcdefghij",
    "12345",                    // too short
    "5825011234", "1234567890", // ten digits, but no mobile starts 1 or 5
    "9825011",                  // truncated
  ];
  for (const b of bad) {
    assert.equal(normaliseMobile(b), "", `should refuse ${JSON.stringify(b)}`);
    assert.equal(isValidMobile(b), false);
  }
});

test("a mistyped long number is refused, not quietly trimmed to someone else's", () => {
  /* This is why the last ten digits are not simply taken. Each of these ends in
     a perfectly valid mobile, and a sliding rule would send to it. */
  assert.equal(normaliseMobile("12345 9825011234"), "");
  assert.equal(normaliseMobile("00919825011234"), "");
  assert.equal(normaliseMobile("9825011234 9876543210"), "");
});

test("an Ahmedabad landline is indistinguishable from a mobile, and we say so", () => {
  /* Pinned deliberately, as documentation rather than approval: "079 2630 1234"
     reduces to 7926301234, which is also a valid mobile shape — STD code 79
     collides with mobile prefix 7. No rule over the string can separate them,
     so this one is caught by WhatsApp failing to deliver, not here. If this
     test ever starts failing, someone has added a rule that guesses. */
  assert.equal(normaliseMobile("079 2630 1234"), "+917926301234");
});

test("the derived forms agree with each other", () => {
  assert.equal(mobileTen("+91 98250 11234"), "9825011234");
  assert.equal(waDigits("+91 98250 11234"), "919825011234"); // WATI wants no plus
  assert.equal(displayMobile("9825011234"), "+91 98250 11234");
  assert.equal(displayMobile("nonsense"), "");
});

/* ---------------- settings ---------------- */

test("the master switch is off until somebody turns it on", () => {
  assert.equal(resolveWhatsAppSettings(null).enabled, false);
  assert.equal(resolveWhatsAppSettings({}).enabled, false);
  assert.equal(resolveWhatsAppSettings({ whatsapp: {} }).enabled, false);
  // Only an explicit true counts — a truthy string left by an old write must not
  // switch on every client's messages.
  assert.equal(resolveWhatsAppSettings({ whatsapp: { enabled: "yes" } }).enabled, false);
});

test("resolve fills every key, and telling clients about notices stays off", () => {
  const s = resolveWhatsAppSettings({ whatsapp: { enabled: true } });
  for (const k of MESSAGE_KEYS) assert.equal(typeof s[k], "boolean", `${k} missing`);
  assert.equal(s.noticeAlertClient, false);
  assert.equal(s.docRequest, true);
  assert.equal(s.hearingReminder, true);
});

test("the master switch beats every individual one", () => {
  const profile = { whatsapp: { enabled: false, hearingReminder: true, causeList: true } };
  assert.equal(whatsAppEnabledFor(profile, "hearingReminder"), false);
  assert.equal(whatsAppEnabledFor({ whatsapp: { enabled: true, hearingReminder: true } }, "hearingReminder"), true);
});

test("an unknown message key is never enabled", () => {
  assert.equal(whatsAppEnabledFor({ whatsapp: { enabled: true, madeUp: true } }, "madeUp"), false);
});

test("every message declares an audience the card can group by", () => {
  for (const m of WHATSAPP_MESSAGES) {
    assert.ok(["user", "client"].includes(m.audience), `${m.key} has no audience`);
    assert.ok(m.name && m.sub, `${m.key} has no label`);
  }
});

/* ---------------- the group head ---------------- */

const group = (over = {}) => ({
  name: "Shah Group",
  head: { name: "Rajesh M. Shah", mobile: "+919825011234", assesseeId: "a1" },
  headWhatsappOptIn: { optedIn: true, at: "2026-08-01T10:00:00.000Z", by: "ca@mehta.co", source: "practitioner" },
  ...over,
});

test("a group with a head, a number and consent is reachable", () => {
  const r = clientReachability(group());
  assert.equal(r.ok, true);
  assert.equal(r.mobile, "+919825011234");
  assert.equal(r.name, "Rajesh M. Shah");
});

test("each way of being unreachable says which way it is", () => {
  assert.equal(clientReachability({ name: "Ungrouped" }).reason, "no-head");
  assert.equal(clientReachability(group({ head: { name: "Rajesh M. Shah", mobile: "" } })).reason, "no-mobile");
  assert.equal(clientReachability(group({ headWhatsappOptIn: null })).reason, "no-consent");
});

test("consent is never assumed from the presence of a number", () => {
  const r = clientReachability(group({ headWhatsappOptIn: { optedIn: false } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-consent");
  // The number is still returned — the caller may want to say whose it is.
  assert.equal(r.mobile, "+919825011234");
});

test("a STOP reply outranks the practitioner's tick", () => {
  const stopped = group({
    headWhatsappOptIn: { optedIn: true, at: "2026-08-01T10:00:00.000Z", revokedAt: "2026-08-09T07:12:00.000Z" },
  });
  assert.equal(headConsent(stopped).optedIn, false);
  const r = clientReachability(stopped);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "opted-out");
});

test("the head's number is normalised however it was stored", () => {
  const h = groupHead(group({ head: { name: "Rajesh M. Shah", mobile: "98250 11234" } }));
  assert.equal(h.mobile, "+919825011234");
});

test("a head with a name and no number is still a head, just not reachable", () => {
  const h = groupHead(group({ head: { name: "Rajesh M. Shah", mobile: "" } }));
  assert.equal(h.name, "Rajesh M. Shah");
  assert.equal(h.mobile, "");
});

test("a group that exists only as a string on an assessee has no head", () => {
  assert.equal(groupHead({ name: "Patel Family" }), null);
  assert.equal(groupHead({ name: "Patel Family", head: {} }), null);
});

/* ---------------- the practitioner ---------------- */

test("we message the number the practitioner proved they own, and no other", () => {
  assert.equal(userReachability({ phone: "+919824000000", phoneVerified: true }).ok, true);
  // Present but unverified is exactly the case that must not send: it is a
  // number someone typed, and dialling those is how an account becomes a relay.
  assert.equal(userReachability({ phone: "+919824000000" }).ok, false);
  assert.equal(userReachability({ phone: "+919824000000", phoneVerified: false }).reason, "unverified");
  assert.equal(userReachability({}).ok, false);
  assert.equal(userReachability(null).ok, false);
});

test("a verified flag over a junk number is still not reachable", () => {
  assert.equal(userReachability({ phone: "12345", phoneVerified: true }).ok, false);
});
