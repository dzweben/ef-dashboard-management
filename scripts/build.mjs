// Bundles src/ui into one self-contained HTML file.
//   docs/index.html      full document for GitHub Pages (the live site)
//   dist/fragment.html   body fragment (title/style/markup/script) for a claude.ai artifact preview
// Flags: --preview  embed data/state.json as a local-only preview (dist/preview.html)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const STYLE_ORDER = ['tokens.css', 'base.css'];
function readStyles() {
  const dir = join(root, 'src/ui/styles');
  const files = readdirSync(dir).filter((f) => f.endsWith('.css'));
  const ordered = [...STYLE_ORDER.filter((f) => files.includes(f)), ...files.filter((f) => !STYLE_ORDER.includes(f)).sort()];
  return ordered.map((f) => `/* ${f} */\n` + readFileSync(join(dir, f), 'utf8')).join('\n');
}

async function bundleJs() {
  const res = await build({
    entryPoints: [join(root, 'src/ui/main.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020', 'safari14'],
    minify: !args.has('--dev'),
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  return res.outputFiles[0].text;
}

// Keep "</script>" and "</style>" sequences from closing the inline tags early.
const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeCss = (css) => css.replace(/<\/style/gi, '<\\/style');

function fill(template, { css, js, preview }) {
  return template
    .replace('/*EF:CSS*/', () => safeCss(css))
    .replace('/*EF:JS*/', () => safeJs(js))
    .replace('<!--EF:PREVIEW-->', () => preview ?? '');
}

const template = readFileSync(join(root, 'src/ui/template.html'), 'utf8');
const css = readStyles();
const js = await bundleJs();

const fragment = fill(template, { css, js, preview: '' });
const fullDoc = (body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
</head>
<body>
${body}
</body>
</html>
`;

mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'docs/index.html'), fullDoc(fragment));
if (!existsSync(join(root, 'docs/.nojekyll'))) writeFileSync(join(root, 'docs/.nojekyll'), '');
writeFileSync(join(root, 'dist/fragment.html'), fragment);

if (args.has('--preview')) {
  const statePath = join(root, 'data/state.json');
  const state = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '{}';
  const tag = `<script>window.__EF_PREVIEW__ = ${state.replace(/<\//g, '<\\/')};</script>`;
  const previewFrag = fill(template, { css, js, preview: tag });
  writeFileSync(join(root, 'dist/preview-fragment.html'), previewFrag);
  writeFileSync(join(root, 'dist/preview.html'), fullDoc(previewFrag));
}

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`built docs/index.html (${kb(fullDoc(fragment))}), js ${kb(js)}, css ${kb(css)}`);
