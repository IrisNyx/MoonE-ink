// These releases block the compromised eMudhra/emSign intermediate public keys,
// including chains through custom/system trust stores. Node 25 is end-of-life.
export const SECURE_NODE_RANGE = '^24.22.1 || >=26.12.1';

export function isSecureNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) ||
    (major === 26 && (minor > 12 || (minor === 12 && patch >= 1))) || major > 26;
}

if (!isSecureNodeVersion(process.version)) {
  process.stderr.write(
    `Ephemera cannot start with Node.js ${process.version}: this runtime lacks the required certificate security fixes. ` +
    'Install Node.js 24.22.1 or later in the 24.x line (recommended), or 26.12.1 or later, from https://nodejs.org/. ' +
    'Restart the terminal or service manager and check node --version. Node.js 25 is unsupported.\n',
  );
  process.exit(1);
}
