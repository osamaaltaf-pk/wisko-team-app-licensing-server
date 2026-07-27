// =========================================================================
//  OMNI SKETCHES — /api/generate-key
//  Admin-only endpoint. Protected by ADMIN_SECRET_KEY env variable.
//  Generates a cryptographically random OMNI-SK-XXXX-XXXX-XXXX-XXXX key
//  and writes it to Supabase with the chosen plan limits.
// =========================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key) : null;
})();

// Plan presets — map plan name → default limits
const PLAN_PRESETS = {
  'Pro':              { max_devices: 1, monthly_gen_limit: 50,     validity_days: 30  },
  'Pro 3 Devices':    { max_devices: 3, monthly_gen_limit: 150,    validity_days: 30  },
  'Enterprise':       { max_devices: 10, monthly_gen_limit: 999999, validity_days: 365 },
};

/** Generate a random 4-char alphanumeric block */
const randBlock = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ message: 'Method Not Allowed' });

  const {
    admin_key,
    plan_name      = 'Pro',
    validity_days,       // override if provided
    monthly_gen_limit,   // override if provided (labelled "Credits/Limits" in UI)
    max_devices          // override if provided
  } = req.body || {};

  // 1. Admin auth
  const serverAdminKey = process.env.ADMIN_SECRET_KEY || 'OmniAdminSecure2026!';
  if (admin_key !== serverAdminKey) {
    return res.status(401).json({ message: 'Unauthorized: Invalid Admin Secret Key.' });
  }

  if (!supabase) {
    return res.status(500).json({ message: 'Server config error: Supabase not connected.' });
  }

  // 2. Resolve plan defaults, then apply any manual overrides
  const preset = PLAN_PRESETS[plan_name] || PLAN_PRESETS['Pro'];
  const finalMaxDevices      = parseInt(max_devices)        || preset.max_devices;
  const finalMonthlyLimit    = parseInt(monthly_gen_limit)  || preset.monthly_gen_limit;
  const finalValidityDays    = parseInt(validity_days)      || preset.validity_days;

  // 3. Generate unique key  OMNI-SK-XXXX-XXXX-XXXX-XXXX
  const licenseKey = `OMNI-SK-${randBlock()}-${randBlock()}-${randBlock()}-${randBlock()}`;

  try {
    const { data, error } = await supabase
      .from('licenses')
      .insert([{
        license_key:        licenseKey,
        plan_name,
        max_devices:        finalMaxDevices,
        validity_days:      finalValidityDays,
        monthly_gen_limit:  finalMonthlyLimit,
        status:             'active',
        created_at:         new Date().toISOString()
      }])
      .select();

    if (error) {
      console.error('[generate-key] supabase error:', error);
      return res.status(500).json({ message: `Database error: ${error.message}` });
    }

    return res.status(200).json({
      message:            '✅ License key generated successfully!',
      license_key:        licenseKey,
      plan_name,
      max_devices:        finalMaxDevices,
      validity_days:      finalValidityDays,
      monthly_gen_limit:  finalMonthlyLimit,
      created_at:         data[0]?.created_at
    });

  } catch (err) {
    console.error('[generate-key] exception:', err);
    return res.status(500).json({ message: `Server error: ${err.message}` });
  }
};
