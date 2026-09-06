export const isDesktopRuntime = Boolean(window.lafryhiDesktop);

export async function openDesktopVideo(filePath: string): Promise<void> {
  if (!window.lafryhiDesktop) throw new Error("Desktop video opening is unavailable in this browser.");
  const error = await window.lafryhiDesktop.openVideo(filePath);
  if (error) throw new Error(error);
}
