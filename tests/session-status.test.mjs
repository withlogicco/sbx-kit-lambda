import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-ai": import.meta.resolve("@earendil-works/pi-ai"),
    "@earendil-works/pi-coding-agent": import.meta.resolve("@earendil-works/pi-coding-agent"),
    typebox: import.meta.resolve("typebox"),
  },
});

await jiti.import("./session-status.test.ts");
