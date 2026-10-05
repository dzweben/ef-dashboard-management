// Bundles src/ui into one self-contained HTML file.
//   docs/index.html      full document for GitHub Pages (the live site)
//   dist/fragment.html   body fragment (title/style/markup/script) for a claude.ai artifact preview
// Flags: --preview  embed data/state.json as a local-only preview (dist/preview.html)
//        --dev      unminified bundle
// The helpers below are exported (and the build only runs when this file is executed)
// so tests can check the escaping without bundling.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STYLE_ORDER = ['tokens.css', 'base.css'];
function readStyles() {
  const dir = join(root, 'src/ui/styles');
  const files = readdirSync(dir).filter((f) => f.endsWith('.css'));
  const ordered = [...STYLE_ORDER.filter((f) => files.includes(f)), ...files.filter((f) => !STYLE_ORDER.includes(f)).sort()];
  return ordered.map((f) => `/* ${f} */\n` + readFileSync(join(dir, f), 'utf8')).join('\n');
}

async function bundleJs(args) {
  const { build } = await import('esbuild');
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
export const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
export const safeCss = (css) => css.replace(/<\/style/gi, '<\\/style');

/**
 * JSON that is safe inside an inline <script>: re-serialized (so only JSON can get
 * in), with every <, >, & and U+2028/U+2029 written as a \uXXXX escape. Those
 * characters only occur inside JSON strings, where the escape means the same thing,
 * so no "</script>", "<!--" or "<script" from a task title can end the tag or put
 * the HTML tokenizer into its double-escaped state (which would merge the preview
 * script with the app script).
 */
export function scriptSafeJson(text) {
  const json = JSON.stringify(JSON.parse(text));
  return json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The <script> tag that seeds the --preview build with a state.json text. */
export function previewTag(stateText) {
  return `<script>window.__EF_PREVIEW__ = ${scriptSafeJson(stateText)};</script>`;
}

export function fill(template, { css, js, preview }) {
  return template
    .replace('/*EF:CSS*/', () => safeCss(css))
    .replace('/*EF:JS*/', () => safeJs(js))
    .replace('<!--EF:PREVIEW-->', () => preview ?? '');
}

export const fullDoc = (body) => `<!doctype html>
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

async function main(args) {
  const template = readFileSync(join(root, 'src/ui/template.html'), 'utf8');
  const css = readStyles();
  const js = await bundleJs(args);

  const fragment = fill(template, { css, js, preview: '' });

  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'docs/index.html'), fullDoc(fragment));
  if (!existsSync(join(root, 'docs/.nojekyll'))) writeFileSync(join(root, 'docs/.nojekyll'), '');
  writeFileSync(join(root, 'dist/fragment.html'), fragment);

  if (args.has('--preview')) {
    const statePath = join(root, 'data/state.json');
    const state = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '{}';
    let tag;
    try {
      tag = previewTag(state);
    } catch (err) {
      throw new Error(`data/state.json is not valid JSON, so there is no preview to embed (${err.message}); run node bin/ef.mjs check`);
    }
    const previewFrag = fill(template, { css, js, preview: tag });
    writeFileSync(join(root, 'dist/preview-fragment.html'), previewFrag);
    writeFileSync(join(root, 'dist/preview.html'), fullDoc(previewFrag));
  }

  const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
  console.log(`built docs/index.html (${kb(fullDoc(fragment))}), js ${kb(js)}, css ${kb(css)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(new Set(process.argv.slice(2))).catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
