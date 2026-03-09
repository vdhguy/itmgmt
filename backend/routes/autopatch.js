const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const graph = require('../config/graph');

const router = express.Router();
router.use(authMiddleware);

const GROUPS = {
    test: process.env.AUTOPATCH_GROUP_NAME      || 'Lasne Latop Update - Test',
    last: process.env.AUTOPATCH_GROUP_NAME_LAST || 'Lasne Latop Update - Last',
};

const groupIdCache = {};

async function getGroupId(token, ring) {
    if (groupIdCache[ring]) return groupIdCache[ring];
    const name = GROUPS[ring];
    if (!name) throw new Error(`Ring inconnu : ${ring}`);
    const { data } = await axios.get(graph.GROUP_BY_NAME(name), {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
    });
    if (!data.value.length) throw new Error(`Groupe "${name}" introuvable`);
    groupIdCache[ring] = data.value[0].id;
    return groupIdCache[ring];
}

async function resolveAadObjectId(token, azureADDeviceId) {
    const devRes = await axios.get(graph.AAD_DEVICE_BY_ID(azureADDeviceId), {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!devRes.data.value.length) throw new Error('Appareil non trouvé dans Azure AD');
    return devRes.data.value[0].id;
}

// GET /api/autopatch/config
router.get('/config', (req, res) => {
    res.json({ groups: GROUPS });
});

// GET /api/autopatch/members?ring=test|last  (défaut: test)
router.get('/members', async (req, res) => {
    const ring = req.query.ring || 'test';
    try {
        const groupId = await getGroupId(req.accessToken, ring);
        const { data } = await axios.get(graph.GROUP_MEMBERS_DEV(groupId), {
            headers: { Authorization: `Bearer ${req.accessToken}` }
        });
        res.json(data.value);
    } catch (err) {
        console.error('Autopatch members error:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/autopatch/members — { azureADDeviceId, ring }
router.post('/members', async (req, res) => {
    const { azureADDeviceId, ring = 'test' } = req.body;
    if (!azureADDeviceId) return res.status(400).json({ error: 'azureADDeviceId requis' });
    try {
        const token = req.accessToken;
        const groupId = await getGroupId(token, ring);
        const aadObjectId = await resolveAadObjectId(token, azureADDeviceId);
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

// DELETE /api/autopatch/members/:aadObjectId?ring=test|last
router.delete('/members/:aadObjectId', async (req, res) => {
    const ring = req.query.ring || 'test';
    try {
        const token = req.accessToken;
        const groupId = await getGroupId(token, ring);
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

// POST /api/autopatch/transfer — { azureADDeviceId, from, to }
// Transfère un appareil d'un ring à un autre (ajoute dans to puis supprime de from)
router.post('/transfer', async (req, res) => {
    const { azureADDeviceId, from = 'test', to = 'last' } = req.body;
    if (!azureADDeviceId) return res.status(400).json({ error: 'azureADDeviceId requis' });
    try {
        const token = req.accessToken;
        const [fromGroupId, toGroupId, aadObjectId] = await Promise.all([
            getGroupId(token, from),
            getGroupId(token, to),
            resolveAadObjectId(token, azureADDeviceId),
        ]);

        // Ajouter dans le ring destination
        try {
            await axios.post(
                graph.GROUP_MEMBER_ADD(toGroupId),
                { '@odata.id': graph.DIRECTORY_OBJ(aadObjectId) },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
        } catch (addErr) {
            const msg = addErr.response?.data?.error?.message || '';
            if (!msg.toLowerCase().includes('already exist')) throw addErr;
        }

        // Récupérer l'ID exact du membre dans le groupe source (évite les problèmes de résolution)
        const membersRes = await axios.get(graph.GROUP_MEMBERS_DEV(fromGroupId), {
            headers: { Authorization: `Bearer ${token}` }
        });
        const devId = azureADDeviceId.toLowerCase();
        const member = membersRes.data.value.find(m =>
            (m.deviceId || '').toLowerCase() === devId || m.id === aadObjectId
        );
        if (!member) return res.status(404).json({ error: 'Appareil non trouvé dans le groupe source' });

        // Retirer du ring source avec l'ID exact du membre
        await axios.delete(graph.GROUP_MEMBER_DEL(fromGroupId, member.id), {
            headers: { Authorization: `Bearer ${token}` }
        });

        res.json({ ok: true });
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error('Autopatch transfer error:', msg);
        res.status(500).json({ error: msg });
    }
});

module.exports = router;
