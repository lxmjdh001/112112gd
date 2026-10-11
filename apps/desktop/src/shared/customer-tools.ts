export interface CustomerContext {
  accountId: string;
  identifier: string;
  name: string;
  chatId?: string;
}
export interface CustomerProfile {
  identifier: string;
  platform: string;
  details: Record<string, string>;
  language: string;
  version: number;
  tags: string[];
}
export interface QuickAsset {
  id: string;
  kind: "text" | "image";
  scope: "personal" | "team";
  title: string;
  category: string;
  body: string;
  mime: string;
  filename: string;
  version: number;
}
export interface AssetContent {
  kind: "text" | "image";
  data: string;
  mime: string;
  filename: string;
  body: string;
}
