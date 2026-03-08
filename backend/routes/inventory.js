const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const graph = require('../config/graph');

const router = express.Router();
router.use(authMiddleware);

const INVENTORY_FIELDS = [
    'id', 'deviceName', 'operatingSystem', 'osVersion',
    'manufacturer', 'model',
    'totalStorageSpaceInBytes', 'freeStorageSpaceInBytes',
    'physicalMemoryInBytes', 'enrolledDateTime', 'lastSyncDateTime'
].join(',');

// GET /api/inventory/:id — hardware fields for a single device
router.get('/:id', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICE_BY_ID(req.params.id), {
            headers: { Authorization: `Bearer ${req.accessToken}` },
            params: { $select: INVENTORY_FIELDS }
        });
        res.json(data);
    } catch (err) {
        console.error('Error fetching device inventory:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch device inventory' });
    }
});

// GET /api/inventory
router.get('/', async (req, res) => {
    try {
        const { data } = await axios.get(graph.DEVICES, {
            headers: { Authorization: `Bearer ${req.accessToken}` },
            params: { $select: INVENTORY_FIELDS }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Error fetching inventory:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});

module.exports = router;
