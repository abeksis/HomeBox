-- get.abeksis.net counters. Nothing here identifies a person or a box.

-- Installs and uninstalls: one counter per day, script and country.
CREATE TABLE IF NOT EXISTS events (
  day     TEXT    NOT NULL,          -- YYYY-MM-DD, UTC
  kind    TEXT    NOT NULL,          -- install | uninstall
  country TEXT    NOT NULL,          -- ISO code from Cloudflare, XX if unknown
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, country)
);

-- Running boxes, for at most two days: id is sha256(salt | day | ip), so a box
-- counts once per day and cannot be followed from one day to the next.
CREATE TABLE IF NOT EXISTS boxes (
  day     TEXT NOT NULL,
  id      TEXT NOT NULL,
  version TEXT NOT NULL,
  country TEXT NOT NULL,
  PRIMARY KEY (day, id)
);

-- What the daily cron keeps once the rows above are gone.
CREATE TABLE IF NOT EXISTS box_days (
  day     TEXT    NOT NULL,
  version TEXT    NOT NULL,
  country TEXT    NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (day, version, country)
);
