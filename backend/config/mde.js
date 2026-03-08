const BASE = 'https://api.securitycenter.microsoft.com/api';

module.exports = {
    MACHINES_BY_NAME: (name) => `${BASE}/machines?$filter=computerDnsName eq '${name.toLowerCase()}'`,
    MACHINES_ALL:     () => `${BASE}/machines?$top=1000&$select=id,computerDnsName`,
    MACHINE_VULNS:    (id)   => `${BASE}/machines/${id}/vulnerabilities`,
    MACHINE_SOFTWARE: (id)   => `${BASE}/machines/${id}/software`,
    SOFTWARE_VULNS:   (id)   => `${BASE}/software/${id}/vulnerabilities`,
};
