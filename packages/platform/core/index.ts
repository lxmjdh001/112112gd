export type PlatformState =
  | "loading"
  | "qr_required"
  | "ready"
  | "network_error"
  | "unknown"
  | "closed";
export interface PlatformAdapter {
  id: string;
  name: string;
  homeURL: string;
  allowedOrigins: readonly string[];
  preload: string;
  capabilities: {
    nativeChat: boolean;
    selectionTranslation: boolean;
    accountIdentity: boolean;
    messageArchive: boolean;
  };
}
