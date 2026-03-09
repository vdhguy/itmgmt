const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const TV_API = 'https://webapi.teamviewer.com/api/v1';

// Cache des devices TV (5 min) pour éviter trop d'appels
let tvCache = null;
let tvCacheTime = 0;
const TV_CACHE_TTL = 5 * 60 * 1000;

// Normalise un device (managed ou contact) vers un format commun
function normalizeDevice(d, source) {
    if (source === 'managed') {
        return {
            alias: d.name || '',
            remotecontrol_id: d.teamviewerId ? String(d.teamviewerId) : '',
            online_state: d.isOnline ? 'Online' : 'Offline',
        };
    }
    // source === 'contacts'
    return {
        alias: d.alias || '',
        remotecontrol_id: d.remotecontrol_id || '',
        online_state: d.online_state || '',
    };
}

async function getTvDevices() {
    const token = process.env.TEAMVIEWER_API_TOKEN;
    if (!token) return null;
    if (tvCache && tvCache.length > 0 && Date.now() - tvCacheTime < TV_CACHE_TTL) return tvCache;

    const headers = { Authorization: `Bearer ${token}` };
    let all = [];

    // 1. Essai Remote Management (appareils gérés — "All managed devices")
    try {
        const managedRes = await axios.get(`${TV_API}/managed/devices`, { headers });
        const managed = managedRes.data.resources || [];
        if (Array.isArray(managed) && managed.length > 0) {
            all = managed.map(d => normalizeDevice(d, 'managed'));
            tvCache = all;
            tvCacheTime = Date.now();
            return tvCache;
        }
    } catch (err) {
        // Pas la permission Remote Management → on tente l'API contacts/groups
    }

    // 2. Fallback : API contacts/groupes
    const groupId = process.env.TEAMVIEWER_GROUP_ID;
    if (groupId) {
        const devRes = await axios.get(`${TV_API}/devices?groupid=${groupId}`, { headers });
        all = (devRes.data.devices || []).map(d => normalizeDevice(d, 'contacts'));
    } else {
        const groupsRes = await axios.get(`${TV_API}/groups`, { headers });
        const groups = groupsRes.data.groups || [];
        for (const g of groups) {
            const devRes = await axios.get(`${TV_API}/devices?groupid=${g.id}`, { headers });
            all.push(...(devRes.data.devices || []).map(d => normalizeDevice(d, 'contacts')));
        }
    }

    tvCache = all;
    tvCacheTime = Date.now();
    return tvCache;
}

// GET /api/teamviewer/device?name=HOSTNAME
router.get('/device', async (req, res) => {
    const name = (req.query.name || '').trim().toLowerCase();
    if (!name) return res.json({ found: false });

    const token = process.env.TEAMVIEWER_API_TOKEN;
    if (!token) return res.json({ found: false, reason: 'not_configured' });

    try {
        const devices = await getTvDevices();
        if (!devices) return res.json({ found: false });

        const match = devices.find(d => {
            const alias = (d.alias || '').toLowerCase();
            return alias === name ||
                alias.startsWith(name + '.') ||
                alias.startsWith(name + ' ') ||
                alias.startsWith(name + '(');
        });

        if (!match) return res.json({ found: false });

        res.json({
            found: true,
            remotecontrol_id: match.remotecontrol_id,
            online_state: match.online_state,
        });
    } catch (err) {
        console.error('[TV] Error:', err.response?.data || err.message);
        res.json({ found: false, reason: 'error' });
    }
});

// GET /api/teamviewer/debug — raw API response (à supprimer après diagnostic)
router.get('/debug', async (req, res) => {
    const token = process.env.TEAMVIEWER_API_TOKEN;
    if (!token) return res.json({ error: 'no token' });
    const headers = { Authorization: `Bearer ${token}` };
    try {
        const r = await axios.get(`${TV_API}/managed/devices`, { headers });
        return res.json({ endpoint: 'managed/devices', status: r.status, data: r.data });
    } catch (err) {
        return res.json({ endpoint: 'managed/devices', error: err.response?.data || err.message });
    }
});

module.exports = router;
