export type LocalAssetKind = "image" | "voice" | "music" | "narration";
type LocalAsset = { id: string; file: File; url: string; kind: LocalAssetKind; name: string };

const assets = new Map<string, LocalAsset>();

export function registerAsset(file: File, kind: LocalAssetKind): string {
  const id = `local:${kind}:${crypto.randomUUID()}:${encodeURIComponent(file.name)}`;
  assets.set(id, { id, file, url: URL.createObjectURL(file), kind, name: file.name });
  return id;
}

export function getLocalAsset(id?: string | null): LocalAsset | undefined {
  return id ? assets.get(id) : undefined;
}

export function isLocalAsset(id?: string | null): boolean {
  return Boolean(id?.startsWith("local:") && assets.has(id));
}

export function assetUrl(id?: string | null): string {
  return getLocalAsset(id)?.url || "";
}

export function assetName(id?: string | null): string {
  const local = getLocalAsset(id);
  if (local) return local.name;
  return id ? id.split(/[\\/]/).pop() || id : "Not selected";
}

export function releaseLocalAssets(): void {
  for (const asset of assets.values()) URL.revokeObjectURL(asset.url);
  assets.clear();
}

export function localAssetIds(): string[] {
  return [...assets.keys()];
}

export function releaseLocalAssetIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const asset = assets.get(id);
    if (!asset) continue;
    URL.revokeObjectURL(asset.url);
    assets.delete(id);
  }
}
