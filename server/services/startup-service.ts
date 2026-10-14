import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { HostSettingsRepository } from '../repositories/host-settings-repository.js';
import type { HostStartupStatus } from '../types.js';

const execAsync = promisify(exec);

export class StartupService {
  constructor(
    private readonly hostSettingsRepo: HostSettingsRepository,
    private readonly projectRoot: string,
  ) {}

  /**
   * Determine the target startup file or unit path based on platform.
   */
  getStartupFilePath(): string | null {
    const platform = os.platform();
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'NodePilot-Startup.vbs');
    }
    if (platform === 'linux') {
      return path.join(os.homedir(), '.config', 'systemd', 'user', 'nodepilot.service');
    }
    return null;
  }

  /**
   * Get the current startup status reconciling database state with real OS registration.
   */
  async getStatus(): Promise<HostStartupStatus> {
    const platform = os.platform();
    const isSupported = platform === 'win32' || platform === 'linux';
    const settings = this.hostSettingsRepo.getSettings();
    const filePath = this.getStartupFilePath();

    let registeredInOs = false;
    let registrationDetails = 'Automatic startup is not supported on this platform.';
    let requiresElevation = false;
    let permissionsExplanation = '';

    if (platform === 'win32') {
      requiresElevation = false;
      permissionsExplanation = 'Per-user Windows startup shortcut inside user Roaming Startup folder. No administrator privileges required.';
      if (filePath && existsSync(filePath)) {
        registeredInOs = true;
        registrationDetails = `Registered via user startup script: ${filePath}`;
      } else {
        registeredInOs = false;
        registrationDetails = 'No startup script found in Windows Startup folder.';
      }
    } else if (platform === 'linux') {
      requiresElevation = false;
      permissionsExplanation = 'User-level systemd service (~/.config/systemd/user/nodepilot.service). Lingering may be required for headless boot without login.';
      if (filePath && existsSync(filePath)) {
        registeredInOs = true;
        registrationDetails = `Registered via user systemd service: ${filePath}`;
      } else {
        registeredInOs = false;
        registrationDetails = 'No systemd user service installed.';
      }
    }

    return {
      platform,
      isSupported,
      configuredInDatabase: settings.systemStartupEnabled,
      registeredInOs,
      registrationDetails,
      launchMode: settings.launchMode,
      openBrowserOnStartup: settings.openBrowserOnStartup,
      serviceName: platform === 'linux' ? 'nodepilot.service' : undefined,
      serviceFile: filePath ?? undefined,
      requiresElevation,
      permissionsExplanation,
    };
  }

  /**
   * Enable OS-level startup based on current or provided settings.
   */
  async enableStartup(options?: {
    launchMode?: 'headless' | 'windowed';
    openBrowserOnStartup?: boolean;
  }): Promise<HostStartupStatus> {
    const platform = os.platform();
    if (platform !== 'win32' && platform !== 'linux') {
      throw new Error(`Automatic startup integration is not supported on platform "${platform}".`);
    }

    const currentSettings = this.hostSettingsRepo.getSettings();
    const launchMode = options?.launchMode ?? currentSettings.launchMode;
    const openBrowserOnStartup = options?.openBrowserOnStartup ?? currentSettings.openBrowserOnStartup;

    const startupFile = this.getStartupFilePath();
    if (!startupFile) {
      throw new Error('Unable to resolve startup file path for platform.');
    }

    await mkdir(path.dirname(startupFile), { recursive: true });

    if (platform === 'win32') {
      await this.installWindowsStartupScript(startupFile, launchMode, openBrowserOnStartup);
    } else if (platform === 'linux') {
      await this.installLinuxSystemdService(startupFile, launchMode, openBrowserOnStartup);
    }

    this.hostSettingsRepo.saveSettings({
      systemStartupEnabled: true,
      launchMode,
      openBrowserOnStartup,
    });

    return this.getStatus();
  }

  /**
   * Disable and cleanly remove only NodePilot's OS startup entry.
   */
  async disableStartup(): Promise<HostStartupStatus> {
    const platform = os.platform();
    const startupFile = this.getStartupFilePath();

    if (startupFile && existsSync(startupFile)) {
      if (platform === 'linux') {
        try {
          await execAsync('systemctl --user stop nodepilot.service');
        } catch {
          // Service might already be stopped
        }
        try {
          await execAsync('systemctl --user disable nodepilot.service');
        } catch {
          // May not be enabled
        }
      }

      try {
        await unlink(startupFile);
      } catch (err) {
        throw new Error(`Failed to remove startup entry: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (platform === 'linux') {
        try {
          await execAsync('systemctl --user daemon-reload');
        } catch {
          // Ignore daemon reload failure
        }
      }
    }

    this.hostSettingsRepo.saveSettings({
      systemStartupEnabled: false,
    });

    return this.getStatus();
  }

  private async installWindowsStartupScript(
    startupFile: string,
    launchMode: 'headless' | 'windowed',
    openBrowserOnStartup: boolean,
  ): Promise<void> {
    const nodeExecutable = process.execPath;
    const serverEntry = path.join(this.projectRoot, 'server', 'dist', 'index.js');
    const windowStyle = launchMode === 'headless' ? 0 : 1;

    // VBScript creates WScript.Shell, sets current working directory, and launches node
    const vbsContent = [
      '\' Auto-generated by NodePilot Host Settings',
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.CurrentDirectory = "${this.projectRoot.replace(/\\/g, '\\\\')}"`,
      `WshShell.Run """${nodeExecutable.replace(/\\/g, '\\\\')}"" """${serverEntry.replace(/\\/g, '\\\\')}""", ${windowStyle}, False`,
      openBrowserOnStartup
        ? 'WScript.Sleep 2500\nWshShell.Run "http://127.0.0.1:7420", 1, False'
        : '',
      '',
    ].filter(Boolean).join('\r\n');

    await writeFile(startupFile, vbsContent, 'utf8');
  }

  private async installLinuxSystemdService(
    serviceFile: string,
    _launchMode: 'headless' | 'windowed',
    _openBrowserOnStartup: boolean,
  ): Promise<void> {
    const nodeExecutable = process.execPath;
    const serverEntry = path.join(this.projectRoot, 'server', 'dist', 'index.js');

    const serviceContent = `[Unit]
Description=NodePilot Local Minecraft Host Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=${this.projectRoot}
ExecStart=${nodeExecutable} ${serverEntry}
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

    await writeFile(serviceFile, serviceContent, 'utf8');

    try {
      await execAsync('systemctl --user daemon-reload');
      await execAsync('systemctl --user enable nodepilot.service');
    } catch (err) {
      // Don't fail completely if systemctl is missing in container or test env, but keep file
      console.warn('systemctl command failed during service registration:', err);
    }
  }
}
