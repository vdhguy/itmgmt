const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const graph = require('../config/graph');

const router = express.Router();
router.use(authMiddleware);

const GROUP_NAME = process.env.AUTOPATCH_GROUP_NAME || 'Lasne Latop Update - Test';
let groupIdCache = null;

async function getGroupId(token) {
    if (groupIdCache) return groupIdCache;
    const { data } = await axios.get(graph.GROUP_BY_NAME(GROUP_NAME), {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
    });
    if (!data.value.length) throw new Error(`Groupe "${GROUP_NAME}" introuvable`);
    groupIdCache = data.value[0].id;
    return groupIdCache;
}

// GET /api/autopatch/members
router.get('/members', async (req, res) => {
    try {
        const groupId = await getGroupId(req.accessToken);
        const { data } = await axios.get(graph.GROUP_MEMBERS_DEV(groupId), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Autopatch members error:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopatch/members — { azureADDeviceId }
router.post('/members', async (req, res) => {
    try {
        const { azureADDeviceId } = req.body;
        if (!azureADDeviceId) return res.status(400).json({ error: 'azureADDeviceId requis' });
        const token = req.accessToken;
        const groupId = await getGroupId(token);

        // Resolve azureADDeviceId (Intune) → AAD device object ID
        const devRes = await axios.get(graph.AAD_DEVICE_BY_ID(azureADDeviceId), {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!devRes.data.value.length) return res.status(404).json({ error: 'Appareil non trouvé dans Azure AD' });
        const aadObjectId = devRes.data.value[0].id;

        await axios.post(
            graph.GROUP_MEMBER_ADD(groupId),
            { '@odata.id': graph.DIRECTORY_OBJ(aadObjectId) },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        res.json({ ok: true, aadObjectId });
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error('Autopatch add error:', msg);
        if (err.response?.status === 400 && msg.toLowerCase().includes('already exist')) {
            return res.status(409).json({ error: 'Appareil déjà dans le groupe' });
        }
        res.status(500).json({ error: msg });
    }
});

// DELETE /api/autopatch/members/:aadObjectId
router.delete('/members/:aadObjectId', async (req, res) => {
    try {
        const token = req.accessToken;
        const groupId = await getGroupId(token);
        await axios.delete(graph.GROUP_MEMBER_DEL(groupId, req.params.aadObjectId), {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json({ ok: true });
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error('Autopatch remove error:', msg);
        res.status(500).json({ error: msg });
    }
});

module.exports = router;
