import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = "/Users/athuls/UGC copy";
const require = createRequire(path.join(root, "ugc-app/package.json"));
const { chromium } = require("playwright");
const html = path.join(
  root,
  ".superpowers/brainstorm/28995-1779102767/content/mobile-post-flow-v1.html",
);
const outDir = path.join(root, "mockups/mobile-post-flow");
const names = [
  "a-two-action-entry",
  "b-universal-composer",
  "c-marketplace-expanded",
  "d-after-publish-viewer",
];

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1900 },
  deviceScaleFactor: 2,
});

await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
await page.screenshot({
  path: path.join(outDir, "post-flow-board.png"),
  fullPage: true,
});

const cards = await page.locator(".option-card").all();
for (let index = 0; index < cards.length; index += 1) {
  await cards[index].screenshot({
    path: path.join(outDir, `${names[index] ?? `screen-${index + 1}`}.png`),
  });
}

await browser.close();
console.log(outDir);
