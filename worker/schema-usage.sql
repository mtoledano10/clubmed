-- Journal d'usage de l'outil : qui l'ouvre, quand, et ce qu'il cherche.
CREATE TABLE IF NOT EXISTS visits (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,          -- ISO 8601 UTC
  kind     TEXT NOT NULL,          -- 'open' | 'search'
  who      TEXT,                   -- nom déclaré, ou email si Cloudflare Access est activé
  device   TEXT,                   -- identifiant anonyme du navigateur (localStorage)
  query    TEXT,                   -- la phrase tapée
  results  INTEGER,                -- nombre d'offres trouvées
  ip       TEXT,
  country  TEXT,
  ua       TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_who ON visits(who);
