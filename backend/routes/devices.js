const express = require('express');
const axios = require('axios');
const dns = require('dns');
const { authMiddleware } = require('../middleware/auth');
const graph = require('../config/graph');

const router = express.Router();
router.use(authMiddleware);

// GET /api/devices
router.get('/', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICES, {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Error fetching devices:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch devices' });
    }
});

// GET /api/devices/:id/logons — usersLoggedOn via beta API
router.get('/:id/logons', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICE_LOGONS(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.usersLoggedOn || []);
    } catch (err) {
        console.error('Error fetching device logons:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch device logons' });
    }
});

// GET /api/devices/:id/protection — Windows Defender state via Intune beta API
router.get('/:id/protection', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICE_PROTECTION(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data);
    } catch (err) {
        console.error('Error fetching protection state:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch protection state' });
    }
});

// GET /api/devices/resolve?hostname=xxx — DNS lookup via resolver OS (respecte le suffixe .lasne.local)
router.get('/resolve', (req, res) => {
    const hostname = (req.query.hostname || '').trim();
    if (!hostname) return res.json({ ips: [] });
    dns.lookup(hostname, { all: true, family: 4 }, (err, addresses) => {
        if (err || !addresses) return res.json({ ips: [] });
        res.json({ ips: addresses.map(a => a.address) });
    });
});

// GET /api/devices/:id/network — networkInterfaces (IP) via beta API
router.get('/:id/network', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICE_NETWORK(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.networkInterfaces || []);
    } catch (err) {
        console.error('Error fetching device network:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch network info' });
    }
});

// GET /api/devices/:id/user
router.get('/:id/user', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICE_USERS(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Error fetching device user:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch device user' });
    }
});

module.exports = router;
