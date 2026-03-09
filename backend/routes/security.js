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
// Returns all CVEs (Critical + High) for a device via MDE machine vulnerabilities endpoint
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

        // 2. Get the CVEs that actually affect this machine (machine-specific)
        const [vulnRes, swRes] = await Promise.all([
            axios.get(mde.MACHINE_VULNS(machine.id), { headers }),
            axios.get(mde.MACHINE_SOFTWARE(machine.id), { headers }),
        ]);

        const allMachineVulns = vulnRes.data.value || [];

        // CVE IDs with known exploits on this machine (Critical or High)
        const exploitableIds = new Set(
            allMachineVulns.filter(v =>
                (v.severity === 'Critical' || v.severity === 'High') &&
                (v.publicExploit || v.exploitVerified)
            ).map(v => v.id)
        );

        // Critical CVE IDs present on this machine
        const machineCriticalIds = new Set(
            allMachineVulns.filter(v => v.severity === 'Critical').map(v => v.id)
        );

        // All software with known weaknesses (any vendor)
        const allSoftware = (swRes.data.value || []).filter(s => (s.weaknesses || 0) > 0);

        // Fetch CVEs per software in parallel
        const swVulnResults = await Promise.all(
            allSoftware.map(sw =>
                axios.get(mde.SOFTWARE_VULNS(sw.id), { headers })
                    .then(r => ({ sw, vulns: r.data.value || [] }))
                    .catch(() => ({ sw, vulns: [] }))
            )
        );

        // Microsoft Critical CVEs (machine-specific)
        const seenCrit = new Set();
        const criticalVulns = [];
        // Exploit breakdown by software
        const seenExploit = new Set();
        const exploitBySoftware = [];

        for (const { sw, vulns } of swVulnResults) {
            const isMicrosoft = (sw.vendor || '').toLowerCase().includes('microsoft');
            const swExploitIds = [];

            for (const v of vulns) {
                if (isMicrosoft && v.severity === 'Critical' && machineCriticalIds.has(v.id) && !seenCrit.has(v.id)) {
                    seenCrit.add(v.id);
                    criticalVulns.push({ id: v.id, cvssV3: v.cvssV3 ?? null });
                }
                if (exploitableIds.has(v.id) && !seenExploit.has(v.id)) {
                    seenExploit.add(v.id);
                    swExploitIds.push(v.id);
                }
            }
            if (swExploitIds.length > 0) {
                exploitBySoftware.push({ name: sw.name || sw.id, count: swExploitIds.length });
            }
        }

        criticalVulns.sort((a, b) => (b.cvssV3 ?? 0) - (a.cvssV3 ?? 0));
        exploitBySoftware.sort((a, b) => b.count - a.count);

        res.json({
            count: criticalVulns.length,
            vulns: criticalVulns.slice(0, 20),
            exploitCount: exploitableIds.size,
            exploitBySoftware,
        });
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('Error fetching vulns:', detail);
        res.status(500).json({ error: 'Failed to fetch vulnerabilities', detail });
    }
});

module.exports = router;
