// Pi supplies its own packages to extensions at runtime. The extensions live
// under files/home/, outside this package, so resolve their bare imports
// (typebox, @earendil-works/*) from tests/node_modules instead.
import { registerHooks } from "node:module";

const fallbackParent = new URL("./package.json", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || /^(?:\.|\/|[a-z]+:)/.test(specifier)) throw error;
      return nextResolve(specifier, { ...context, parentURL: fallbackParent });
    }
  },
});
