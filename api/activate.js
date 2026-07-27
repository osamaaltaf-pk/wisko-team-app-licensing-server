// =========================================================================
//  OMNI SKETCHES — /api/activate
//  First-time activation: bind gmail + machine_id, start expiry countdown.
//  Also handles re-activation of already-registered hardware.
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

  const { license_key, gmail, password, machine_id, platform = 'desktop' } = req.body || {};

  if (!license_key || !gmail || !password || !machine_id) {
    return res.status(400).json({
      message: 'Missing fields: license_key, gmail, password, and machine_id are all required.'
    });
  }



  if (!supabase) {
    return res.status(500).json({ message: 'Server config error: Supabase not connected.' });
  }

  try {
    // 1. Fetch license row
    const { data: license, error: licErr } = await supabase
      .from('licenses')
      .select('*')
      .eq('license_key', license_key)
      .single();

    if (licErr || !license) {
      return res.status(404).json({ message: 'Invalid license key. Please check and try again.' });
    }
    if (license.status === 'revoked') {
      return res.status(403).json({ message: 'This license has been revoked. Contact support.' });
    }

    const now = new Date();

    // 2. Fresh activation (no gmail bound yet)
    if (!license.gmail) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + license.validity_days);

      const { error: updErr } = await supabase
        .from('licenses')
        .update({
          gmail:         gmail.toLowerCase().trim(),
          password_hash: password,
          expiry_date:   expiry.toISOString(),
          status:        'active'
        })
        .eq('id', license.id);

      if (updErr) return res.status(500).json({ message: `Activation error: ${updErr.message}` });

      await supabase.from('active_devices').insert([{
        license_id:    license.id,
        machine_id,
        platform,
        registered_at: now.toISOString(),
        last_seen_at:  now.toISOString()
      }]);

      return res.status(200).json({
        status:            'success',
        message:           'License activated and device registered!',
        gmail,
        expiry_date:       expiry.toISOString(),
        monthly_gen_limit: license.monthly_gen_limit,
        remaining_credits: license.monthly_gen_limit,
        token:             `OMNI-TOKEN-${license.id}`
      });
    }

    // 3. Re-activation: verify credentials
    if (
      license.gmail         !== gmail.toLowerCase().trim() ||
      license.password_hash !== password
    ) {
      return res.status(401).json({
        message: 'Authentication failed: wrong Gmail or Password for this license.'
      });
    }

    // 4. Check expiry
    const expiryDate = new Date(license.expiry_date);
    if (now > expiryDate) {
      await supabase.from('licenses').update({ status: 'expired' }).eq('id', license.id);
      return res.status(403).json({
        message: `License expired on ${expiryDate.toDateString()}. Purchase a renewal.`
      });
    }

    // 5. Check / register device slot
    const { data: devices } = await supabase
      .from('active_devices')
      .select('*')
      .eq('license_id', license.id);

    const alreadyRegistered = (devices || []).some(d => d.machine_id === machine_id);

    if (alreadyRegistered) {
      // Update last_seen_at
      await supabase.from('active_devices')
        .update({ last_seen_at: now.toISOString() })
        .eq('license_id', license.id)
        .eq('machine_id', machine_id);
    } else {
      if ((devices || []).length >= license.max_devices) {
        return res.status(403).json({
          message: `Device limit reached (${devices.length}/${license.max_devices}). Contact support to swap devices.`
        });
      }
      await supabase.from('active_devices').insert([{
        license_id:   license.id,
        machine_id,
        platform,
        registered_at: now.toISOString(),
        last_seen_at:  now.toISOString()
      }]);
    }

    // 6. Get remaining credits this month
    const { data: usage } = await supabase
      .from('monthly_usage')
      .select('generations_this_month')
      .eq('license_id', license.id)
      .single();

    const used      = usage?.generations_this_month || 0;
    const remaining = Math.max(license.monthly_gen_limit - used, 0);

    return res.status(200).json({
      status:            'success',
      message:           alreadyRegistered ? 'Re-activated successfully.' : 'New device registered.',
      gmail,
      expiry_date:       license.expiry_date,
      monthly_gen_limit: license.monthly_gen_limit,
      remaining_credits: remaining,
      token:             `OMNI-TOKEN-${license.id}`
    });

  } catch (err) {
    console.error('[activate] exception:', err);
    return res.status(500).json({ message: `Server error: ${err.message}` });
  }
};
