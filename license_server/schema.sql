-- =========================================================================
--  WISKO_TEAM — SUPABASE DATABASE SCHEMA v1.0
--  Run this once in the Supabase SQL Editor to initialise the database.
-- =========================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. LICENSES TABLE
--    Stores every issued license key with its plan limits & expiry details.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    license_key         VARCHAR(255)  NOT NULL UNIQUE,
    gmail               VARCHAR(255)  DEFAULT NULL,
    password_hash       VARCHAR(255)  DEFAULT NULL,        -- plain or hashed; matched on activate
    plan_name           VARCHAR(100)  DEFAULT 'Pro',       -- 'Pro', 'Pro 3 Devices', 'Enterprise'
    max_devices         INT           DEFAULT 1,           -- concurrent device slots
    validity_days       INT           DEFAULT 30,          -- days from first activation
    expiry_date         TIMESTAMPTZ   DEFAULT NULL,        -- set on first activation
    monthly_gen_limit   INT           DEFAULT 50,          -- sketch generations allowed per month
    status              VARCHAR(50)   DEFAULT 'active'
                            CHECK (status IN ('active', 'expired', 'revoked')),
    created_at          TIMESTAMPTZ   DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. ACTIVE DEVICES TABLE
--    Binds hardware fingerprints (machine_id / ANDROID_ID) to a license.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS active_devices (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id      UUID          NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    machine_id      VARCHAR(255)  NOT NULL,                -- WMI serial (desktop) or ANDROID_ID (mobile)
    platform        VARCHAR(50)   DEFAULT 'desktop',       -- 'desktop', 'android', 'web'
    registered_at   TIMESTAMPTZ   DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ   DEFAULT NOW(),
    UNIQUE(license_id, machine_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. GENERATION LOG TABLE
--    Tracks every sketch generation.  Used for monthly quota enforcement.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generation_log (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id      UUID          NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    machine_id      VARCHAR(255)  NOT NULL,
    platform        VARCHAR(50)   DEFAULT 'desktop',
    mode            VARCHAR(50)   DEFAULT 'studio',        -- which app mode: studio | canvas | auto | agent | tts ...
    image_name      VARCHAR(500)  DEFAULT NULL,            -- optional: filename of source image
    status          VARCHAR(50)   DEFAULT 'success'
                        CHECK (status IN ('success', 'failed', 'quota_exceeded')),
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- Migration for databases created before the `mode` column existed:
ALTER TABLE generation_log ADD COLUMN IF NOT EXISTS mode VARCHAR(50) DEFAULT 'studio';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. INDEXES — fast lookup on hot query paths
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_licenses_key         ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status      ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_devices_license      ON active_devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_machine      ON active_devices(machine_id);
CREATE INDEX IF NOT EXISTS idx_genlog_license       ON generation_log(license_id);
CREATE INDEX IF NOT EXISTS idx_genlog_created       ON generation_log(created_at);
CREATE INDEX IF NOT EXISTS idx_genlog_mode          ON generation_log(mode);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. MONTHLY USAGE VIEW
--    Returns generation count per license for the CURRENT calendar month.
--    Used by /api/track-generation to check quota before allowing a run.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW monthly_usage AS
SELECT
    license_id,
    COUNT(*) AS generations_this_month
FROM generation_log
WHERE
    status      = 'success'
    AND created_at >= DATE_TRUNC('month', NOW())
    AND created_at <  DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
GROUP BY license_id;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. HELPER FUNCTION — get remaining credits for a license this month
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_remaining_credits(p_license_id UUID)
RETURNS INT AS $$
DECLARE
    v_limit     INT;
    v_used      INT;
BEGIN
    SELECT monthly_gen_limit INTO v_limit FROM licenses WHERE id = p_license_id;
    SELECT COALESCE(generations_this_month, 0) INTO v_used
    FROM   monthly_usage WHERE license_id = p_license_id;
    IF v_used IS NULL THEN
        v_used := 0;
    END IF;
    RETURN GREATEST(COALESCE(v_limit, 0) - v_used, 0);
END;
$$ LANGUAGE plpgsql;



-- ─────────────────────────────────────────────────────────────────────────
-- 7. ANALYTICS VIEWS
--    Used by GET /api/analytics (admin-only) to show, per license/user:
--    total generations, breakdown by mode, and last-active timestamp.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW analytics_by_license AS
SELECT
    l.id                    AS license_id,
    l.license_key,
    l.gmail,
    l.plan_name,
    l.status,
    l.monthly_gen_limit,
    l.expiry_date,
    COUNT(g.id) FILTER (WHERE g.status = 'success')          AS total_generations,
    COUNT(g.id) FILTER (
        WHERE g.status = 'success'
        AND g.created_at >= DATE_TRUNC('month', NOW())
    )                                                          AS generations_this_month,
    MAX(g.created_at)                                          AS last_active_at
FROM licenses l
LEFT JOIN generation_log g ON g.license_id = l.id
GROUP BY l.id, l.license_key, l.gmail, l.plan_name, l.status, l.monthly_gen_limit, l.expiry_date;

CREATE OR REPLACE VIEW analytics_by_mode AS
SELECT
    l.id            AS license_id,
    l.license_key,
    l.gmail,
    g.mode,
    COUNT(g.id) FILTER (WHERE g.status = 'success') AS total_generations,
    MAX(g.created_at)                                AS last_used_at
FROM licenses l
JOIN generation_log g ON g.license_id = l.id
GROUP BY l.id, l.license_key, l.gmail, g.mode;


-- =========================================================================
--  HOW TO CONNECT THIS DATABASE WITH VERCEL
-- =========================================================================
--
--  1. Supabase Dashboard → Settings → API
--     • Copy "Project URL"
--     • Copy "service_role" secret key
--
--  2. Vercel Dashboard → Your Project → Settings → Environment Variables
--     Add these variables:
--
--     SUPABASE_URL              = https://your-project.supabase.co
--     SUPABASE_SERVICE_ROLE_KEY = (service_role secret — never expose publicly)
--     ADMIN_SECRET_KEY          = (your chosen admin password for the portal)
--
--  3. Redeploy your Vercel project.
--
--  KEY FORMAT:  OMNI-SK-XXXX-XXXX-XXXX-XXXX

-- =========================================================================
