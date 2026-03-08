const express = require('express');
const axios = require('axios');
const https = require('https');
const { authMiddleware } = require('../middleware/auth');
const graph = require('../config/graph');

// GLPI uses a self-signed/internal cert — skip TLS verification for internal calls only
const glpiAgent = new https.Agent({ rejectUnauthorized: false });

const router = express.Router();
router.use(authMiddleware);

// ── GLPI session cache (reused across requests, re-init on expiry/error)
let glpiSession = null;
let glpiSessionTime = 0;
const GLPI_SESSION_TTL = 20 * 60 * 1000; // 20 min

async function getGlpiSession() {
    const glpiUrl   = process.env.GLPI_URL;
    const appToken  = process.env.GLPI_APP_TOKEN;
    const userToken = process.env.GLPI_USER_TOKEN;
    console.log('[GLPI] GLPI_URL =', glpiUrl || '(not set)');
    if (!glpiUrl || !appToken || !userToken) return null;

    if (glpiSession && Date.now() - glpiSessionTime < GLPI_SESSION_TTL) return glpiSession;

    const initUrl = `${glpiUrl}/initSession`;
    console.log('[GLPI] Calling initSession:', initUrl);
    const r = await axios.get(initUrl, {
        headers: { 'App-Token': appToken, 'Authorization': `user_token ${userToken}` },
        httpsAgent: glpiAgent
    });
    glpiSession = { url: glpiUrl, headers: { 'App-Token': appToken, 'Session-Token': r.data.session_token } };
    glpiSessionTime = Date.now();
    return glpiSession;
}

// GET /api/users/:id/glpi-tickets?email=xxx
// Returns count of open GLPI tickets for a user (matched by email)
router.get('/:id/glpi-tickets', async (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.json({ count: null });

    try {
        const sess = await getGlpiSession();
        if (!sess) return res.json({ count: null, reason: 'not_configured' });

        // 1. Find GLPI user ID by email (field 5 = email in GLPI User)
        const userSearch = await axios.get(
            `${sess.url}/search/User?criteria[0][field]=5&criteria[0][searchtype]=equals&criteria[0][value]=${encodeURIComponent(email)}&forcedisplay[0]=2`,
            { headers: sess.headers, httpsAgent: glpiAgent }
        );
        const userData = userSearch.data?.data;
        console.log('[GLPI] user search for', email, '→', JSON.stringify(userSearch.data));
        if (!userData || !userData.length) return res.json({ count: 0 });

        const glpiUserId = userData[0]['2']; // field 2 = ID
        console.log('[GLPI] glpiUserId =', glpiUserId);

        // 2. Count open tickets (status < 5: New/Processing/Planned/Pending) for this requester
        const ticketSearch = await axios.get(
            `${sess.url}/search/Ticket` +
            `?criteria[0][field]=4&criteria[0][searchtype]=equals&criteria[0][value]=${glpiUserId}` +
            `&criteria[1][link]=AND&criteria[1][field]=12&criteria[1][searchtype]=lessthan&criteria[1][value]=5`,
            { headers: sess.headers, httpsAgent: glpiAgent }
        );
        console.log('[GLPI] ticket search totalcount =', ticketSearch.data?.totalcount, 'data =', JSON.stringify(ticketSearch.data).slice(0, 300));
        const count = ticketSearch.data?.totalcount ?? 0;
        res.json({ count });

    } catch (err) {
        // Invalidate cached session on error so next call re-authenticates
        glpiSession = null;
        console.error('[GLPI] Error:', err.message);
        console.error('[GLPI] Code:', err.code);
        console.error('[GLPI] Response data:', JSON.stringify(err.response?.data));
        console.error('[GLPI] Request URL:', err.config?.url);
        res.json({ count: null, error: 'GLPI unavailable' });
    }
});

// GET /api/users/search?q=xxx
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    try {
        const { data } = await axios.get(graph.USERS_SEARCH(q), {
            headers: {
                Authorization: `Bearer ${req.accessToken}`,
                ConsistencyLevel: 'eventual'
            }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Error searching users:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to search users' });
    }
});

// GET /api/users/:id/signin
router.get('/:id/signin', async (req, res) => {
    try {
        const { data } = await axios.get(graph.USER_SIGNIN(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.signInActivity || null);
    } catch (err) {
        console.error('Error fetching signInActivity:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch sign-in activity' });
    }
});

// GET /api/users/:id/signins?days=7
router.get('/:id/signins', async (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 7, 30);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data } = await axios.get(graph.USER_SIGNINS(req.params.id, since), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Error fetching sign-ins:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch sign-ins' });
    }
});

// GET /api/users/:id/devices
router.get('/:id/devices', async (req, res) => {
    try {
        const { data } = await axios.get(graph.USER_DEVICES(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Error fetching user devices:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch user devices' });
    }
});

module.exports = router;
