const express = require('express');
const axios = require('axios');
const https = require('https');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const FORTI_HOST = process.env.FORTI_HOST || '10.10.99.1';
const FORTI_API  = `https://${FORTI_HOST}/api/v2`;
const FORTI_KEY  = process.env.FORTI_API_KEY;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Mapping hub index → site name
const HUB_SITES = {
    0: 'Centre sportif de Maransart',
    1: 'Bibliothèque de Lasne',
    2: 'École de musique',
    3: 'Site de la Closière',
    4: 'Ohain — École maternelle',
    5: 'École de Plancenoit',
    6: 'Maransart — École maternelle',
    7: 'Crèche Les Marmouset',
    8: 'Maransart — École primaire',
};

function fortiHeaders() {
    return { Authorization: `Bearer ${FORTI_KEY}` };
}

// Extract hub index from tunnel name (e.g. "hub_0", "Hub-1", "HUB2", "vpn_hub_3")
function hubIndexFromName(name) {
    const m = (name || '').match(/hub[_\-\s]?(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

// GET /api/firewall/vpn
router.get('/vpn', async (req, res) => {
    if (!FORTI_KEY) return res.json({ ssl: [], ipsec: [], hubs: [], error: 'not_configured' });
    try {
        const [sslRes, ipsecRes] = await Promise.allSettled([
            axios.get(`${FORTI_API}/monitor/vpn/ssl`, { headers: fortiHeaders(), httpsAgent }),
            axios.get(`${FORTI_API}/monitor/vpn/ipsec`, { headers: fortiHeaders(), httpsAgent }),
        ]);

        // ── SSL VPN sessions
        const sslRaw = sslRes.status === 'fulfilled'
            ? (sslRes.value.data?.results || [])
            : [];

        const ssl = sslRaw.map(s => ({
            username:      s.user_name || s.username || '—',
            remoteIp:      s.remote_ip  || s.src_ip  || '—',
            tunnelIp:      s.tunnel_ip  || '—',
            connectedSince: s.login_time || s.connection_time || null,
            duration:      s.duration   || null,
            inBytes:       s.incoming   || s.in_bytes  || null,
            outBytes:      s.outgoing   || s.out_bytes || null,
        }));

        // ── IPSec tunnels (all, not just up — hubs need to show as offline too)
        const ipsecRaw = ipsecRes.status === 'fulfilled'
            ? (ipsecRes.value.data?.results || [])
            : [];

        // Build hub cards
        const tunnelByHub = {};
        const otherIpsec  = [];

        for (const t of ipsecRaw) {
            const idx = hubIndexFromName(t.name);
            const proxyids = t.proxyid || [];
            const upCount  = proxyids.filter(p => p.status === 'up').length;
            const isUp     = upCount > 0;

            const entry = {
                name:     t.name || '—',
                remoteIp: t.tun_id || t.rgwy || t.remote_gw || '—',
                incoming: t.incoming || null,
                outgoing: t.outgoing || null,
                up:       isUp,
            };

            if (idx !== null && HUB_SITES[idx] !== undefined) {
                tunnelByHub[idx] = entry;
            } else if (isUp) {
                otherIpsec.push(entry);
            }
        }

        // Build ordered hub array (0-8), mark missing tunnels as unknown
        const hubs = Object.entries(HUB_SITES).map(([i, site]) => {
            const idx = parseInt(i, 10);
            const t   = tunnelByHub[idx];
            return {
                hub:      idx,
                site,
                up:       t ? t.up       : null,   // null = tunnel not found in FortiGate
                remoteIp: t ? t.remoteIp : '—',
                incoming: t ? t.incoming : null,
                outgoing: t ? t.outgoing : null,
                name:     t ? t.name     : null,
            };
        });

        res.json({ ssl, ipsec: otherIpsec, hubs });
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('[Firewall] VPN error:', detail);
        res.status(500).json({ error: 'FortiGate unreachable', detail });
    }
});

module.exports = router;
