#!/usr/bin/env node
// npx lite-agents init — scaffold a new lite-agents project in the current directory

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const cwd = process.cwd();
const arg = process.argv[2];

if (arg !== "init") {
  console.log("Usage: npx lite-agents init");
  console.log("       Run inside an empty directory to scaffold a new lite-agents project.");
  process.exit(0);
}

console.log("Cloning lite-agents template...");
execSync("git clone --depth 1 https://github.com/BerriAI/lite-agents .", {
  cwd,
  stdio: "inherit",
});

// Remove the .git dir so the user starts fresh
execSync("rm -rf .git", { cwd });
execSync("git init", { cwd, stdio: "inherit" });

// Verify skills/ exists
if (!existsSync(join(cwd, "skills"))) {
  mkdirSync(join(cwd, "skills"), { recursive: true });
}

// Write a .env.example to make required vars obvious
const envExample = `LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=sk-...
REPO_PATH=/path/to/your/git/repo
PORT=8001
`;
writeFileSync(join(cwd, ".env.example"), envExample);

console.log(`
Done. Next steps:

  npm install
  cp .env.example .env        # fill in your values
  npm start

Edit skills/ to change agent behaviour.
Edit src/agent.ts to swap agent frameworks.
Open http://localhost:8001
`);
