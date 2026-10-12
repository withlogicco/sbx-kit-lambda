// Pi supplies its own packages to extensions at runtime. The extensions live
// under files/home/, outside this package, so resolve their bare imports
// (typebox, @earendil-works/*) from tests/node_modules instead.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";

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
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    // Node 22 may lack native TS support. Transpile as ESM regardless of the
    // extension's package scope; Pi uses its own TS loader in production.
    const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      fileName: new URL(url).pathname,
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
