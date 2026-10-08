// Host half of dsh-chat-branch.
//
// Branching is entirely a browser-side interaction: the client half calls the
// public Session client service (`ctx.sessions.fork`) and opens the child with
// `ctx.uiWorkspace.openSession`, exactly as the shipped chat branch action does.
// This Node half exists so the package is a Loader entry - which is what makes
// the browser bundle under `exports["./client"]` part of the client boot graph
// through the `dsh.client` declaration - and holds no Host behavior.

/** Host plugin body - no host-side behavior for this surface plugin. */
function apply() {}

export { apply };
