const express = require('express');
const axios = require('axios');
const { cca, getAccessToken } = require('../middleware/auth');

const router = express.Router();

const REDIRECT_URI  = process.env.REDIRECT_URI  || 'http://localhost:3000/auth/callback';
const AUTH_GROUP    = process.env.AUTH_GROUP_NAME || 'ITmgmt';

// GET /auth/login — redirect to Microsoft login
router.get('/login', async (req, res) => {
    try {
        const url = await cca.getAuthCodeUrl({
            scopes: ['openid', 'profile', 'email'],
            redirectUri: REDIRECT_URI,
        });
        res.redirect(url);
    } catch (err) {
        console.error('Login redirect error:', err.message);
        res.redirect('/login.html?error=1');
    }
});

// GET /auth/callback — exchange code, check group, set session
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) return res.redirect('/login.html?error=1');

    try {
        const result = await cca.acquireTokenByCode({
            code,
            scopes: ['openid', 'profile', 'email'],
            redirectUri: REDIRECT_URI,
        });

        const oid  = result.idTokenClaims?.oid;
        const name = result.account?.name || result.idTokenClaims?.name;
        const upn  = result.account?.username;

        if (!oid) return res.redirect('/login.html?error=1');

        // Check group membership using app-only token (Group.ReadWrite.All already granted)
        const appToken = await getAccessToken();
        const groupsRes = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${oid}/transitiveMemberOf?$select=displayName`,
            { headers: { Authorization: `Bearer ${appToken}` } }
        );

        const isMember = groupsRes.data.value.some(
            g => g.displayName?.toLowerCase() === AUTH_GROUP.toLowerCase()
        );

        if (!isMember) return res.redirect('/login.html?error=unauthorized');

        req.session.user = { name, upn, oid };
        req.session.save(() => res.redirect('/'));
    } catch (err) {
        console.error('Auth callback error:', err.response?.data || err.message);
        res.redirect('/login.html?error=1');
    }
});

// GET /auth/me — returns session user info
router.get('/me', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    res.json(req.session.user);
});

// GET /auth/logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

module.exports = router;
