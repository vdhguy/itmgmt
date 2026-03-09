const express = require('express');
const axios = require('axios');
const dns = require('dns').promises;
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

// GET /api/devices/resolve?hostname=xxx — DNS lookup via resolver local (srv-dc1)
router.get('/resolve', async (req, res) => {
    const hostname = (req.query.hostname || '').trim();
    if (!hostname) return res.json({ ips: [] });
    try {
        const ips = await dns.resolve4(hostname);
        res.json({ ips });
    } catch (err) {
        res.json({ ips: [] });
    }
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
