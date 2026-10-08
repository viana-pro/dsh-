/**
 * dsh-session-cost — host half.
 *
 * Pure UI plugin: the empty apply exists so the package appears in the profile's
 * cordis.yml / Loader tree, while the browser half ships through
 * `exports["./client"]` and is discovered from the `dsh.client` declaration in
 * package.json. Everything this plugin does (reading the session's `tokenUsage`
 * and `modelSelection` projections and pricing them) happens in the browser.
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
function apply() {}

export { apply };
