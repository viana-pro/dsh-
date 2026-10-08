/**
 * Test entry shim: installs the `@deepseek-ai/*` resolve hook, then loads the
 * test. Kept separate because `module.register` must run before the test's own
 * static imports are resolved.
 *
 * Run: node test/register-hook.mjs
 */
import { register } from 'node:module';

register('./dsh-resolve-hook.mjs', import.meta.url);
await import('./apply-patch.test.mjs');
