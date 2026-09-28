const modules = new Map([
  ["\0virtual:a.ts", `import b from "virtual:b"; import helper from "./helper.ts"; export default "a:" + b + helper;`],
  ["\0virtual:b.ts", `import { value } from "virtual-leaf"; export default value;`],
  ["\0virtual:helper.ts", `export default ":helper";`],
  ["\0virtual:a-b.ts", `export default "slash";`],
  ["\0virtual:a_b.ts", `export default "question";`],
]);
const absoluteId = new URL("./src/virtual/absolute.ts", import.meta.url).pathname;
modules.set(absoluteId, `export default "absolute";`);

const virtualPlugin = {
  name: "prepare-v2-virtuals",
  resolveId(id, importer) {
    if (id === "virtual:a") return "\0virtual:a.ts";
    if (id === "virtual:b") return "\0virtual:b.ts";
    if (id === "./helper.ts" && importer === "\0virtual:a.ts") return "\0virtual:helper.ts";
    if (id === "virtual:absolute") return absoluteId;
    if (id === "virtual:a/b") return "\0virtual:a-b.ts";
    if (id === "virtual:a?b") return "\0virtual:a_b.ts";
  },
  load(id) {
    return modules.get(id);
  },
};

export default {
  site: "https://prepare-v2.example",
  integrations: [{
    name: "prepare-v2",
    hooks: {
      "astro:config:setup"({ updateConfig, injectScript }) {
        updateConfig({ vite: { plugins: [virtualPlugin] } });
        injectScript("head-inline", "window.first = true;");
        injectScript("head-inline", "window.second = true;");
        injectScript("page", "console.log('page');");
      },
    },
  }],
};
