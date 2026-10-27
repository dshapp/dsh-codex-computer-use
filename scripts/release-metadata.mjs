import { readFileSync, appendFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (p.name !== 'dsh-codex-computer-use' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(p.version)) throw Error('Invalid release identity');
if (process.env.EXPECTED_VERSION && process.env.EXPECTED_VERSION !== p.version) throw Error('Requested version differs from package.json');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== 'v' + p.version) throw Error('Release tag differs from package.json');
const values = {version:p.version, dist_tag:p.version.includes('-') ? 'experimental' : 'latest', tarball:p.name+'-'+p.version+'.tgz'};
for (const [k,v] of Object.entries(values)) {console.log(k+'='+v); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,k+'='+v+'\n');}
