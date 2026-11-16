// Stable Java protocol IDs from the pinned ViaVersion 5.12.2 release table:
// https://github.com/ViaVersion/ViaVersion/blob/5.12.2/api/src/main/java/com/viaversion/viaversion/api/protocol/version/ProtocolVersion.java
const RELEASE_PROTOCOLS = new Map<string, number>([
  [759, ['1.19']], [760, ['1.19.1', '1.19.2']], [761, ['1.19.3']], [762, ['1.19.4']],
  [763, ['1.20', '1.20.1']], [764, ['1.20.2']], [765, ['1.20.3', '1.20.4']], [766, ['1.20.5', '1.20.6']],
  [767, ['1.21', '1.21.1']], [768, ['1.21.2', '1.21.3']], [769, ['1.21.4']], [770, ['1.21.5']],
  [771, ['1.21.6']], [772, ['1.21.7', '1.21.8']], [773, ['1.21.9', '1.21.10']], [774, ['1.21.11']],
  [775, ['26.1', '26.1.1', '26.1.2']], [776, ['26.2']], [777, ['26.3']],
].flatMap(([protocol, versions]) => (versions as string[]).map((version): [string, number] => [version, protocol as number])));

export function minecraftReleaseProtocol(version: string): number | null {
  return RELEASE_PROTOCOLS.get(version.replace(/^(1\.(?:19|20|21)|26\.[123])\.0$/, '$1')) ?? null;
}
