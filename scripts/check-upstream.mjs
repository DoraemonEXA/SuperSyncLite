import { readFile, appendFile } from 'node:fs/promises';
const base = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
const api = 'https://api.github.com/repos/' + base.repository;
async function get(path) {
  const r = await fetch(api + path, {
    headers: {
      'User-Agent': 'supersync-lite-release-check',
      ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
    },
  });
  if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
  return r.json();
}
const latest = await get('/releases/latest');
const releaseCommit = (await get('/commits/' + encodeURIComponent(latest.tag_name))).sha;
const same = releaseCommit === base.commit;
const origin = 'https://github.com/' + base.repository;
const report = [
  '# SuperSync upstream check',
  '',
  same
    ? 'The pinned baseline matches the current stable release.'
    : 'A stable release differs from the pinned baseline. A maintainer can review the changes.',
  '',
  'Baseline: ' + base.tag + ' (' + base.commit + ')',
  'Latest: ' + latest.tag_name + ' (' + releaseCommit + ')',
  '',
  '[Compare releases](' + origin + '/compare/' + base.commit + '...' + releaseCommit + ')',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\n');
