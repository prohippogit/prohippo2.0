/*
 * Anonymising a real return into a committable fixture.
 *
 *   node --test test/itrFixture.test.mjs
 *
 * These rules decide whether a client's name reaches a public repository, which
 * makes them exactly the wrong thing to leave untested because the surrounding
 * script needs credentials to run.
 *
 * The case that motivated them: a hand-written anonymisation of a real ITR-5
 * replaced seven of the firm's twenty-two partners by name and would have left
 * the other fifteen in the repo. Anonymising by field cannot miss one; these
 * tests hold that line.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { anonymise, auditResidual, describe } from "../scripts/lib/itrFixture.mjs";

// A miniature return with one of everything the real ones carry.
const RETURN = {
  ITR: {
    ITR3: {
      PartA_GEN1: {
        PersonalInfo: {
          AssesseeName: { SurNameOrOrgName: "REAL SURNAME", FirstName: "REALFIRST" },
          PAN: "ABCPD1234E",
          Address: {
            ResidenceName: "REAL APARTMENTS", RoadOrStreet: "REAL ROAD",
            CityOrTownOrDistrict: "REALTOWN", PinCode: 380001,
            EmailAddress: "real.person@gmail.com", MobileNo: 9876543210,
          },
        },
      },
      PartA_GEN2: {
        PartnerOrMemberInfo: Array.from({ length: 22 }, (_, i) => ({
          PartnerOrMemberName: `REAL PARTNER ${i + 1}`,
          PAN: `AAA${"ABCDEFGHIJKLMNOPQRSTUV"[i]}P${1000 + i}Z`,
          SharePercentage: 5,
        })),
      },
      ScheduleGST: { TurnoverGrsRcptForGSTIN: [{ GSTINNo: "24ABCPD1234E1ZI", AmtTurnGrossRcptGSTIN: 500000 }] },
      ScheduleHP: {
        PropertyDetails: [{
          TenantDetails: [{ NameofTenant: "REAL TENANT LTD", PANTANofTenant: "REALT12345Z" }],
          Rentdetails: { AnnualLetableValue: 240000, IncomeOfHP: -50000 },
        }],
      },
      Verification: { Declaration: { AssesseeVerName: "REAL SURNAME", AssesseeVerPAN: "ABCPD1234E", Place: "REALTOWN" } },
      "PartB-TI": { TotalIncome: 0, GrossTotalIncome: 190000 },
    },
  },
};

test("every partner is anonymised, not just the ones someone remembered", () => {
  const { clean, counts } = anonymise(RETURN);
  const partners = clean.ITR.ITR3.PartA_GEN2.PartnerOrMemberInfo;
  assert.equal(partners.length, 22);
  for (const p of partners) {
    assert.match(p.PartnerOrMemberName, /^SAMPLE NAME \d+$/);
    assert.doesNotMatch(p.PartnerOrMemberName, /REAL/);
  }
  assert.ok(counts.people >= 22, "all 22 partners plus the assessee and tenant");
});

test("a PAN keeps its status character, because the mapper reads it", () => {
  const { clean } = anonymise(RETURN);
  const pan = clean.ITR.ITR3.PartA_GEN1.PersonalInfo.PAN;
  assert.match(pan, /^[A-Z]{5}\d{4}[A-Z]$/);
  // 'P' = individual. Replace it and the fixture stops representing the case.
  assert.equal(pan[3], "P");
  assert.notEqual(pan, "ABCPD1234E");
});

test("a PAN embedded in a GSTIN is replaced too", () => {
  const { clean } = anonymise(RETURN);
  const gstin = clean.ITR.ITR3.ScheduleGST.TurnoverGrsRcptForGSTIN[0].GSTINNo;
  // This is the one a value-by-value list misses: the PAN is a substring.
  assert.doesNotMatch(gstin, /ABCPD1234E/);
  assert.match(gstin, /^24[A-Z]{5}\d{4}[A-Z]1ZI$/);
});

test("the same real value always maps to the same dummy", () => {
  const { clean } = anonymise(RETURN);
  // The verification block names the assessee again; a computation that showed
  // two different names for one person would be incoherent.
  assert.equal(
    clean.ITR.ITR3.Verification.Declaration.AssesseeVerPAN,
    clean.ITR.ITR3.PartA_GEN1.PersonalInfo.PAN
  );
});

test("contact details and free text are scrubbed", () => {
  const { clean } = anonymise(RETURN);
  const addr = clean.ITR.ITR3.PartA_GEN1.PersonalInfo.Address;
  assert.equal(addr.EmailAddress, "sample@example.com");
  assert.equal(addr.MobileNo, 9800000001);
  assert.match(addr.CityOrTownOrDistrict, /^SAMPLE PLACE/);
  assert.match(clean.ITR.ITR3.ScheduleHP.PropertyDetails[0].TenantDetails[0].NameofTenant, /^SAMPLE NAME/);
});

test("two deductors keep two TANs, because the computation groups credits by TAN", () => {
  // Masking a TAN the way an account number is masked turns every deductor into
  // the identical XXXX00000X — and the taxes-paid section merges rows by TAN, so
  // three deductors became one row on the first fixture that had more than one.
  const withDeductors = JSON.parse(JSON.stringify(RETURN));
  withDeductors.ITR.ITR3.TDSonSalaries = {
    TDSonSalary: [
      { EmployerOrDeductorOrCollectDetl: { TAN: "AHMN08362E" }, TotalTDSSal: 34000 },
      { EmployerOrDeductorOrCollectDetl: { TAN: "MUMA35845F" }, TotalTDSSal: 555 },
    ],
  };
  const { clean, values } = anonymise(withDeductors);
  const [a, b] = clean.ITR.ITR3.TDSonSalaries.TDSonSalary.map((t) => t.EmployerOrDeductorOrCollectDetl.TAN);
  assert.notEqual(a, b, "distinct deductors must stay distinct");
  for (const t of [a, b]) assert.match(t, /^[A-Z]{4}\d{5}[A-Z]$/, "and must still look like a TAN");
  const blob = values.join("\n");
  assert.ok(!blob.includes("AHMN08362E") && !blob.includes("MUMA35845F"));
});

test("a second contact is scrubbed too, whoever it belongs to", () => {
  // A.Y. 2026-27's ITR-1 carries `MobileNoSec` and `EmailAddressSec`, and on the
  // return that brought them to light the second contact was somebody other than
  // the assessee. A field holding a person's contact details is personal data
  // whether or not it is the filer's own.
  const withSecond = JSON.parse(JSON.stringify(RETURN));
  withSecond.ITR.ITR3.PartA_GEN1.PersonalInfo.Address.MobileNoSec = 9812345678;
  withSecond.ITR.ITR3.PartA_GEN1.PersonalInfo.Address.EmailAddressSec = "someone.else@gmail.com";
  const { clean, values } = anonymise(withSecond);
  const addr = clean.ITR.ITR3.PartA_GEN1.PersonalInfo.Address;
  assert.equal(addr.EmailAddressSec, "sample@example.com");
  assert.notEqual(addr.MobileNoSec, 9812345678);
  assert.match(String(addr.MobileNoSec), /^9+$/);
  assert.ok(!values.join("\n").includes("someone.else@gmail.com"));
});

test("ITR-1's nature-of-income line is scrubbed, because the mapper prints it as a label", () => {
  // `OthSrcOthNatOfInc` is the assessee's own words for a receipt, and those
  // words routinely name the payer. It is the same case as ITR-2's OthNatOfInc
  // under a third spelling.
  const withNature = JSON.parse(JSON.stringify(RETURN));
  withNature.ITR.ITR3.ITR1_IncomeDeductions = {
    OthersInc: { OthersIncDtlsOthSrc: [{ OthSrcNatureDesc: "OTH", OthSrcOthNatOfInc: "Interest from Realco Pvt Ltd", OthSrcOthAmount: 198410 }] },
  };
  const { clean, values } = anonymise(withNature);
  const item = clean.ITR.ITR3.ITR1_IncomeDeductions.OthersInc.OthersIncDtlsOthSrc[0];
  assert.match(item.OthSrcOthNatOfInc, /^SAMPLE NAME/);
  assert.equal(item.OthSrcOthAmount, 198410, "the figure is untouched");
  assert.ok(!values.join("\n").includes("Realco"));
});

test("figures are untouched — the fixture must still represent the case", () => {
  const { clean } = anonymise(RETURN);
  assert.equal(clean.ITR.ITR3.ScheduleHP.PropertyDetails[0].Rentdetails.IncomeOfHP, -50000);
  assert.equal(clean.ITR.ITR3["PartB-TI"].GrossTotalIncome, 190000);
  assert.equal(clean.ITR.ITR3.ScheduleGST.TurnoverGrsRcptForGSTIN[0].AmtTurnGrossRcptGSTIN, 500000);
});

test("no original identifier survives anywhere in the result", () => {
  const { values } = anonymise(RETURN);
  const blob = values.join("\n");
  for (const leak of ["REAL SURNAME", "REALFIRST", "REAL PARTNER", "REAL TENANT", "REALTOWN",
    "REAL ROAD", "REAL APARTMENTS", "ABCPD1234E", "real.person@gmail.com"]) {
    assert.ok(!blob.includes(leak), `leaked: ${leak}`);
  }
});

test("a name in a field nobody catalogued is reported, not passed through silently", () => {
  // The failure mode this guards: ITD adds a field, it holds a person's name,
  // and the anonymiser has no rule for it. Better to stop and be told.
  const withUnknownField = JSON.parse(JSON.stringify(RETURN));
  withUnknownField.ITR.ITR3.ScheduleSomethingNew = { SomeUncataloguedName: "Rajesh Kumar Sharma" };
  const { values } = anonymise(withUnknownField);
  assert.ok(auditResidual(values).includes("Rajesh Kumar Sharma"));
});

test("describe() reports the schedules and the figures that carry a value", () => {
  const out = describe(RETURN.ITR.ITR3);
  assert.match(out, /ScheduleHP/);
  assert.match(out, /ScheduleGST/);
  // Largest first, so a mapper author sees what matters at the top.
  const firstFigure = out.split("largest first:")[1].trim().split("\n")[0];
  assert.match(firstFigure, /5,00,000/);
});
