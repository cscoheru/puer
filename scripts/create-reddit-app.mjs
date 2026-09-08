// Reddit App Creator - Run locally with: node scripts/create-reddit-app.mjs
// Uses your local Chrome to log into Reddit and create a developer app
// This bypasses the CAPTCHA loop because your browser already has the session

import { execSync } from "child_process";
import { createInterface } from "readline";

const REDDIT_USERNAME = "klyliae";
const APP_NAME = "puer-hub";
const APP_TYPE = "script";
const DESCRIPTION = "Pu-erh tea community sharing app";
const REDIRECT_URI = "http://localhost:3000/callback";
const ABOUT_URL = "https://puer.im";

console.log("=== Reddit App Creator ===\n");
console.log("This script will open Chrome so you can create a Reddit developer app.");
console.log("Steps:");
console.log("1. Log into Reddit in the Chrome window that opens");
console.log("2. Go to https://www.reddit.com/prefs/apps");
console.log("3. Click 'create another app...' at the bottom");
console.log("4. Fill in:");
console.log(`   - name: ${APP_NAME}`);
console.log(`   - type: select "script"`);
console.log(`   - description: ${DESCRIPTION}`);
console.log(`   - about url: ${ABOUT_URL}`);
console.log(`   - redirect uri: ${REDIRECT_URI}`);
console.log("5. Click 'create app'");
console.log("6. Copy the client_id (shown under the app name) and client_secret");
console.log("");

// Open Chrome to Reddit apps page
const isMac = process.platform === "darwin";
const chromeCmd = isMac
  ? 'open -a "Google Chrome" "https://www.reddit.com/prefs/apps"'
  : process.platform === "win32"
    ? 'start chrome "https://www.reddit.com/prefs/apps"'
    : 'xdg-open "https://www.reddit.com/prefs/apps"';

try {
  execSync(chromeCmd);
  console.log("Chrome opened. Follow the steps above.\n");
} catch {
  console.log("Could not open Chrome automatically. Please manually go to:");
  console.log("https://www.reddit.com/prefs/apps\n");
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  const clientId = await ask("Enter the client_id (shown under app name after creation): ");
  const clientSecret = await ask("Enter the client_secret: ");

  console.log("\n=== Your Reddit API Credentials ===");
  console.log(`REDDIT_CLIENT_ID=${clientId.trim()}`);
  console.log(`REDDIT_CLIENT_SECRET=${clientSecret.trim()}`);
  console.log(`REDDIT_USERNAME=${REDDIT_USERNAME}`);
  console.log("\nAdd these to your .env file or tell Claude to continue.");
  rl.close();
}

main();
