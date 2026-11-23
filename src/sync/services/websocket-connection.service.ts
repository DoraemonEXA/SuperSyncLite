import { scope } from '../../context';
export const getWsConnectionService = () => ({
  notifyNewOps(_user: number, client: string, seq: number) {
    scope.getStore()?.notify?.(client, seq);
  },
});
