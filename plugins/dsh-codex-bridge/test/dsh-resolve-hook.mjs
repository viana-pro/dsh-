/**
 * Test-only ESM resolve hook.
 *
 * The DSH packages normally live inside `app.asar`, which plain Node cannot
 * read. This hook redirects `@deepseek-ai/*` specifiers to the read-only
 * extracted tree under `_src/`, honoring each package's `exports` map so
 * packages that ship `.mjs` (for example schemastery) resolve correctly.
 * Anything else falls through to normal resolution.
 *
 * It exists only to run `test/apply-patch.test.mjs`; the plugin itself never
 * uses it.
 */
import { readFileSync } from 'node:fs';

const PREFIX = '@deepseek-ai/';
const ROOT = new URL('../../_src/dsh/node_modules/@deepseek-ai/', import.meta.url);

const cache = new Map();

/**
 * Read and cache one package's manifest.
 * @param pkg - The scoped package name without its scope prefix.
 * @returns The parsed manifest, or undefined when the package has no manifest.
 */
function manifest(pkg) {
  if (cache.has(pkg)) return cache.get(pkg);
  let value;
  try {
    value = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, ROOT), 'utf8'));
  } catch {
    value = undefined;
  }
  cache.set(pkg, value);
  return value;
}

/**
 * Resolve one `@deepseek-ai/<pkg>` or `@deepseek-ai/<pkg>/<sub>` specifier.
 * @param pkg - The scoped package name without its scope prefix.
 * @param sub - The subpath after the package name, when present.
 * @returns The absolute file URL, or undefined when it cannot be mapped.
 */
function target(pkg, sub) {
  const pkgJson = manifest(pkg);
  if (pkgJson === undefined) return undefined;
  if (sub.length > 0) {
    const mapped = pkgJson.exports?.[`./${sub}`];
    if (typeof mapped === 'string') return new URL(mapped, new URL(`${pkg}/`, ROOT));
    const candidate = sub.includes('.') ? sub : `${sub}/index.js`;
    try {
      return new URL(`${pkg}/${candidate}`, ROOT);
    } catch {
      return undefined;
    }
  }
  const root = pkgJson.exports?.['.'];
  const entry =
    (typeof root === 'object' ? (root.import ?? root.default) : undefined) ??
    pkgJson.module ??
    pkgJson.main ??
    'lib/index.js';
  return new URL(`${pkg}/${entry}`, ROOT);
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(PREFIX)) {
    const [pkg, ...rest] = specifier.slice(PREFIX.length).split('/');
    const url = target(pkg, rest.join('/'));
    if (url !== undefined) return { url: url.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
