import { CallbackFunction, MiddlewareFunction } from '@enkryptcom/types';
import type BitcoinProvider from '..';
import { ProviderRPCRequest } from '@/types/provider';
import { WindowPromise } from '@/libs/window-promise';
import AccountState from '../libs/accounts-state';
import { getCustomError } from '@/libs/error';
import openOnboard from '@/libs/utils/open-onboard';
import { throttle } from 'lodash';

let isAccountAccessPending = false;
const throttledOpenOnboard = throttle(() => openOnboard(), 10000);
const pendingPromises: {
  payload: ProviderRPCRequest;
  res: CallbackFunction;
}[] = [];
const method: MiddlewareFunction = async function (
  this: BitcoinProvider,
  payload: ProviderRPCRequest,
  res,
  next,
): Promise<void> {
  if (payload.method !== 'btc_requestAccounts') return next();
  else {
    if (isAccountAccessPending) {
      pendingPromises.push({
        payload,
        res,
      });
      return;
    }
    isAccountAccessPending = true;
    const isInitialized = await this.KeyRing.isInitialized();
    const handleRemainingPromises = () => {
      isAccountAccessPending = false;
      if (pendingPromises.length) {
        const promi = pendingPromises.pop();
        if (promi) handleAccountAccess(promi.payload, promi.res);
      }
    };
    const handleAccountAccess = (
      _payload: ProviderRPCRequest,
      _res: CallbackFunction,
    ) => {
      if (_payload.options && _payload.options.domain) {
        isAccountAccessPending = true;
        if (!isInitialized) {
          _res(getCustomError('Enkrypt not initialized'));
          throttledOpenOnboard();
          return handleRemainingPromises();
        }
        const accountsState = new AccountState();
        accountsState
          .getApprovedAddresses(_payload.options.domain)
          .then(accounts => {
            if (accounts.length) {
              _res(null, [
                accounts.map(acc => this.network.displayAddress(acc))[0],
              ]);
              handleRemainingPromises();
            } else {
              const windowPromise = new WindowPromise();
              windowPromise
                .getResponse(
                  this.getUIPath(this.UIRoutes.btcConnectDApp.path),
                  JSON.stringify({
                    ..._payload,
                    params: [this.network.name],
                  }),
                )
                .then(({ error, result }) => {
                  if (error) _res(error as any);
                  const accounts = JSON.parse(result || '[]');
                  _res(
                    null,
                    accounts.map((acc: string) =>
                      this.network.displayAddress(acc),
                    ),
                  );
                })
                .finally(handleRemainingPromises);
            }
          });
      } else {
        _res(getCustomError('No domain set!'));
      }
    };
    handleAccountAccess(payload, res);
  }
};
export default method;
