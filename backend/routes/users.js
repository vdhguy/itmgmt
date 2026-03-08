const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const graph = require('../config/graph');

const router = express.Router();
router.use(authMiddleware);

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
