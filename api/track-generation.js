// =========================================================================
//  OMNI SKETCHES — /api/track-generation
//  Called BEFORE every sketch generation attempt.
//  Atomically checks quota, logs the generation, returns remaining credits.
//  The app should only proceed with OpenCV processing if status = 'success'.
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

  const {
    license_key,
    machine_id,
    platform   = 'desktop',
    mode       = 'studio',     // which app mode: studio | canvas | auto | agent | tts ...
    image_name = null          // optional metadata
  } = req.body || {};

  if (!license_key || !machine_id) {
    return res.status(400).json({ message: 'license_key and machine_id are required.' });
  }



  if (!supabase) {
    return res.status(500).json({ message: 'Server config error: Supabase not connected.' });
  }

  try {
    // 1. Fetch license
    const { data: license, error: licErr } = await supabase
      .from('licenses')
      .select('id, status, expiry_date, monthly_gen_limit, plan_name')
      .eq('license_key', license_key)
      .single();

    if (licErr || !license) {
      return res.status(404).json({ message: 'Invalid license key.' });
    }
    if (license.status === 'revoked') {
      return res.status(403).json({ message: 'License revoked. Contact support.' });
    }

    // 2. Check expiry
    const now        = new Date();
    const expiryDate = new Date(license.expiry_date);
    if (now > expiryDate) {
      await supabase.from('licenses').update({ status: 'expired' }).eq('id', license.id);
      return res.status(403).json({ message: 'License expired. Please renew to continue.' });
    }

    // 3. Verify machine is registered
    const { data: devices } = await supabase
      .from('active_devices')
      .select('machine_id')
      .eq('license_id', license.id);

    const isRegistered = (devices || []).some(d => d.machine_id === machine_id);
    if (!isRegistered) {
      return res.status(403).json({
        message: 'Device not registered for this license. Please activate first.'
      });
    }

    // 4. Count successful generations this calendar month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    const { count: usedCount, error: countErr } = await supabase
      .from('generation_log')
      .select('id', { count: 'exact', head: true })
      .eq('license_id', license.id)
      .eq('status', 'success')
      .gte('created_at', monthStart)
      .lt('created_at',  monthEnd);

    if (countErr) {
      return res.status(500).json({ message: `Usage check error: ${countErr.message}` });
    }

    const used      = usedCount || 0;
    const limit     = license.monthly_gen_limit;
    const remaining = limit - used;  // can be negative if somehow over

    // 5. Quota enforcement — block if no credits left
    if (remaining <= 0) {
      // Log the blocked attempt
      await supabase.from('generation_log').insert([{
        license_id: license.id,
        machine_id,
        platform,
        mode,
        image_name,
        status:     'quota_exceeded',
        created_at: now.toISOString()
      }]);

      return res.status(429).json({
        status:            'quota_exceeded',
        message:           `Monthly limit reached (${used}/${limit} generations used). Resets on the 1st of next month.`,
        remaining_credits: 0,
        used_this_month:   used,
        monthly_gen_limit: limit
      });
    }

    // 6. All checks passed — log this generation as 'success'
    const { error: logErr } = await supabase.from('generation_log').insert([{
      license_id: license.id,
      machine_id,
      platform,
      mode,
      image_name,
      status:     'success',
      created_at: now.toISOString()
    }]);

    if (logErr) {
      console.error('[track-generation] log insert error:', logErr);
      // Non-fatal — still allow the generation to proceed
    }

    // 7. Update device last_seen_at heartbeat
    await supabase
      .from('active_devices')
      .update({ last_seen_at: now.toISOString() })
      .eq('license_id', license.id)
      .eq('machine_id', machine_id);

    const newRemaining = Math.max(remaining - 1, 0);

    return res.status(200).json({
      status:            'success',
      message:           `Generation allowed. ${newRemaining} credits remaining this month.`,
      remaining_credits: newRemaining,
      used_this_month:   used + 1,
      monthly_gen_limit: limit,
      plan_name:         license.plan_name
    });

  } catch (err) {
    console.error('[track-generation] exception:', err);
    return res.status(500).json({ message: `Server error: ${err.message}` });
  }
};
