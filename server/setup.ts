import { access } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { loadEnv, projectDirectory, updateEnvFile } from './config.js';
loadEnv();
import { getLocalNetworkAddresses } from './lib/network.js';

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function runInteractiveSetup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('\n============================================================');
    console.log('                 NodePilot Setup Wizard 🚀                  ');
    console.log('============================================================');
    console.log('\nHow would you like to run NodePilot on this computer?\n');
    console.log('  [1] Local PC only (127.0.0.1)');
    console.log('      Only accessible on this computer.');
    console.log('\n  [2] Visible on Local Network / LAN (0.0.0.0)');
    console.log('      Recommended for running on a dedicated laptop or server!');
    console.log('      Control it from your main laptop, PC, or phone over Wi-Fi.\n');

    const choice = await askQuestion(rl, 'Choose an option [1 or 2] (default: 1): ');
    const isLan = choice === '2';

    let pin: string | null = null;
    const localIps = getLocalNetworkAddresses();

    if (isLan) {
      if (localIps.length > 0) {
        console.log(`\n📡 Detected local IP: ${localIps.map((ip) => `http://${ip}:7420`).join(', ')}`);
      }
      console.log('\nTo protect your server panel on local Wi-Fi, you can set an access PIN.');
      const pinAnswer = await askQuestion(rl, 'Enter a PIN or password (press Enter for no PIN): ');
      if (pinAnswer) {
        pin = pinAnswer;
      }
    }

    const host = isLan ? '0.0.0.0' : '127.0.0.1';
    await updateEnvFile({
      NODEPILOT_HOST: host,
      NODEPILOT_PIN: pin,
    });

    console.log('\n============================================================');
    console.log('✅ Configuration saved to .env!');
    if (isLan) {
      console.log('   Mode: Local Network (LAN)');
      if (localIps.length > 0) {
        console.log(`   Remote URL: http://${localIps[0]}:7420`);
        console.log('   👉 Open that URL on your main laptop to control this server!');
      } else {
        console.log('   Remote URL: http://<laptop-ip>:7420');
      }
      if (pin) {
        console.log(`   Access PIN: Protected (${pin})`);
      }
    } else {
      console.log('   Mode: Local PC only');
      console.log('   Access URL: http://localhost:7420');
    }
    console.log('============================================================\n');
  } finally {
    rl.close();
  }
}

export async function shouldRunFirstTimeSetup(): Promise<boolean> {
  const projectRoot = projectDirectory();
  const envPath = path.join(projectRoot, '.env');
  const serverEnvPath = path.join(projectRoot, 'server', '.env');
  try {
    await access(envPath);
    return false;
  } catch {
    try {
      await access(serverEnvPath);
      return false;
    } catch {
      // .env does not exist yet; if interactive terminal, offer setup
      return Boolean(process.stdout.isTTY && process.stdin.isTTY);
    }
  }
}

// If executed directly: `npm run setup`, `tsx setup.ts`, or `node dist/setup.js`
if (
  process.argv[1]?.replace(/\\/g, '/').endsWith('setup.ts') ||
  process.argv[1]?.replace(/\\/g, '/').endsWith('setup.js')
) {
  void runInteractiveSetup();
}
