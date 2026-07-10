-- 天枢授权服务器 D1 schema
-- 激活码表：一码可绑 N 台设备，可设有效期与吊销。
CREATE TABLE IF NOT EXISTS codes (
  code             TEXT PRIMARY KEY,
  tier             TEXT NOT NULL DEFAULT 'pro',
  max_activations  INTEGER NOT NULL DEFAULT 1,
  used_count       INTEGER NOT NULL DEFAULT 0,
  license_expires  INTEGER,            -- unix ms；NULL = 永久授权
  trial_days       INTEGER,            -- 非 NULL = 试用码：首次激活时回填 license_expires = 激活时刻 + trial_days 天
  revoked          INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       INTEGER NOT NULL
);

-- 激活记录表：设备指纹 ↔ 激活码，用于吊销与去重（幂等激活）。
CREATE TABLE IF NOT EXISTS activations (
  device_id     TEXT NOT NULL,
  code          TEXT NOT NULL,
  activated_at  INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, code)
);

CREATE INDEX IF NOT EXISTS idx_activations_code ON activations(code);
