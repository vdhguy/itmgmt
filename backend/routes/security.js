const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const { getMdeAccessToken } = require('../middleware/auth');
const mde = require('../config/mde');
const graph = require('../config/graph');

const router = express.Router();
router.use(authMiddleware); // keeps req.accessToken for Graph if needed

// Cache for the full MDE machine list (avoids fetching all machines on every request)
let machineListCache = null;
let machineListCacheTime = 0;
const MACHINE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function findMdeMachine(name, headers) {
    const lower = name.toLowerCase();

    // 1. Try exact computerDnsName match
    const exactRes = await axios.get(mde.MACHINES_BY_NAME(name), { headers });
    if (exactRes.data.value.length) return exactRes.data.value[0];

    // 2. Fallback: full list with client-side prefix match (handles FQDN like pc-001.domain.com)
    const now = Date.now();
    if (!machineListCache || now - machineListCacheTime > MACHINE_CACHE_TTL) {
        const allRes = await axios.get(mde.MACHINES_ALL(), { headers });
        machineListCache = allRes.data.value;
        machineListCacheTime = now;
    }
    return machineListCache.find(m => {
        const dns = (m.computerDnsName || '').toLowerCase();
        return dns === lower || dns.startsWith(lower + '.');
    }) || null;
}

// GET /api/security/laps/:aadDeviceId
router.get('/laps/:aadDeviceId', async (req, res) => {
    try {
        const { data } = await axios.get(graph.LAPS_CREDENTIALS(req.params.aadDeviceId), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data);
    } catch (err) {
        if (err.response?.status === 404) return res.json(null);
        const msg = err.response?.data?.error?.message || err.message;
        console.error('LAPS error:', msg);
        res.status(500).json({ error: msg });
    }
});

// GET /api/security/bitlocker/:aadDeviceId
router.get('/bitlocker/:aadDeviceId', async (req, res) => {
    try {
        const token = req.accessToken;
        const { data: list } = await axios.get(graph.BITLOCKER_KEYS(req.params.aadDeviceId), {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!list.value.length) return res.json([]);
        const keys = await Promise.all(
            list.value.map(k =>
                axios.get(graph.BITLOCKER_KEY(k.id), { headers: { Authorization: `Bearer ${token}` } })
                    .then(r => ({ ...k, key: r.data.key ?? null }))
                    .catch(() => ({ ...k, key: null }))
            )
        );
        res.json(keys);
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error('BitLocker error:', msg);
        res.status(500).json({ error: msg });
    }
});

// GET /api/security/:deviceName/criticalVulns
// Returns count of critical Microsoft vulnerabilities for a device (by Intune device name)
router.get('/:deviceName/criticalVulns', async (req, res) => {
    try {
        const mdeToken = await getMdeAccessToken();
        const headers = { Authorization: `Bearer ${mdeToken}` };
        const name = req.params.deviceName;

        // 1. Find machine in MDE by computer name
        const machine = await findMdeMachine(name, headers);
        if (!machine) {
            return res.json({ count: null }); // device not onboarded in MDE
        }

        const mdeId = machine.id;

        // 2. Parallel: machine vulnerabilities + Microsoft software on this machine
        const [vulnsRes, softwareRes] = await Promise.all([
            axios.get(mde.MACHINE_VULNS(mdeId), { headers }),
            axios.get(mde.MACHINE_SOFTWARE(mdeId), { headers }),
        ]);

        // Critical CVE IDs affecting this machine
        const criticalCveIds = new Set(
            vulnsRes.data.value
                .filter(v => v.severity === 'Critical')
                .map(v => v.id)
        );
        if (!criticalCveIds.size) return res.json({ count: 0 });

        // Microsoft software installed on this machine
        const msSoftwareIds = softwareRes.data.value
            .filter(s => (s.vendor || '').toLowerCase() === 'microsoft')
            .map(s => s.id);
        if (!msSoftwareIds.length) return res.json({ count: 0 });

        // 3. Fetch CVE list for each Microsoft software package (parallel)
        const swVulnLists = await Promise.all(
            msSoftwareIds.map(swId =>
                axios.get(mde.SOFTWARE_VULNS(swId), { headers })
                    .then(r => r.data.value.map(v => v.id))
                    .catch(() => [])
            )
        );

        // Union of CVE IDs from all Microsoft software
        const msCveIds = new Set(swVulnLists.flat());

        // Intersection: critical on this machine AND from Microsoft software
        const count = [...criticalCveIds].filter(id => msCveIds.has(id)).length;

        res.json({ count });
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('Error fetching vulns:', detail);
        res.status(500).json({ error: 'Failed to fetch vulnerabilities', detail });
    }
});

module.exports = router;
