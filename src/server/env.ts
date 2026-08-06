export interface Env {
  ASSETS: Fetcher;
  ROOM_DO: DurableObjectNamespace;
  LOBBY_DO: DurableObjectNamespace;
  BASIC_USER?: string;
  BASIC_PASS?: string;
}
