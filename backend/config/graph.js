const BASE      = `${process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com'}/v1.0`;
const BASE_BETA = `${process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com'}/beta`;

module.exports = {
    DEVICES:         `${BASE}/deviceManagement/managedDevices`,
    DEVICE_BY_ID:    (id) => `${BASE}/deviceManagement/managedDevices/${id}`,
    DEVICE_USERS:    (id) => `${BASE}/deviceManagement/managedDevices/${id}/users`,
    USER_BY_ID:      (id) => `${BASE}/users/${id}`,
    USERS_SEARCH:    (q)  => `${BASE}/users?$search="displayName:${q}" OR "userPrincipalName:${q}"&$select=id,displayName,userPrincipalName,mail&$top=20&$orderby=displayName`,
    USER_DEVICES:    (id) => `${BASE}/users/${id}/managedDevices`,
    USER_SIGNIN:       (id) => `${BASE}/users/${id}?$select=id,signInActivity`,
    USER_SIGNINS:      (id, since) => `${BASE}/auditLogs/signIns?$filter=userId eq '${id}' and createdDateTime ge ${since}&$top=200&$orderby=createdDateTime desc&$select=createdDateTime,appDisplayName,ipAddress,location,status,deviceDetail,clientAppUsed`,
    DEVICE_LOGONS:     (id) => `${BASE_BETA}/deviceManagement/managedDevices/${id}?$select=id,usersLoggedOn`,
    DEVICE_NETWORK:    (id) => `${BASE_BETA}/deviceManagement/managedDevices/${id}?$select=id,networkInterfaces`,
    DEVICE_PROTECTION: (id) => `${BASE_BETA}/deviceManagement/managedDevices/${id}/windowsProtectionState`,
    // BitLocker & LAPS
    BITLOCKER_KEYS:    (deviceId) => `${BASE}/informationProtection/bitlocker/recoveryKeys?$filter=deviceId eq '${deviceId}'&$select=id,deviceId,createdDateTime,volumeType`,
    BITLOCKER_KEY:     (keyId)    => `${BASE}/informationProtection/bitlocker/recoveryKeys/${keyId}?$select=key`,
    LAPS_CREDENTIALS:  (deviceId) => `${BASE_BETA}/directory/deviceLocalCredentials/${deviceId}?$select=credentials,deviceName,refreshDateTime`,
    // Groups / Autopatch
    GROUP_BY_NAME:     (name) => `${BASE}/groups?$filter=displayName eq '${name}'&$select=id,displayName&$count=true`,
    GROUP_MEMBERS_DEV: (id)   => `${BASE}/groups/${id}/members/microsoft.graph.device?$select=id,displayName,deviceId`,
    GROUP_MEMBER_ADD:  (id)   => `${BASE}/groups/${id}/members/$ref`,
    GROUP_MEMBER_DEL:  (gid, mid) => `${BASE}/groups/${gid}/members/${mid}/$ref`,
    AAD_DEVICE_BY_ID:  (devId)   => `${BASE}/devices?$filter=deviceId eq '${devId}'&$select=id,displayName`,
    DIRECTORY_OBJ:     (id)   => `${process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com'}/v1.0/directoryObjects/${id}`,
};
