const express = require('express');
const axios = require('axios');
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
