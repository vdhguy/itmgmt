const express = require('express');
const dns     = require('dns');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const https   = require('https');
const { exec } = require('child_process');
const { authMiddleware } = require('../middleware/auth');

let snmp;
try { snmp = require('net-snmp'); } catch (e) {
    console.warn('[Network] net-snmp not installed. Run: npm install net-snmp');
}

const router = express.Router();
router.use(authMiddleware);

const COMMUNITY  = process.env.SNMP_COMMUNITY  || 'public';
const DNS_SERVER = process.env.SNMP_DNS         || '10.10.30.31';
const ROOT_SW    = process.env.NET_ROOT_SWITCH  || 'sw-oha-03';
const FORTI_HOST = process.env.FORTI_HOST       || '10.10.99.1';
const FORTI_KEY  = process.env.FORTI_API_KEY;
const FORTI_API  = `https://${FORTI_HOST}/api/v2`;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ── Topology cache ────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(__dirname, '..', 'data', 'network-topology.json');
let topoCache    = null;   // { nodes, edges }
let topoCachedAt = null;   // Date

;(function loadCacheFromDisk() {
    try {
        const raw  = fs.readFileSync(CACHE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data?.topology) {
            topoCache    = data.topology;
            topoCachedAt = new Date(data.cachedAt);
            console.log('[Network] Topology cache loaded:', topoCachedAt.toISOString());
        }
    } catch (_) { /* no cache file yet */ }
})();

function saveCacheToDisk(topology) {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ topology, cachedAt: new Date().toISOString() }));
    } catch (e) {
        console.error('[Network] Cache save error:', e.message);
    }
}

// ── Custom DNS resolver ───────────────────────────────────────────────────────
const resolver = new dns.Resolver();
resolver.setServers([DNS_SERVER]);

function resolveHost(hostname) {
    return new Promise((resolve, reject) => {
        resolver.resolve4(hostname, (err, a) => {
            if (!err) return resolve(a[0]);
            resolver.resolve4(`${hostname}.lasne.local`, (err2, a2) => {
                if (!err2) return resolve(a2[0]);
                reject(new Error(`DNS: ${hostname} — ${err2.message}`));
            });
        });
    });
}

// ── SNMP walk helpers ─────────────────────────────────────────────────────────
// snmpWalk   : converts Buffer values to strings (good for text OIDs)
// snmpWalkRaw: preserves raw Buffer values (required for binary OIDs like MAC addresses)
function _snmpWalkBase(ip, oid, valueMapper) {
    return new Promise((resolve, reject) => {
        const session = snmp.createSession(ip, COMMUNITY, {
            version: snmp.Version2c,
            timeout: 5000,
            retries: 1,
        });
        const results = {};
        session.subtree(oid, 20,
            (varbinds) => {
                for (const vb of varbinds) {
                    if (snmp.isVarbindError(vb)) continue;
                    results[vb.oid] = valueMapper(vb.value);
                }
            },
            (err) => {
                session.close();
                if (err && err.toString().includes('Timeout')) return resolve(results);
                if (err) return reject(err);
                resolve(results);
            }
        );
    });
}

function snmpWalk(ip, oid) {
    return _snmpWalkBase(ip, oid, v =>
        Buffer.isBuffer(v) ? v.toString().replace(/\0/g, '').trim() : v
    );
}

function snmpWalkRaw(ip, oid) {
    return _snmpWalkBase(ip, oid, v => v); // keep Buffer as-is
}

// ── OID constants ─────────────────────────────────────────────────────────────
const OID_LLDP_SYSNAME  = '1.0.8802.1.1.2.1.4.1.1.9';
const OID_LLDP_PORTDESC = '1.0.8802.1.1.2.1.4.1.1.8';
const OID_LLDP_PORTID   = '1.0.8802.1.1.2.1.4.1.1.7';
const OID_IFDESCR       = '1.3.6.1.2.1.2.2.1.2';
const OID_IFADMIN       = '1.3.6.1.2.1.2.2.1.7';
const OID_IFOPER        = '1.3.6.1.2.1.2.2.1.8';
const OID_IFHISPEED     = '1.3.6.1.2.1.31.1.1.1.15';
const OID_IFALIAS       = '1.3.6.1.2.1.31.1.1.1.18';
const OID_IFINOCTETS    = '1.3.6.1.2.1.2.2.1.10';
const OID_IFOUTOCTETS   = '1.3.6.1.2.1.2.2.1.16';
// MAC address table (dot1dTpFdbTable)
const OID_FDB_PORT      = '1.3.6.1.2.1.17.4.3.1.2'; // MAC → bridge port
const OID_BP_IFINDEX    = '1.3.6.1.2.1.17.1.4.1.2';  // bridge port → ifIndex

// ── LLDP neighbor discovery ───────────────────────────────────────────────────
function parseLldpSuffix(oid, base) {
    const suffix = oid.replace(base + '.', '');
    const parts  = suffix.split('.');
    if (parts.length < 3) return null;
    return { localPort: parseInt(parts[1]), remoteIndex: parseInt(parts[2]) };
}

async function getLldpNeighbors(ip) {
    const [sys, pdesc, pid, ifdescr] = await Promise.allSettled([
        snmpWalk(ip, OID_LLDP_SYSNAME),
        snmpWalk(ip, OID_LLDP_PORTDESC),
        snmpWalk(ip, OID_LLDP_PORTID),
        snmpWalk(ip, OID_IFDESCR),
    ]);

    const localPortNames = {};
    if (ifdescr.status === 'fulfilled') {
        for (const [oid, val] of Object.entries(ifdescr.value)) {
            localPortNames[oid.replace(OID_IFDESCR + '.', '')] = String(val).trim();
        }
    }

    const map = {};
    const merge = (result, base, field) => {
        if (result.status !== 'fulfilled') return;
        for (const [oid, val] of Object.entries(result.value)) {
            const k = parseLldpSuffix(oid, base);
            if (!k) continue;
            const key = `${k.localPort}.${k.remoteIndex}`;
            map[key] = map[key] || { localPort: k.localPort, remoteIndex: k.remoteIndex };
            map[key][field] = String(val).trim();
        }
    };

    merge(sys,   OID_LLDP_SYSNAME,  'sysName');
    merge(pdesc, OID_LLDP_PORTDESC, 'portDesc');
    merge(pid,   OID_LLDP_PORTID,   'portId');

    for (const nb of Object.values(map)) {
        nb.localPortName = localPortNames[String(nb.localPort)] || `Port ${nb.localPort}`;
    }

    return Object.values(map).filter(n => n.sysName || n.portId);
}

// ── Interface / port data ─────────────────────────────────────────────────────
async function getSwitchPorts(ip) {
    const [descr, admin, oper, hispeed, alias, inOct, outOct] = await Promise.allSettled([
        snmpWalk(ip, OID_IFDESCR),
        snmpWalk(ip, OID_IFADMIN),
        snmpWalk(ip, OID_IFOPER),
        snmpWalk(ip, OID_IFHISPEED),
        snmpWalk(ip, OID_IFALIAS),
        snmpWalk(ip, OID_IFINOCTETS),
        snmpWalk(ip, OID_IFOUTOCTETS),
    ]);

    const get = (r) => r.status === 'fulfilled' ? r.value : {};
    const D = get(descr), A = get(admin), O = get(oper),
          S = get(hispeed), AL = get(alias), IN = get(inOct), OUT = get(outOct);

    return Object.entries(D).map(([oid, name]) => {
        const idx = oid.replace(OID_IFDESCR + '.', '');
        return {
            index:       parseInt(idx),
            name:        String(name),
            adminStatus: A[`${OID_IFADMIN}.${idx}`]       == 1 ? 'up' : 'down',
            operStatus:  O[`${OID_IFOPER}.${idx}`]        == 1 ? 'up' : 'down',
            speed:       Number(S[`${OID_IFHISPEED}.${idx}`]    || 0),
            alias:       String(AL[`${OID_IFALIAS}.${idx}`]     || ''),
            inOctets:    Number(IN[`${OID_IFINOCTETS}.${idx}`]  || 0),
            outOctets:   Number(OUT[`${OID_IFOUTOCTETS}.${idx}`]|| 0),
        };
    }).sort((a, b) => a.index - b.index);
}

// ── Topology discovery ────────────────────────────────────────────────────────
function isSwitch(name) {
    return /^sw[-_.]/i.test(name) || /^switch/i.test(name) || /-sw-/i.test(name);
}

async function discoverTopology() {
    const nodes = new Map();
    const edges = [];
    const visited = new Set();
    const queue   = [ROOT_SW];

    nodes.set('fortigate', { id: 'fortigate', type: 'firewall', label: 'FortiGate', ip: FORTI_HOST, reachable: true });
    edges.push({ source: 'fortigate', target: ROOT_SW.toLowerCase(), localPortName: null, remotePortName: null });

    while (queue.length > 0) {
        const hostname = queue.shift();
        const id = hostname.toLowerCase();
        if (visited.has(id)) continue;
        visited.add(id);

        let ip = null;
        try { ip = await resolveHost(hostname); } catch (e) {
            console.warn(`[Network] DNS failed: ${hostname}`);
        }
        nodes.set(id, { id, type: 'switch', label: hostname, ip, reachable: ip !== null });
        if (!ip) continue;

        try {
            const neighbors = await getLldpNeighbors(ip);
            for (const nb of neighbors) {
                const name = (nb.sysName || '').trim();
                if (!name || !isSwitch(name)) continue;
                const nbId = name.toLowerCase();
                const dupEdge = edges.some(e =>
                    (e.source === id && e.target === nbId) ||
                    (e.source === nbId && e.target === id)
                );
                if (!dupEdge) {
                    edges.push({
                        source:         id,
                        target:         nbId,
                        localPortName:  nb.localPortName || `Port ${nb.localPort}`,
                        remotePortName: nb.portDesc || nb.portId || '',
                    });
                }
                if (!visited.has(nbId)) {
                    queue.push(name);
                    if (!nodes.has(nbId)) nodes.set(nbId, { id: nbId, type: 'switch', label: name, ip: null, reachable: null });
                }
            }
        } catch (e) {
            console.error(`[Network] LLDP error on ${hostname} (${ip}):`, e.message);
            nodes.get(id).snmpError = e.message;
        }
    }

    return { nodes: [...nodes.values()], edges };
}

// ── Device locator ────────────────────────────────────────────────────────────
function normalizeMac(raw) {
    if (!raw) return null;
    const clean = raw.trim().toLowerCase();
    // Split on separator — handles variable-length octets like "0:c:29:1a:2b:3c"
    const parts = clean.split(/[:\-.]/).filter(Boolean);
    if (parts.length === 6) {
        return parts.map(p => p.padStart(2, '0')).join(':');
    }
    // Bare hex without separators
    const bare = clean.replace(/[:\-. ]/g, '');
    if (bare.length === 12) return bare.match(/.{2}/g).join(':');
    return null;
}

function macToOidSuffix(mac) {
    return mac.split(':').map(h => parseInt(h, 16)).join('.');
}

// ── FortiGate ARP via SNMP (ipNetToMediaPhysAddress) ─────────────────────────
// OID 1.3.6.1.2.1.4.22.1.2.<ifIndex>.<a>.<b>.<c>.<d> = MAC bytes
// This works on any SNMP-enabled device regardless of REST API version.
const OID_ARP = '1.3.6.1.2.1.4.22.1.2';

async function getFortiArpSnmp() {
    // Use raw walk to preserve Buffer bytes — regular walk corrupts binary MAC data via UTF-8 coercion
    const raw = await snmpWalkRaw(FORTI_HOST, OID_ARP);
    const table = {};
    for (const [oid, val] of Object.entries(raw)) {
        // OID suffix: <ifIndex>.<a>.<b>.<c>.<d>
        const suffix = oid.replace(OID_ARP + '.', '');
        const parts  = suffix.split('.');
        if (parts.length < 5) continue;
        const ip = parts.slice(-4).join('.');
        if (!Buffer.isBuffer(val) || val.length !== 6) continue;
        if (val.every(b => b === 0)) continue; // skip incomplete/static entries
        const mac = [...val].map(b => b.toString(16).padStart(2, '0')).join(':');
        table[ip] = mac;
    }
    return table; // { '10.10.15.5': 'd4:f3:2d:7e:e6:3b', ... }
}

// Ping an IP to force ARP resolution — fire-and-forget, never throws
function pingIp(ip) {
    return new Promise(resolve => {
        // Windows: ping -n 1 -w 1000 | Linux: ping -c 1 -W 1
        const cmd = process.platform === 'win32'
            ? `ping -n 1 -w 1000 ${ip}`
            : `ping -c 1 -W 1 ${ip}`;
        exec(cmd, { timeout: 3000 }, () => resolve());
    });
}

// Returns { mac, arpError } — never throws
async function getMacFromFortiArp(ip) {
    if (!snmp) return { mac: null, arpError: 'net-snmp non installé' };
    try {
        // Ping first to ensure ARP table is populated for this IP
        await pingIp(ip);
        const table = await getFortiArpSnmp();
        const count = Object.keys(table).length;
        console.log(`[Network] FortiGate SNMP ARP: ${count} entries`);
        const mac = table[ip] || null;
        if (!mac) {
            return { mac: null, arpError: `${ip} introuvable dans la table ARP FortiGate (${count} entrée(s) SNMP)` };
        }
        return { mac, arpError: null };
    } catch (e) {
        console.error('[Network] FortiGate SNMP ARP error:', e.message);
        return { mac: null, arpError: `FortiGate SNMP ARP : ${e.message}` };
    }
}

async function searchMacInFdb(mac, switches) {
    const macSuffix = macToOidSuffix(mac);
    const targetOid = `${OID_FDB_PORT}.${macSuffix}`;
    const results   = [];

    await Promise.all(switches.map(async sw => {
        if (!sw.ip) return;
        try {
            const [fdbR, bpR, descrR, operR, aliasR] = await Promise.allSettled([
                snmpWalk(sw.ip, OID_FDB_PORT),
                snmpWalk(sw.ip, OID_BP_IFINDEX),
                snmpWalk(sw.ip, OID_IFDESCR),
                snmpWalk(sw.ip, OID_IFOPER),
                snmpWalk(sw.ip, OID_IFALIAS),
            ]);

            const fdb   = fdbR.status   === 'fulfilled' ? fdbR.value   : {};
            const bpMap = bpR.status    === 'fulfilled' ? bpR.value    : {};
            const descr = descrR.status === 'fulfilled' ? descrR.value : {};
            const oper  = operR.status  === 'fulfilled' ? operR.value  : {};
            const alias = aliasR.status === 'fulfilled' ? aliasR.value : {};

            const bridgePort = fdb[targetOid];
            if (bridgePort === undefined) return;

            const ifIdx      = bpMap[`${OID_BP_IFINDEX}.${bridgePort}`];
            const portName   = ifIdx ? (descr[`${OID_IFDESCR}.${ifIdx}`] || `ifIndex ${ifIdx}`) : `BridgePort ${bridgePort}`;
            const portAlias  = ifIdx ? (alias[`${OID_IFALIAS}.${ifIdx}`] || '') : '';
            const operStatus = ifIdx ? (oper[`${OID_IFOPER}.${ifIdx}`] == 1 ? 'up' : 'down') : 'unknown';

            // Skip trunk/uplink ports: those whose alias matches a switch name pattern
            // (the MAC is learned on inter-switch links — not the actual device port)
            const aliasIsSwitch = /^sw[-_. ]/i.test(portAlias) || /^switch/i.test(portAlias)
                || /[-_]sw[-_]/i.test(portAlias) || /uplink/i.test(portAlias);
            if (aliasIsSwitch) return;

            results.push({ switch: sw.label, switchIp: sw.ip, port: portName, portAlias, operStatus });
        } catch (_) { /* unreachable switch */ }
    }));

    return results;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/network/topology — returns cache immediately; runs discovery if no cache
router.get('/topology', async (req, res) => {
    if (!snmp) return res.status(503).json({ error: 'net-snmp not installed — run: npm install net-snmp' });
    if (topoCache) {
        return res.json({ ...topoCache, cachedAt: topoCachedAt?.toISOString(), fromCache: true });
    }
    // No cache — run first discovery
    try {
        topoCache    = await discoverTopology();
        topoCachedAt = new Date();
        saveCacheToDisk(topoCache);
        res.json({ ...topoCache, cachedAt: topoCachedAt.toISOString(), fromCache: false });
    } catch (err) {
        console.error('[Network] Topology error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/network/topology/refresh — forces full rediscovery
router.post('/topology/refresh', async (req, res) => {
    if (!snmp) return res.status(503).json({ error: 'net-snmp not installed' });
    try {
        topoCache    = await discoverTopology();
        topoCachedAt = new Date();
        saveCacheToDisk(topoCache);
        res.json({ ...topoCache, cachedAt: topoCachedAt.toISOString(), fromCache: false });
    } catch (err) {
        console.error('[Network] Refresh error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/network/switch/:hostname/ports
router.get('/switch/:hostname/ports', async (req, res) => {
    if (!snmp) return res.status(503).json({ error: 'net-snmp not installed' });
    const { hostname } = req.params;
    try {
        const ip    = await resolveHost(hostname);
        const ports = await getSwitchPorts(ip);
        res.json({ hostname, ip, ports });
    } catch (err) {
        console.error(`[Network] Ports error for ${hostname}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/network/arp-debug — returns raw FortiGate ARP table via SNMP (diagnosis)
router.get('/arp-debug', async (req, res) => {
    if (!snmp) return res.status(503).json({ error: 'net-snmp non installé' });
    try {
        const table = await getFortiArpSnmp();
        const entries = Object.entries(table).map(([ip, mac]) => ({ ip, mac }));
        res.json({ count: entries.length, sample: entries.slice(0, 10) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/network/locate?q=<ip|hostname|mac>
router.get('/locate', async (req, res) => {
    if (!snmp) return res.status(503).json({ error: 'net-snmp not installed' });
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    try {
        let mac = null;
        let ip  = null;

        const isMac = /^([0-9a-f]{2}[:\-.]){5}[0-9a-f]{2}$/i.test(q);
        const isIp  = /^\d{1,3}(\.\d{1,3}){3}$/.test(q);

        if (isMac) {
            mac = normalizeMac(q);
            if (!mac) return res.status(400).json({ error: `Format MAC invalide : ${q}` });
        } else if (isIp) {
            ip = q;
            const { mac: m, arpError } = await getMacFromFortiArp(ip);
            mac = m;
            if (!mac) return res.json({ q, ip, mac: null, found: false, message: arpError });
        } else {
            // Hostname → DNS → ARP
            try { ip = await resolveHost(q); } catch (e) {
                return res.status(404).json({ error: `Hôte introuvable : ${q}` });
            }
            const { mac: m, arpError } = await getMacFromFortiArp(ip);
            mac = m;
            if (!mac) return res.json({ q, ip, mac: null, found: false, message: arpError });
        }

        const switches = (topoCache?.nodes || []).filter(n => n.type === 'switch' && n.ip);
        if (!switches.length) {
            return res.json({ q, ip, mac, found: false,
                message: 'Aucune donnée de topologie — chargez ou actualisez la topologie d\'abord' });
        }

        const results = await searchMacInFdb(mac, switches);
        res.json({ q, ip, mac, found: results.length > 0, results });
    } catch (err) {
        console.error('[Network] Locate error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
