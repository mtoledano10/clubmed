/**
 * clubmed-offers — reçoit le mail quotidien "offres", en extrait le .zip,
 * dézippe le classeur et le publie dans R2 pour cmoffers.netlify.app.
 *
 * Deux entrées :
 *   email()  — déclenché par Cloudflare Email Routing (offers@kwitlyapp.com)
 *   fetch()  — sert OFFERS.xlsx au front, plus /status et /archive
 *
 * Zéro dépendance : parsing MIME et ZIP écrits à la main, comme dans worker.js
 * de Kwitly (DecompressionStream fait l'inflate, il est natif aux Workers).
 */

const CURRENT_KEY = "OFFERS.xlsx";
const ARCHIVE_PREFIX = "archive/";
const ARCHIVE_KEEP_DAYS = 14;
const MAX_MESSAGE = 40 * 1024 * 1024; // garde-fou mémoire

/* ─────────────────────────  MIME  ───────────────────────── */

// Le raw d'un mail est du binaire : on le manipule en latin1 pour ne perdre
// aucun octet (une conversion UTF-8 corromprait le base64 des pièces jointes).
function bytesToLatin1(u8) {
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return out;
}

function latin1ToBytes(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

function splitHeaders(part) {
  const m = part.match(/\r?\n\r?\n/);
  if (!m) return { headers: part, body: "" };
  return {
    headers: part.slice(0, m.index),
    body: part.slice(m.index + m[0].length),
  };
}

// Déplie les en-têtes repliés sur plusieurs lignes (RFC 5322 "folding")
function headerValue(headers, name) {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp("^" + name + "\\s*:\\s*(.*)$", "im");
  const m = unfolded.match(re);
  return m ? m[1].trim() : "";
}

function paramValue(headerVal, param) {
  // filename="x.zip" | filename=x.zip | filename*=UTF-8''x.zip
  let m = headerVal.match(new RegExp(param + '\\*?\\s*=\\s*"([^"]*)"', "i"));
  if (m) return m[1];
  m = headerVal.match(new RegExp(param + "\\*\\s*=\\s*[^']*''([^;\\s]+)", "i"));
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  m = headerVal.match(new RegExp(param + "\\s*=\\s*([^;\\s]+)", "i"));
  return m ? m[1] : "";
}

const B64_LUT = (() => {
  const lut = new Uint8Array(256).fill(255);
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alpha.length; i++) lut[alpha.charCodeAt(i)] = i;
  return lut;
})();

// Décode en un seul passage, directement dans un Uint8Array. Passer par
// String.replace + atom + concat coûterait ~40 Mo de copies intermédiaires sur
// une pièce jointe de 10 Mo — le Worker n'a que 128 Mo.
function decodeBase64(body) {
  const out = new Uint8Array(((body.length + 3) >> 2) * 3);
  let acc = 0, bits = 0, n = 0;
  for (let i = 0; i < body.length; i++) {
    const v = B64_LUT[body.charCodeAt(i) & 0xff];
    if (v === 255) continue; // sauts de ligne, espaces, padding '='
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

function decodeQuotedPrintable(body) {
  const s = body
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return latin1ToBytes(s);
}

function decodePart(headers, body) {
  const enc = headerValue(headers, "Content-Transfer-Encoding").toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return latin1ToBytes(body);
}

function decodeAsText(headers, body) {
  const enc = headerValue(headers, "Content-Transfer-Encoding").toLowerCase();
  if (enc === "base64") return bytesToLatin1(decodeBase64(body));
  if (enc === "quoted-printable") return bytesToLatin1(decodeQuotedPrintable(body));
  return body;
}

/**
 * Parcourt récursivement l'arbre MIME et retourne toutes les pièces jointes.
 * Gère les multipart/* imbriqués et message/rfc822 — le cas du mail transféré,
 * où la pièce jointe se retrouve un niveau plus bas que dans l'original.
 */
function collectAttachments(raw, depth = 0, found = []) {
  if (depth > 8) return found;
  const { headers, body } = splitHeaders(raw);
  const ctype = headerValue(headers, "Content-Type");
  const lower = ctype.toLowerCase();

  if (lower.startsWith("multipart/")) {
    const boundary = paramValue(ctype, "boundary");
    if (!boundary) return found;
    const chunks = body.split("--" + boundary);
    // chunks[0] = préambule ; le dernier commence par "--" (terminateur)
    for (let i = 1; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.startsWith("--")) break;
      collectAttachments(c.replace(/^\r?\n/, ""), depth + 1, found);
    }
    return found;
  }

  if (lower.startsWith("message/rfc822")) {
    collectAttachments(decodeAsText(headers, body), depth + 1, found);
    return found;
  }

  const disp = headerValue(headers, "Content-Disposition");
  const filename = paramValue(disp, "filename") || paramValue(ctype, "name");
  if (/attachment/i.test(disp) || filename) {
    found.push({ filename: filename || "(sans nom)", ctype: lower, headers, body });
  }
  return found;
}

/* ─────────────────────────  ZIP  ───────────────────────── */

function readU16(u8, o) {
  return u8[o] | (u8[o + 1] << 8);
}
function readU32(u8, o) {
  return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) + u8[o + 3] * 0x1000000;
}

/** Liste les entrées via le central directory : les tailles du local header
 *  valent 0 quand l'archive a été écrite en streaming, pas lui. */
function listZipEntries(u8) {
  let eocd = -1;
  const from = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= from; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("archive illisible : fin de central directory introuvable");

  const count = readU16(u8, eocd + 10);
  let off = readU32(u8, eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (readU32(u8, off) !== 0x02014b50) throw new Error("central directory corrompu");
    const entry = {
      method: readU16(u8, off + 10),
      compSize: readU32(u8, off + 20),
      rawSize: readU32(u8, off + 24),
      localOff: readU32(u8, off + 42),
    };
    const nameLen = readU16(u8, off + 28);
    const extraLen = readU16(u8, off + 30);
    const cmtLen = readU16(u8, off + 32);
    entry.name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.push(entry);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

async function extractEntry(u8, entry) {
  const lo = entry.localOff;
  if (readU32(u8, lo) !== 0x04034b50) throw new Error("local header invalide pour " + entry.name);
  const start = lo + 30 + readU16(u8, lo + 26) + readU16(u8, lo + 28);
  const data = u8.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data.slice();
  if (entry.method !== 8) throw new Error("compression non gérée (méthode " + entry.method + ")");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Choisit le classeur dans l'archive : .xlsx d'abord, .xls/.csv ensuite. */
function pickWorkbook(entries) {
  const usable = entries.filter(
    (e) => !e.name.startsWith("__MACOSX/") && !e.name.endsWith("/") && e.rawSize > 0
  );
  const biggest = (list) => list.sort((a, b) => b.rawSize - a.rawSize)[0];
  const byExt = (ext) => biggest(usable.filter((e) => e.name.toLowerCase().endsWith(ext)));
  return byExt(".xlsx") || byExt(".xlsm") || byExt(".xls") || byExt(".csv") || biggest(usable);
}

/* ─────────────────────────  EMAIL  ───────────────────────── */

async function readStream(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) throw new Error("message trop volumineux (> " + Math.round(max / 1048576) + " Mo)");
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function senderAllowed(from, env) {
  const list = (env.ALLOWED_SENDERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return true; // non configuré : tout passe (voir README)
  const f = (from || "").toLowerCase();
  return list.some((a) => (a.startsWith("@") ? f.endsWith(a) : f === a));
}

async function pruneArchive(env) {
  const cutoff = Date.now() - ARCHIVE_KEEP_DAYS * 86400000;
  const listed = await env.OFFERS.list({ prefix: ARCHIVE_PREFIX });
  for (const obj of listed.objects) {
    if (obj.uploaded.getTime() < cutoff) await env.OFFERS.delete(obj.key);
  }
}

/* ─────────────────────  PAGE D'ADMINISTRATION  ───────────────────── */

const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function adminPage(env, url) {
  const jours = Math.min(parseInt(url.searchParams.get("j") || "30", 10) || 30, 365);
  const depuis = new Date(Date.now() - jours * 86400000).toISOString();

  const [resume, parPersonne, recherches] = await Promise.all([
    env.USAGE.prepare(
      "SELECT COUNT(*) AS total, SUM(kind='open') AS ouvertures, SUM(kind='search') AS recherches," +
        " COUNT(DISTINCT COALESCE(who,device)) AS personnes FROM visits WHERE ts >= ?"
    ).bind(depuis).first(),
    env.USAGE.prepare(
      "SELECT COALESCE(who,'(anonyme)') AS qui, COUNT(DISTINCT device) AS appareils," +
        " SUM(kind='open') AS ouvertures, SUM(kind='search') AS recherches," +
        " MIN(ts) AS premiere, MAX(ts) AS derniere FROM visits WHERE ts >= ?" +
        " GROUP BY qui ORDER BY derniere DESC"
    ).bind(depuis).all(),
    env.USAGE.prepare(
      "SELECT ts, COALESCE(who,'(anonyme)') AS qui, query, results, country FROM visits" +
        " WHERE kind='search' AND ts >= ? ORDER BY ts DESC LIMIT 100"
    ).bind(depuis).all(),
  ]);

  const quand = (t) => (t ? t.slice(0, 16).replace("T", " ") : "—");
  const lignesPersonnes = (parPersonne.results || [])
    .map((r) => `<tr><td><strong>${esc(r.qui)}</strong></td><td>${r.ouvertures || 0}</td><td>${r.recherches || 0}</td>` +
      `<td>${r.appareils || 0}</td><td>${quand(r.premiere)}</td><td>${quand(r.derniere)}</td></tr>`)
    .join("") || '<tr><td colspan="6" style="color:#94a3b8">Aucune visite sur la période</td></tr>';

  const lignesRecherches = (recherches.results || [])
    .map((r) => `<tr><td>${quand(r.ts)}</td><td>${esc(r.qui)}</td><td>${esc(r.query)}</td>` +
      `<td style="text-align:right">${r.results == null ? "—" : r.results.toLocaleString("fr-FR")}</td><td>${esc(r.country)}</td></tr>`)
    .join("") || '<tr><td colspan="5" style="color:#94a3b8">Aucune recherche sur la période</td></tr>';

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Usage — Club Med Offers</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f0f4f8;color:#1e293b;padding:20px}
h1{font-size:19px;margin-bottom:2px}h2{font-size:14px;margin:22px 0 8px;color:#475569}
.sub{font-size:12px;color:#7c8fa6;margin-bottom:16px}
.cards{display:flex;gap:10px;flex-wrap:wrap}
.card{background:white;border:1px solid #e5eaf2;border-radius:10px;padding:12px 16px;min-width:130px}
.card b{display:block;font-size:24px;color:#1a3a5c}
.card span{font-size:11px;color:#7c8fa6;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;background:white;border:1px solid #e5eaf2;border-radius:10px;overflow:hidden;font-size:13px}
th{background:#1a3a5c;color:white;text-align:left;padding:7px 10px;font-size:11px;font-weight:600}
td{padding:6px 10px;border-bottom:1px solid #f0f4f8}
tr:hover td{background:#f8fafc}
.per{margin-top:18px;font-size:12px}.per a{color:#1a3a5c;margin-right:10px}
.note{margin-top:22px;font-size:11.5px;color:#7c8fa6;line-height:1.6;max-width:760px}
</style></head><body>
<h1>Qui utilise l'outil</h1>
<div class="sub">Club Med Offers — ${jours} derniers jours</div>
<div class="cards">
  <div class="card"><b>${resume.personnes || 0}</b><span>personnes</span></div>
  <div class="card"><b>${resume.ouvertures || 0}</b><span>ouvertures</span></div>
  <div class="card"><b>${resume.recherches || 0}</b><span>recherches</span></div>
</div>
<div class="per">Période :
  <a href="?k=${esc(url.searchParams.get("k"))}&j=7">7 jours</a>
  <a href="?k=${esc(url.searchParams.get("k"))}&j=30">30 jours</a>
  <a href="?k=${esc(url.searchParams.get("k"))}&j=365">1 an</a></div>
<h2>Par personne</h2>
<table><thead><tr><th>Qui</th><th>Ouvertures</th><th>Recherches</th><th>Appareils</th><th>Première visite</th><th>Dernière visite</th></tr></thead>
<tbody>${lignesPersonnes}</tbody></table>
<h2>Dernières recherches</h2>
<table><thead><tr><th>Quand (UTC)</th><th>Qui</th><th>Recherche</th><th>Résultats</th><th>Pays</th></tr></thead>
<tbody>${lignesRecherches}</tbody></table>
<p class="note"><strong>Ce que vaut le nom affiché :</strong> il est déclaré par l'utilisateur lui-même au premier
usage, pas vérifié. Il répond à « qui se sert de l'outil », pas à « qui a le droit d'y accéder » : n'importe qui
connaissant l'URL peut ouvrir l'app et saisir le nom qu'il veut. Pour une identité vérifiée et un accès restreint,
il faut activer Cloudflare Access (Zero Trust) sur ce worker — la colonne « Qui » basculera alors automatiquement
sur l'adresse e-mail authentifiée.</p>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store" } });
}

export default {
  async email(message, env) {
    const from = message.from || "";
    // Tracé dans `wrangler tail` : un mail refusé disparaît sinon sans laisser
    // de quoi comprendre pourquoi (mauvais expéditeur ? zip absent ?).
    const refuse = (raison) => {
      console.log("REFUSÉ — " + raison + " | from=" + from + " | sujet=" + (message.headers.get("subject") || ""));
      message.setReject(raison);
    };

    if (!senderAllowed(from, env)) {
      refuse("Expéditeur non autorisé");
      return;
    }

    const raw = await readStream(message.raw, MAX_MESSAGE);
    const attachments = collectAttachments(bytesToLatin1(raw));

    const zip = attachments.find(
      (a) => /\.zip$/i.test(a.filename) || /zip|x-compressed/.test(a.ctype)
    );
    if (!zip) {
      refuse("Aucune pièce jointe .zip dans ce message");
      return;
    }

    const zipBytes = decodePart(zip.headers, zip.body);
    const chosen = pickWorkbook(listZipEntries(zipBytes));
    if (!chosen) {
      refuse("Archive vide");
      return;
    }
    const workbook = await extractEntry(zipBytes, chosen);

    // Un .xlsx est lui-même un zip : on refuse un fichier manifestement cassé
    // plutôt que d'écraser les données de la veille par du vide.
    const isXlsx = /\.xls[xm]?$/i.test(chosen.name);
    if (isXlsx && !(workbook[0] === 0x50 && workbook[1] === 0x4b)) {
      refuse("Le classeur extrait n'est pas un fichier Excel valide");
      return;
    }
    if (workbook.length < 1024) {
      refuse("Classeur suspect (" + workbook.length + " octets)");
      return;
    }

    const now = new Date();
    const meta = {
      httpMetadata: {
        contentType: isXlsx
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv",
      },
      customMetadata: {
        receivedAt: now.toISOString(),
        from,
        subject: message.headers.get("subject") || "",
        zipName: zip.filename,
        innerName: chosen.name,
        bytes: String(workbook.length),
      },
    };

    await env.OFFERS.put(CURRENT_KEY, workbook, meta);
    await env.OFFERS.put(ARCHIVE_PREFIX + now.toISOString().slice(0, 10) + ".xlsx", workbook, meta);
    await pruneArchive(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      // Sans ça, fetch() côté navigateur ne voit PAS x-updated-at : seuls les
      // en-têtes « sûrs » traversent le CORS, le reste doit être exposé ici.
      "Access-Control-Expose-Headers": "x-updated-at, etag, content-length",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    /* ── Qui ouvre l'outil et ce qu'il cherche ──
       Best-effort de bout en bout : une erreur de journalisation ne doit
       jamais empêcher un commercial de consulter ses prix. */
    if (url.pathname === "/api/track" && request.method === "POST") {
      try {
        const b = await request.json();
        // Chaîne vide -> NULL, sinon le regroupement « (anonyme) » de la page
        // d'admin (COALESCE) ne se déclencherait jamais.
        const coupe = (v, n) => {
          const t = v == null ? "" : String(v).trim().slice(0, n);
          return t === "" ? null : t;
        };
        const kind = b.kind === "search" ? "search" : "open";
        await env.USAGE.prepare(
          "INSERT INTO visits (ts,kind,who,device,query,results,ip,country,ua) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(
          new Date().toISOString(),
          kind,
          // Si Cloudflare Access est activé un jour, l'identité vérifiée prime
          // sur le nom déclaré par l'utilisateur lui-même.
          coupe(request.headers.get("cf-access-authenticated-user-email") || b.who, 120),
          coupe(b.device, 40),
          coupe(b.query, 300),
          Number.isFinite(b.results) ? b.results : null,
          coupe(request.headers.get("cf-connecting-ip"), 45),
          coupe(request.cf && request.cf.country, 8),
          coupe(request.headers.get("user-agent"), 200)
        ).run();
      } catch (e) {
        console.log("track KO: " + e.message);
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/admin") {
      // 404 plutôt que 403 : inutile de confirmer que la page existe.
      if (!env.ADMIN_KEY || url.searchParams.get("k") !== env.ADMIN_KEY) {
        return new Response("Page inconnue", { status: 404, headers: cors });
      }
      return adminPage(env, url);
    }

    if (url.pathname === "/status") {
      const head = await env.OFFERS.head(CURRENT_KEY);
      if (!head) {
        return Response.json({ ok: false, error: "aucun fichier reçu" }, { status: 404, headers: cors });
      }
      return Response.json(
        {
          ok: true,
          updatedAt: head.customMetadata?.receivedAt || head.uploaded.toISOString(),
          size: head.size,
          innerName: head.customMetadata?.innerName || "",
          subject: head.customMetadata?.subject || "",
        },
        { headers: cors }
      );
    }

    if (url.pathname === "/archive") {
      const listed = await env.OFFERS.list({ prefix: ARCHIVE_PREFIX });
      return Response.json(
        listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
        { headers: cors }
      );
    }

    // Routes explicites uniquement : sans ça, la moindre URL erronée renvoyait
    // les 9 Mo du classeur, et « / » ne pouvait pas servir l'app elle-même.
    let key = null;
    if (url.pathname === "/" + CURRENT_KEY) key = CURRENT_KEY;
    else if (/^\/archive\/\d{4}-\d{2}-\d{2}\.xlsx$/.test(url.pathname)) key = url.pathname.slice(1);
    if (!key) return new Response("Page inconnue", { status: 404, headers: cors });

    const obj = await env.OFFERS.get(key, { onlyIf: request.headers });
    if (!obj) return new Response("Aucune donnée disponible", { status: 404, headers: cors });

    const headers = new Headers(cors);
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set("cache-control", "no-cache");
    headers.set("x-updated-at", obj.customMetadata?.receivedAt || obj.uploaded.toISOString());
    if (!obj.body) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : obj.body, { headers });
  },
};

// exporté pour les tests sous Node (scripts/test-parse.mjs)
export const _internals = {
  bytesToLatin1,
  latin1ToBytes,
  collectAttachments,
  decodePart,
  listZipEntries,
  extractEntry,
  pickWorkbook,
  senderAllowed,
};
