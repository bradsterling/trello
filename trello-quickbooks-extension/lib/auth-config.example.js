// Copy this file to auth-config.js for the private local installation.
// The installation secret must match LEDGERFLOW_INSTALLATION_SECRET in the
// backend runtime. Keep auth-config.js out of source control and do not ship
// it to other users.
export const AUTH_CONFIG = {
  backendUrl: 'REPLACE_WITH_BACKEND_URL',
  trelloApiKey: 'REPLACE_WITH_TRELLO_API_KEY',
  installationSecret: 'REPLACE_WITH_LOCAL_INSTALLATION_SECRET'
};

export function assertAuthConfig() {
  const missing = Object.entries(AUTH_CONFIG)
    .filter(([, value]) => !value || value.startsWith('REPLACE_WITH_'))
    .map(([key]) => key);
  if (missing.length) throw new Error(`Ledgerflow authentication is not configured (${missing.join(', ')}).`);
}
