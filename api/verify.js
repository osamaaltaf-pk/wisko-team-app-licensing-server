// =========================================================================
//  OMNI SKETCHES — /api/verify
//  Called on every app start. Validates license, device, expiry & quota.
//  Returns remaining credits for the current month.
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

  const { license_key, machine_id } = req.body || {};

  if (!license_key || !machine_id) {
    return res.status(400).json({
      message: 'license_key and machine_id are required.'
    });
  }



  if (!supabase) {
    return res.status(500).json({ message: 'Server config error: Supabase not connected.' });
  }

  try {
    // 1. Fetch license
    const { data: license, error: licErr } = await supabase
      .from('licenses')
      .select('*')
      .eq('license_key', license_key)
      .single();

    if (licErr || !license) {
      return res.status(404).json({ message: 'Invalid license key.' });
    }
    if (license.status === 'revoked') {
      return res.status(403).json({ message: 'License revoked. Contact support.' });
    }

    // 2. Check expiry (server clock — tamper-proof)
    const now        = new Date();
    const expiryDate = new Date(license.expiry_date);
    if (now > expiryDate) {
      await supabase.from('licenses').update({ status: 'expired' }).eq('id', license.id);
      return res.status(403).json({
        message: `License expired on ${expiryDate.toDateString()}. Please renew.`
      });
    }

    // 3. Verify machine_id is registered to this license
    const { data: devices, error: devErr } = await supabase
      .from('active_devices')
      .select('machine_id')
      .eq('license_id', license.id);

    if (devErr) {
      return res.status(500).json({ message: `Device check error: ${devErr.message}` });
    }

    const isRegistered = (devices || []).some(d => d.machine_id === machine_id);
    if (!isRegistered) {
      return res.status(403).json({
        message: 'Hardware mismatch. This license is bound to a different device.'
      });
    }

    // 4. Update last_seen_at (heartbeat)
    await supabase
      .from('active_devices')
      .update({ last_seen_at: now.toISOString() })
      .eq('license_id', license.id)
      .eq('machine_id', machine_id);

    // 5. Fetch monthly usage
    const { data: usage } = await supabase
      .from('monthly_usage')
      .select('generations_this_month')
      .eq('license_id', license.id)
      .single();

    const used      = usage?.generations_this_month || 0;
    const remaining = Math.max(license.monthly_gen_limit - used, 0);

    // Days left on license
    const msPerDay  = 1000 * 60 * 60 * 24;
    const daysLeft  = Math.ceil((expiryDate - now) / msPerDay);

    return res.status(200).json({
      status:            'success',
      message:           'License verified.',
      plan_name:         license.plan_name,
      expiry_date:       license.expiry_date,
      days_remaining:    daysLeft,
      monthly_gen_limit: license.monthly_gen_limit,
      used_this_month:   used,
      remaining_credits: remaining
    });

  } catch (err) {
    console.error('[verify] exception:', err);
    return res.status(500).json({ message: `Server error: ${err.message}` });
  }
};
