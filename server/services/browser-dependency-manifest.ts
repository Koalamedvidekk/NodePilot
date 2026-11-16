export interface BrowserDependency {
  id: string;
  version: string;
  fileName: string;
  url: string;
  sha256: string;
}

export const BROWSER_GATEWAY_JAVA_MAJOR = 25;

export const browserJavaDependencies: readonly BrowserDependency[] = [
  {
    id: 'velocity', version: '4.3.1-45', fileName: 'velocity.jar',
    url: 'https://fill-data.papermc.io/v1/objects/0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75/velocity-4.3.1-45.jar',
    sha256: '0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75',
  },
  {
    id: 'eagler', version: '1.1.1', fileName: 'EaglerXServer.jar',
    url: 'https://github.com/lax1dude/eaglerxserver/releases/download/v1.1.1/EaglerXServer.jar',
    sha256: '468cb07eb7ca466b21b439be75156d3d01579327f4c6dae5b67d471137a64208',
  },
  {
    id: 'viaversion', version: '5.12.2', fileName: 'ViaVersion.jar',
    url: 'https://github.com/ViaVersion/ViaVersion/releases/download/5.12.2/ViaVersion-5.12.2.jar',
    sha256: '24e4876fefe73e08a4c87cd6c457ee0916e62dd69656631caf41e26f909d504b',
  },
  {
    id: 'viabackwards', version: '5.12.2', fileName: 'ViaBackwards.jar',
    url: 'https://github.com/ViaVersion/ViaBackwards/releases/download/5.12.2/ViaBackwards-5.12.2.jar',
    sha256: '9a148a80ea22074f4bd1626cdbe254a4cd998bf44e7ceaff4e285a1b6b35da42',
  },
  {
    id: 'viarewind', version: '4.2.0', fileName: 'ViaRewind.jar',
    url: 'https://github.com/ViaVersion/ViaRewind/releases/download/4.2.0/ViaRewind-4.2.0.jar',
    sha256: 'd6634ba57bb82d5161c68dfb393571cdf40511a0beb1b04b8c7ed794a3532c6a',
  },
  {
    id: 'bungeeguard', version: '1.4.0', fileName: 'BungeeGuard.jar',
    url: 'https://github.com/lucko/BungeeGuard/releases/download/v1.4.0/BungeeGuard.jar',
    sha256: 'f2f3a3df266b0d3cc241f67bf87d6cdb6f12ecd0d556bd8e07a5e58dcf7e1d47',
  },
];

const cloudflaredVersion = '2026.10.7';
const cloudflaredAssets: Readonly<Record<string, { asset: string; sha256: string }>> = {
  'win32-x64': {
    asset: 'cloudflared-windows-amd64.exe',
    sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
  },
  'linux-x64': {
    asset: 'cloudflared-linux-amd64',
    sha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
  },
  'linux-arm64': {
    asset: 'cloudflared-linux-arm64',
    sha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775',
  },
};

export function cloudflaredDependency(platform: string, arch: string): BrowserDependency | null {
  const selected = cloudflaredAssets[platform + '-' + arch];
  if (!selected) return null;
  return {
    id: 'cloudflared', version: cloudflaredVersion,
    fileName: platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
    url: 'https://github.com/cloudflare/cloudflared/releases/download/' + cloudflaredVersion + '/' + selected.asset,
    sha256: selected.sha256,
  };
}
