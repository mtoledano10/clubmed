/**
 * Teste l'analyseur de phrase de index.html sans navigateur : on extrait le
 * bloc nlParse (qui ne touche pas au DOM) et on l'exécute tel quel.
 *
 *   node worker/scripts/test-nl.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "index.html"), "utf8");

const debut = html.indexOf("const NL_MONTHS=");
const fin = html.indexOf("/* Applique l'intention");
if (debut < 0 || fin < 0) throw new Error("bloc nlParse introuvable dans index.html");
const src = html.slice(debut, fin);
const { nlParse, nlNorm } = await import(
  "data:text/javascript," + encodeURIComponent(src + "\nexport {nlParse, nlNorm};")
);

// Les mois réellement présents dans les données (relevés sur l'app en ligne)
const MOIS = [
  ["2026-08", 8, 2026], ["2026-09", 9, 2026], ["2026-10", 10, 2026], ["2026-11", 11, 2026],
  ["2026-12", 12, 2026], ["2027-01", 1, 2027], ["2027-02", 2, 2027], ["2027-03", 3, 2027],
  ["2027-04", 4, 2027], ["2027-05", 5, 2027],
].map(([key, m, y]) => ({ key, m, y }));

let ko = 0;
function t(phrase, attendu) {
  const x = nlParse(phrase, MOIS);
  const reel = {
    segs: x.segs, months: x.months, occ: x.occ, flight: x.flight,
    dur: x.dur, maxPrice: x.maxPrice, dows: x.dows, best: x.best, text: x.text,
  };
  const ecarts = Object.entries(attendu).filter(
    ([k, v]) => JSON.stringify(reel[k]) !== JSON.stringify(v)
  );
  if (ecarts.length) {
    ko++;
    console.log("  FAIL « " + phrase + " »");
    for (const [k, v] of ecarts) console.log("        " + k + " : attendu " + JSON.stringify(v) + ", obtenu " + JSON.stringify(reel[k]));
  } else {
    console.log("  OK   « " + phrase + " »");
    if (x.notes.length) console.log("        note : " + x.notes.join(" · "));
  }
}

console.log("accents :", nlNorm("Février à l'Alpe d'Huez") === "fevrier a l'alpe d'huez" ? "OK" : "FAIL -> " + nlNorm("Février"));
console.log();

console.log("les deux phrases demandées :");
t("je cherche une chambre pour 5 en janvier sur le ski", {
  segs: [0], months: ["2027-01"], occ: [5], flight: null, text: "",
});
t("donne moi le meilleur prix sur le ski en vol direct", {
  segs: [0], flight: "d", best: true, occ: [], text: "",
});

console.log("\nvariantes réalistes :");
t("ski février 2 adultes + 2 enfants 7 nuits", { segs: [0], months: ["2027-02"], occ: [4], dur: 7 });
t("long courrier moins de 2000 € par personne", { segs: [2], maxPrice: 2000 });
t("punta cana en direct pour 2", { flight: "d", occ: [2], text: "punta cana" });
t("summer mountain en juillet", { segs: [3], months: [] });
t("départ samedi en août sans vol", { dows: [6], months: ["2026-08"], flight: "l" });
t("une semaine au ski en mars pas cher", { segs: [0], months: ["2027-03"], dur: 7, best: true });
t("famille de 6 en vol direct", { occ: [6], flight: "l" }); // contradiction -> Land Only
t("suite maldives", { text: "suite maldives", segs: [] });
t("short haul décembre max 1500 eur", { segs: [1], months: ["2026-12"], maxPrice: 1500 });

console.log(ko ? "\n" + ko + " test(s) en échec" : "\nTous les tests passent.");
process.exit(ko ? 1 : 0);
