// =========================================================================
//  OMNI SKETCHES — /api/analytics
//  Admin-only endpoint. Protected by ADMIN_SECRET_KEY (same as generate-key).
//  Returns, per license/user: total generations, this-month generations,
//  last-active time, and a breakdown of how many generations came from
//  each app mode (studio / canvas / auto / agent / tts ...).
//
//  Usage:  POST /api/analytics   { "admin_key": "..." }
//  Optional body filters:
//    { "admin_key": "...", "license_key": "OMNI-SK-...." }   -> single user
//    { "admin_key": "...", "gmail": "user@gmail.com" }       -> single user
// =========================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key) : null;
})();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ message: 'Method Not Allowed' });

  const { admin_key, license_key, gmail } = req.body || {};

  const serverAdminKey = process.env.ADMIN_SECRET_KEY || 'OmniAdminSecure2026!';
  if (admin_key !== serverAdminKey) {
    return res.status(401).json({ message: 'Unauthorized: Invalid Admin Secret Key.' });
  }

  if (!supabase) {
    return res.status(500).json({ message: 'Server config error: Supabase not connected.' });
  }

  try {
    // 1. Per-license summary (total generations, this month, last active)
    let summaryQuery = supabase.from('analytics_by_license').select('*');
    if (license_key) summaryQuery = summaryQuery.eq('license_key', license_key);
    if (gmail)       summaryQuery = summaryQuery.eq('gmail', gmail.toLowerCase().trim());
    const { data: summary, error: summaryErr } = await summaryQuery.order('last_active_at', { ascending: false, nullsFirst: false });
    if (summaryErr) return res.status(500).json({ message: `Analytics error: ${summaryErr.message}` });

    // 2. Per-mode breakdown
    let modeQuery = supabase.from('analytics_by_mode').select('*');
    if (license_key) modeQuery = modeQuery.eq('license_key', license_key);
    if (gmail)       modeQuery = modeQuery.eq('gmail', gmail.toLowerCase().trim());
    const { data: modeRows, error: modeErr } = await modeQuery;
    if (modeErr) return res.status(500).json({ message: `Analytics error: ${modeErr.message}` });

    // Group mode rows under each license_id
    const modeByLicense = {};
    for (const row of modeRows || []) {
      if (!modeByLicense[row.license_id]) modeByLicense[row.license_id] = [];
      modeByLicense[row.license_id].push({
        mode: row.mode,
        total_generations: row.total_generations,
        last_used_at: row.last_used_at
      });
    }

    const users = (summary || []).map(u => ({
      license_key:            u.license_key,
      gmail:                  u.gmail,
      plan_name:               u.plan_name,
      status:                  u.status,
      monthly_gen_limit:       u.monthly_gen_limit,
      expiry_date:             u.expiry_date,
      total_generations:       u.total_generations || 0,
      generations_this_month:  u.generations_this_month || 0,
      last_active_at:          u.last_active_at,
      modes:                   modeByLicense[u.license_id] || []
    }));

    return res.status(200).json({
      status:      'success',
      user_count:  users.length,
      users
    });

  } catch (err) {
    console.error('[analytics] exception:', err);
    return res.status(500).json({ message: `Server error: ${err.message}` });
  }
};
