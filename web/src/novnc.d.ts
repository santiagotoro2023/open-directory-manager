// noVNC ships no typings; this is the part of RFB the console uses.
declare module "@novnc/novnc/lib/rfb.js" {
  export interface RFBOptions {
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
