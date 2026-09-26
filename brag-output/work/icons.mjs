import fs from 'node:fs';
const names = ['circle-check','history','file-text','message-square','code-xml','send','paperclip','undo-2','mouse-pointer-2','highlighter','pencil','square','message-square-text','save','arrow-down-to-line','sun','circle-help','settings-2','panel-left-open','arrow-up','arrow-down','minus','plus','maximize','play','loader-circle','file-code-2','check'];
const out = {};
for (const n of names) {
  const p = `node_modules/lucide-react/dist/esm/icons/${n}.mjs`;
  if (!fs.existsSync(p)) { console.error('missing', n); continue; }
  let m = await import('../../' + p); let __iconData = m.__iconData; if (!__iconData) { const t = fs.readFileSync(p,'utf8'); const r = t.match(/from '\.\/([^']+)'/); console.error(n,'->',r&&r[1]); __iconData = (await import('../../node_modules/lucide-react/dist/esm/icons/' + r[1])).__iconData; }
  const inner = __iconData.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k])=>k!=='key').map(([k,v])=>`${k}="${v}"`).join(' ')}/>`).join('');
  out[n] = inner;
}
fs.writeFileSync('brag-output/work/icons.js', 'window.ICONS=' + JSON.stringify(out) + ';');
console.log(Object.keys(out).length);
