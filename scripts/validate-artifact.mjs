import { readFileSync, statSync } from "node:fs";
const entry = readFileSync(new URL("../dist/server/index.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
if (!entry.includes("export default") || !entry.includes("async fetch")) throw new Error("Worker entrypoint is incomplete");
if (!manifest.project_id || manifest.d1 !== "DB") throw new Error("Hosting manifest is incomplete");
if (statSync(new URL("../dist/server/index.js", import.meta.url)).size < 1000) throw new Error("Worker bundle is unexpectedly small");
console.log("Deployment artifact is ready.");
