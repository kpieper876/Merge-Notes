import esbuild from "esbuild";
import { readFileSync } from "fs";

const banner = {
  js: readFileSync("banner.js", "utf8"),
};

const prod = process.argv.includes("--prod");

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "main.js",
    format: "cjs",
    platform: "browser",
    sourcemap: !prod,
    external: ["obsidian"],
    banner,
    target: ["es2018"],
  })
  .catch(() => process.exit(1));
