const { ConfidentialClientApplication } = require('@azure/msal-node');

const cca = new ConfidentialClientApplication({
    auth: {
        clientId:     process.env.CLIENT_ID,
        authority:    `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
        clientSecret: process.env.CLIENT_SECRET,
    }
});

async function getAccessToken() {
    const result = await cca.acquireTokenByClientCredential({
        scopes: [process.env.GRAPH_SCOPE || 'https://graph.microsoft.com/.default']
    });
    return result.accessToken;
}

async function authMiddleware(req, res, next) {
    try {
        req.accessToken = await getAccessToken();
        next();
    } catch (err) {
        console.error('Auth error:', err.message);
        res.status(401).json({ error: 'Authentication failed' });
    }
}

async function getMdeAccessToken() {
    const result = await cca.acquireTokenByClientCredential({
        scopes: ['https://api.securitycenter.microsoft.com/.default']
    });
    return result.accessToken;
}

module.exports = { authMiddleware, getAccessToken, getMdeAccessToken, cca };
