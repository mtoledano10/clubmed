/**
 * Test bout en bout du pipeline mail -> zip -> classeur, sous Node.
 * Fabrique un vrai .zip (deflate) contenant le OFFERS.xlsx du repo, l'emballe
 * dans un message MIME base64 (cas simple ET cas "mail transféré" imbriqué),
 * puis vérifie que le worker en ressort les octets exacts d'origine.
 *
 *   node worker/scripts/test-parse.mjs
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { _internals } = await import("../offers-worker.js");
const { collectAttachments, decodePart, listZipEntries, extractEntry, pickWorkbook, bytesToLatin1, senderAllowed } =
  _internals;

const here = dirname(fileURLToPath(import.meta.url));
const xlsxPath = join(here, "..", "..", "OFFERS.xlsx");

/* ── mini écrivain ZIP (deflate) ── */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // method deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, Buffer.from(name), comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, Buffer.from(name));
    offset += local.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const b64lines = (buf) => buf.toString("base64").replace(/(.{76})/g, "$1\r\n");

function simpleMail(zip, zipName) {
  const b = "----=_Part_001_boundary";
  return [
    "From: reporting@example.com",
    "Subject: Daily offers export",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="' + b + '"',
    "",
    "--" + b,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Veuillez trouver ci-joint l'export du jour.",
    "",
    "--" + b,
    'Content-Type: application/zip; name="' + zipName + '"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="' + zipName + '"',
    "",
    b64lines(zip),
    "",
    "--" + b + "--",
    "",
  ].join("\r\n");
}

// Cas Outlook "Transférer" : le message d'origine devient une pièce jointe
// message/rfc822, la pièce jointe zip se retrouve deux niveaux plus bas.
function forwardedMail(zip, zipName) {
  const outer = "----=_Outer_boundary";
  const inner = simpleMail(zip, zipName);
  return [
    "From: mickael@example.com",
    "Subject: TR: Daily offers export",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="' + outer + '"',
    "",
    "--" + outer,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Transfert automatique.",
    "",
    "--" + outer,
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="original.eml"',
    "",
    inner,
    "",
    "--" + outer + "--",
    "",
  ].join("\r\n");
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

let failures = 0;
function check(label, cond, detail = "") {
  console.log((cond ? "  OK   " : "  FAIL ") + label + (detail ? " — " + detail : ""));
  if (!cond) failures++;
}

/* ── run ── */
const original = readFileSync(xlsxPath);
console.log("OFFERS.xlsx source : " + original.length.toLocaleString() + " octets, sha " + sha(original).slice(0, 12));

const zip = makeZip([
  { name: "readme.txt", data: Buffer.from("export quotidien") },
  { name: "OFFERS_20260819.xlsx", data: original },
]);
console.log("zip fabriqué       : " + zip.length.toLocaleString() + " octets\n");

for (const [label, raw] of [
  ["mail simple", simpleMail(zip, "offers_20260819.zip")],
  ["mail transféré (message/rfc822 imbriqué)", forwardedMail(zip, "offers_20260819.zip")],
]) {
  console.log(label + " :");
  const t0 = Date.now();
  const atts = collectAttachments(bytesToLatin1(Buffer.from(raw, "latin1")));
  const found = atts.find((a) => /\.zip$/i.test(a.filename) || /zip/.test(a.ctype));
  check("pièce jointe .zip trouvée", !!found, found ? found.filename : "aucune");
  const bytes = decodePart(found.headers, found.body);
  check("zip décodé à l'octet près", sha(Buffer.from(bytes)) === sha(zip));
  const entries = listZipEntries(bytes);
  check("2 entrées listées", entries.length === 2, entries.map((e) => e.name).join(", "));
  const chosen = pickWorkbook(entries);
  check("classeur choisi = le .xlsx", chosen.name === "OFFERS_20260819.xlsx", chosen.name);
  const out = Buffer.from(await extractEntry(bytes, chosen));
  check("classeur extrait identique à l'original", sha(out) === sha(original), out.length.toLocaleString() + " octets");
  console.log("  (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)\n");
}

console.log("allowlist expéditeur :");
check("liste vide = tout passe", senderAllowed("x@y.com", {}));
check("adresse exacte acceptée", senderAllowed("Reporting@Example.com", { ALLOWED_SENDERS: "reporting@example.com" }));
check("adresse hors liste rejetée", !senderAllowed("pirate@ailleurs.com", { ALLOWED_SENDERS: "reporting@example.com" }));
check("domaine entier accepté", senderAllowed("bob@clubmed.com", { ALLOWED_SENDERS: "@clubmed.com" }));

console.log(failures ? "\n" + failures + " test(s) en échec" : "\nTous les tests passent.");
process.exit(failures ? 1 : 0);
