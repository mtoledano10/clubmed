/**
 * Fabrique un .eml de test (mail avec pièce jointe .zip contenant OFFERS.xlsx)
 * pour déclencher le handler email() dans wrangler dev :
 *
 *   node worker/scripts/make-test-mail.mjs <sortie.eml>
 *   curl -X POST http://localhost:8787/cdn-cgi/handler/email \
 *        -H "from:reporting@example.com" -H "to:offers@kwitlyapp.com" \
 *        --data-binary @sortie.eml
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, "test-mail.eml");
// 2e argument "small" : classeur factice de 6 Ko, pour tester le chemin sans
// payer 10 Mo de base64 à chaque essai.
const original =
  process.argv[3] === "small"
    ? Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(6000, 0x41)])
    : readFileSync(join(here, "..", "..", "OFFERS.xlsx"));

function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
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

const zip = makeZip([{ name: "OFFERS_20260819.xlsx", data: original }]);
const b = "----=_Part_test_boundary";
const mail = [
  "From: reporting@example.com",
  "To: offers@kwitlyapp.com",
  "Subject: Daily offers export 19/08",
  "Message-ID: <test-" + Date.now() + "@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="' + b + '"',
  "",
  "--" + b,
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Export du jour en pièce jointe.",
  "",
  "--" + b,
  'Content-Type: application/zip; name="offers_20260819.zip"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="offers_20260819.zip"',
  "",
  zip.toString("base64").replace(/(.{76})/g, "$1\r\n"),
  "",
  "--" + b + "--",
  "",
].join("\r\n");

writeFileSync(out, mail, "latin1");
console.log(out + " — " + mail.length.toLocaleString() + " octets (zip " + zip.length.toLocaleString() + ")");
