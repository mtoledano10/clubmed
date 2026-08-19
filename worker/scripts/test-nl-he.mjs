/**
 * Tests hébreu de l'analyseur de phrase (voir test-nl.mjs pour FR/EN).
 *
 *   node worker/scripts/test-nl-he.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "index.html"), "utf8");
const debut = html.indexOf("const NL_MONTHS=");
const fin = html.indexOf("/* Applique l'intention");
if (debut < 0 || fin < 0) throw new Error("bloc nlParse introuvable dans index.html");
const { nlParse } = await import(
  "data:text/javascript," + encodeURIComponent(html.slice(debut, fin) + "\nexport {nlParse};")
);

const MOIS = [
  ["2026-08", 8, 2026], ["2026-09", 9, 2026], ["2026-10", 10, 2026], ["2026-11", 11, 2026],
  ["2026-12", 12, 2026], ["2027-01", 1, 2027], ["2027-02", 2, 2027], ["2027-03", 3, 2027],
  ["2027-04", 4, 2027], ["2027-05", 5, 2027],
].map(([key, m, y]) => ({ key, m, y }));

let ko = 0;
function t(phrase, traduction, attendu) {
  const x = nlParse(phrase, MOIS);
  const reel = { segs: x.segs, months: x.months, occ: x.occ, flight: x.flight, dur: x.dur, maxPrice: x.maxPrice, dows: x.dows, best: x.best, text: x.text };
  const ecarts = Object.entries(attendu).filter(([k, v]) => JSON.stringify(reel[k]) !== JSON.stringify(v));
  if (ecarts.length) {
    ko++;
    console.log("  FAIL  " + phrase + "   (" + traduction + ")");
    for (const [k, v] of ecarts) console.log("        " + k + " : attendu " + JSON.stringify(v) + ", obtenu " + JSON.stringify(reel[k]));
  } else {
    console.log("  OK    " + phrase + "   (" + traduction + ")");
    if (x.notes.length) console.log("        note : " + x.notes.join(" · "));
  }
}

console.log("les deux phrases demandées, en hébreu :");
t("אני מחפש חדר ל-5 בינואר בסקי", "chambre pour 5 en janvier au ski",
  { segs: [0], months: ["2027-01"], occ: [5], text: "" });
t("תן לי את המחיר הכי טוב בסקי בטיסה ישירה", "le meilleur prix au ski en vol direct",
  { segs: [0], flight: "d", best: true, text: "" });

console.log("\nvariantes :");
t("סקי בפברואר 2 מבוגרים ו-2 ילדים 7 לילות", "ski en février, 2 adultes + 2 enfants, 7 nuits",
  { segs: [0], months: ["2027-02"], occ: [4], dur: 7 });
t("טווח ארוך עד 2000", "long courrier jusqu'à 2000", { segs: [2], maxPrice: 2000 });
t("ללא טיסה למשפחה של 6 באוגוסט", "sans vol pour une famille de 6 en août",
  { flight: "l", occ: [6], months: ["2026-08"] });
t("חופשה לזוג במרץ", "vacances pour un couple en mars", { occ: [2], months: ["2027-03"] });
t("סקי ביום שבת", "ski le samedi", { segs: [0], dows: [6] });
t("הכי זול בדצמבר", "le moins cher en décembre", { best: true, months: ["2026-12"] });
t("שבוע בסקי", "une semaine au ski", { segs: [0], dur: 7 });
t("סקי ל-5 בטיסה ישירה", "ski pour 5 en vol direct — contradiction", { segs: [0], occ: [5], flight: "l" });

console.log("\nmélange hébreu + nom de resort latin :");
t("punta cana ל-2 בטיסה ישירה", "punta cana pour 2 en direct",
  { occ: [2], flight: "d", text: "punta cana" });

console.log(ko ? "\n" + ko + " test(s) en échec" : "\nTous les tests hébreu passent.");
process.exit(ko ? 1 : 0);
