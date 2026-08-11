/* The connector's own "add assessee" reads a PAN's master data from the portal
   and maps it into an assessee record. The mapping is where the portal's shape
   meets ours — ALL-CAPS name parts, a numeric state code, a date in two
   different formats, contact fields whose names vary by PAN — so it is the part
   worth pinning down. The fetch itself needs a portal session and isn't covered
   here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mapMaster, entityFromPan, itdDate, pickContact } = require("../connector/src/main/portalMaster.js");

test("the PAN's 4th character decides the entity type", () => {
  assert.equal(entityFromPan("ABCPS1234F"), "Individual");
  assert.equal(entityFromPan("AABCS9821K"), "Company");
  assert.equal(entityFromPan("AAFHM2210C"), "HUF");
  assert.equal(entityFromPan("AALFN6712M"), "Firm");
  assert.equal(entityFromPan("aabcs9821k"), "Company", "a lower-case PAN is the same PAN");
  assert.equal(entityFromPan("??"), "");
});

test("a date of birth is read from the portal's own string, not its epoch", () => {
  // The epoch is midnight IST. Read as UTC it lands on the previous day, and a
  // date of birth one day out unlocks no CPC order PDF — so the string wins
  // whenever the portal sends one.
  const bothGiven = { incorporateDate: "10-Mar-1978", dobEpoch: Date.UTC(1978, 2, 9, 18, 30) };
  assert.equal(itdDate(bothGiven), "1978-03-10");
  assert.equal(itdDate({ dobEpoch: Date.UTC(1978, 2, 9, 18, 30) }), "1978-03-10", "epoch fallback must land on the IST date");
  assert.equal(itdDate({ incorporateDate: "1-Jan-2001" }), "2001-01-01", "a single-digit day is padded");
  assert.equal(itdDate({ incorporateDate: "garbage" }), "");
  assert.equal(itdDate({}), "");
});

test("contact details are matched by shape, not by a hard-coded field name", () => {
  const profile = {
    secEmailId: "office@example.com",
    priEmailId: "raj@example.com",
    altMobileNum: "9876500000",
    priMobileNum: "98250 11234",
    someOtherField: "not-an-email",
    panNum: "ABCPS1234F", // 10 chars, but not digits — must not read as a mobile
  };
  assert.deepEqual(pickContact(profile), { email: "raj@example.com", mobile: "9825011234" });
  assert.deepEqual(pickContact({}), { email: "", mobile: "" });
});

test("a full profile maps to a saveable assessee record", () => {
  const { record, filled } = mapMaster({
    pan: "abcps1234f",
    panDetails: {
      firstNm: "RAJESH", midNm: "M", surname: "SHAH",
      incorporateDate: "10-Mar-1978",
      commnLine1: "B-204, Mahalaxmi Heights", commnLine2: "", commnLine3: "Navrangpura",
      commnState: 11, commnPin: 380009,
    },
    jurisdiction: { aoPplrName: "Ward 1(1)(1)", aoEmailId: "ward11.ahmedabad@incometax.gov.in", aoBldgDesc: "Aayakar Bhavan" },
    profile: { priEmailId: "rajesh.shah@example.com", priMobileNum: "9825011234" },
  });

  assert.equal(record.pan, "ABCPS1234F");
  assert.equal(record.name, "RAJESH M SHAH");
  assert.equal(record.status, "Individual");
  assert.equal(record.dob, "1978-03-10");
  // Blank address lines are dropped, the numeric state becomes its name, and
  // the PIN goes last.
  assert.equal(record.address, "B-204, Mahalaxmi Heights, Navrangpura, Gujarat, 380009");
  assert.equal(record.email, "rajesh.shah@example.com");
  assert.equal(record.mobile, "9825011234");
  assert.equal(record.jurisdiction.ward, "Ward 1(1)(1)");
  assert.deepEqual(filled.sort(), ["address", "dob", "email", "jurisdiction", "mobile", "name"]);
});

test("a PAN the portal says nothing about still yields an editable record", () => {
  // Every service can decline. The form must open with the PAN and an entity
  // type and let someone type the rest, rather than failing.
  const { record, filled } = mapMaster({ pan: "AABCS9821K", panDetails: null, jurisdiction: null, profile: null });
  assert.deepEqual(record, {
    pan: "AABCS9821K", name: "", status: "Company", dob: "", address: "", email: "", mobile: "", jurisdiction: null,
  });
  assert.deepEqual(filled, []);
});

test("an empty jurisdiction is not reported as fetched", () => {
  // The service answers with a body full of empty strings for a PAN that has no
  // AO recorded; treating that as "fetched" would tag the block "from portal ✓"
  // over nothing at all.
  const { record, filled } = mapMaster({
    pan: "ABCPS1234F",
    jurisdiction: { aoPplrName: "", aoEmailId: "", aoBldgDesc: "" },
  });
  assert.equal(record.jurisdiction, null);
  assert.ok(!filled.includes("jurisdiction"));
});
