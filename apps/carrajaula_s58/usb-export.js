'use strict';
// Same removable-media locations used by idrive7-cluster-info's Logs screen.
// Only mounted volumes are offered; never create a missing mount-point directory.
const fs = require('fs');
const path = require('path');
const unescapeMount = s => s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
function drives() {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    const seen = new Set();
    return mounts.split('\n').reduce((out, line) => {
        const f = line.split(/\s+/);
        if (f.length < 4) return out;
        const mount = unescapeMount(f[1]);
        if (!/^\/(?:media\/[^/]+|run\/media\/[^/]+\/[^/]+)$/.test(mount) || path.resolve(mount) !== mount || seen.has(mount)) return out;
        seen.add(mount);
        out.push({ mount, writable: f[3].split(',').includes('rw') });
        return out;
    }, []);
}
function copy(jsonFile, mount) {
    const drive = drives().find(d => d.mount === mount);
    if (!drive) throw new Error('USB drive is no longer mounted. Refresh USB drives.');
    if (!drive.writable) throw new Error('USB drive is mounted read-only.');
    if (fs.realpathSync(mount) !== mount || !fs.statSync(mount).isDirectory()) throw new Error('USB mount path changed. Refresh USB drives.');
    const name = path.basename(jsonFile);
    if (!/^misfire-export-[\w-]+\.json$/.test(name)) throw new Error('Unexpected report filename');
    const text = fs.readFileSync(jsonFile, 'utf8');
    JSON.parse(text); // Do not copy a truncated or invalid report.
    const dir = path.join(mount, 'S58-Overview');
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fs.realpathSync(dir) !== dir) throw new Error('USB export folder must not be a symbolic link');
    const target = path.join(dir, name);
    const fd = fs.openSync(target, 'wx'); // Preserve existing reports, even on a timestamp collision.
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return target;
}
module.exports = { drives, copy };
