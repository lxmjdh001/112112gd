export interface ChatMessage {
  id: string;
  row: HTMLElement;
  textNode: HTMLElement;
  text: string;
  outgoing: boolean;
}
export interface ChatAdapter {
  name: string;
  customer(): { identifier: string; name: string } | null;
  editor(): HTMLElement | null;
  footer(): HTMLElement | null;
  read(box: HTMLElement): string;
  messages(): ChatMessage[];
  sendButton(): HTMLElement | undefined;
  canSend(): boolean;
  send(): void;
  isSendKey(event: KeyboardEvent): boolean;
  isComposerEvent(event: Event): boolean;
}
