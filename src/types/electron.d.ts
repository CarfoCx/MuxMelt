export interface ElectronAPI {
  getPdfEditorSession: (sessionId: string) => Promise<any>;
  pdfOperation: (options: any) => Promise<any>;
  showNotification: (options: { title: string; body: string }) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  readPdfFile: (path: string) => Promise<Uint8Array>;
  selectFiles: (options?: any) => Promise<string[]>;
  readImagePreview: (path: string) => Promise<string | null>;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
