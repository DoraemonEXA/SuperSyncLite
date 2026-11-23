import { AsyncLocalStorage } from 'node:async_hooks';
export interface Settings extends Omit<
  Env,
  'PUBLIC_URL' | 'CORS_ORIGINS' | 'CAPTURE_CONNECTOR_ENABLED'
> {
  AUTH_SECRET: string;
  CAPTURE_OAUTH_CLIENTS?: string;
  CAPTURE_REVIEW_EMAIL?: string;
  CAPTURE_REVIEW_CODE?: string;
  PUBLIC_URL: string;
  CAPTURE_CONNECTOR_ENABLED: string;
  CORS_ORIGINS: string;
}
interface RequestState {
  env: Settings;
  notify?: (client: string, seq: number) => void;
}
export const scope = new AsyncLocalStorage<RequestState>();
export function settings() {
  const state = scope.getStore();
  if (!state) throw new Error('Missing Worker request context');
  return state.env;
}
