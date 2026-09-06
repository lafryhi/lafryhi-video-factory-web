export {};

declare global {
  interface Window {
    lafryhiDesktop?: {
      platform: string;
      openVideo(filePath: string): Promise<string>;
    };
  }
}

