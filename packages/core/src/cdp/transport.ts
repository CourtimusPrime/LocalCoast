/**
 * The only surface core uses to speak CDP. The desktop host implements this on
 * webContents.debugger via cdp-mux (invariant 4); tests use FakeCdpTransport.
 * `cdpSessionId` addresses flattened auto-attached sub-targets (OOPIFs,
 * workers, service workers); null targets the root session.
 */

export interface CdpEvent {
  cdpSessionId: string | null;
  method: string;
  params: Record<string, unknown>;
}

export type CdpEventListener = (event: CdpEvent) => void;

export interface CdpTransport {
  send(
    cdpSessionId: string | null,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  onEvent(listener: CdpEventListener): () => void;
  close(): Promise<void>;
}
