import BrowserStorage from '../common/browser-storage';
import { InternalStorageNamespace } from '@/types/provider';
import {
  BackupData,
  BackupResponseType,
  BackupType,
  IState,
  StorageKeys,
} from './types';
import PublicKeyRing from '../keyring/public-keyring';
import sendUsingInternalMessengers from '../messenger/internal-messenger';
import { InternalMethods } from '@/types/messenger';
import EthNetwork from '@/providers/ethereum/networks/eth';
import {
  bufferToHex,
  hexToBuffer,
  NACL_VERSION,
  naclEncrypt,
  utf8ToHex,
} from '@enkryptcom/utils';
import { hashPersonalMessage } from '@ethereumjs/util';
import { v4 as uuidv4 } from 'uuid';
import { BACKUP_URL, HEADERS } from './configs';
import { EnkryptAccount, SignerType, WalletType } from '@enkryptcom/types';
import KeyRingBase from '../keyring/keyring';

class BackupState {
  private storage: BrowserStorage;

  constructor() {
    this.storage = new BrowserStorage(InternalStorageNamespace.backupState);
  }

  async getMainWallet(): Promise<EnkryptAccount> {
    const pkr = new PublicKeyRing();
    const allAccounts = await pkr.getAccounts();
    const mainWallet = allAccounts.find(
      acc =>
        acc.walletType === WalletType.mnemonic &&
        acc.pathIndex === 0 &&
        acc.signerType === EthNetwork.signer[0] &&
        acc.basePath === EthNetwork.basePath,
    );
    if (!mainWallet) {
      throw new Error('No main wallet found');
    }
    return mainWallet;
  }

  getBackupSigHash(pubkey: string): string {
    const now = new Date();
    const messageToSign = `${pubkey}-GET-BACKUPS-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}-${now.getUTCDate().toString().padStart(2, '0')}-${now.getUTCFullYear()}`;
    return bufferToHex(
      hashPersonalMessage(hexToBuffer(utf8ToHex(messageToSign))),
    );
  }
  async getBackups(options?: {
    signature: string;
    pubkey: string;
  }): Promise<BackupType[]> {
    let signature: string = '';
    let pubkey: string = '';
    if (options) {
      signature = options.signature;
      pubkey = options.pubkey;
    } else {
      const mainWallet = await this.getMainWallet();
      pubkey = mainWallet.publicKey;
      const msgHash = this.getBackupSigHash(mainWallet.publicKey);
      console.log('get backups signature', msgHash, mainWallet);
      signature = await sendUsingInternalMessengers({
        method: InternalMethods.sign,
        params: [msgHash, mainWallet],
      }).then(res => {
        if (res.error) {
          console.error(res);
          return null;
        } else {
          return JSON.parse(res.result as string);
        }
      });
    }
    if (!signature) {
      console.error('No signature found');
      return [];
    }
    console.log('get backups signature', signature);

    const rawResponse = await fetch(
      `${BACKUP_URL}backups/${pubkey}?signature=${signature}`,
      {
        method: 'GET',
        headers: HEADERS,
      },
    );
    const content: BackupResponseType = await rawResponse.json();
    return content.backups;
  }

  async deleteBackup(userId: string): Promise<boolean> {
    const mainWallet = await this.getMainWallet();
    const now = new Date();
    const messageToSign = `${userId}-DELETE-BACKUP-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}-${now.getUTCDate().toString().padStart(2, '0')}-${now.getUTCFullYear()}`;
    const msgHash = bufferToHex(
      hashPersonalMessage(hexToBuffer(utf8ToHex(messageToSign))),
    );
    const signature = await sendUsingInternalMessengers({
      method: InternalMethods.sign,
      params: [msgHash, mainWallet],
    }).then(res => {
      if (res.error) {
        console.error(res);
        return null;
      } else {
        return JSON.parse(res.result as string);
      }
    });
    if (!signature) {
      console.error('No signature found');
      return false;
    }
    console.log('delete signature', signature);
    return fetch(
      `${BACKUP_URL}backups/${mainWallet.publicKey}/users/${userId}?signature=${signature}`,
      {
        method: 'DELETE',
        headers: HEADERS,
      },
    )
      .then(res => res.json())
      .then(content => {
        if (content.message === 'Ok') {
          return true;
        }
        console.error(content);
        return false;
      });
  }

  async restoreBackup(
    backup: BackupType,
    keyringPassword: string,
  ): Promise<void> {
    const mainWallet = await this.getMainWallet();
    await sendUsingInternalMessengers({
      method: InternalMethods.unlock,
      params: [keyringPassword, false],
    });
    await sendUsingInternalMessengers({
      method: InternalMethods.ethereumDecrypt,
      params: [backup.payload, mainWallet],
    }).then(async res => {
      if (res.error) {
        console.error(res);
        return null;
      } else {
        const kr = new KeyRingBase();
        await kr.unlock(keyringPassword);
        const existingAccounts = await kr.getKeysArray();
        const decryptedBackup: BackupData = JSON.parse(
          JSON.parse(res.result as string),
        );
        console.log(decryptedBackup);
        const highestPathIndex: Record<string, number> = {};
        decryptedBackup.accounts.forEach(acc => {
          const id = `${acc.basePath}###${acc.signerType}`;
          const idx = acc.pathIndex;
          if (!highestPathIndex[id] || highestPathIndex[id] < idx) {
            highestPathIndex[id] = idx;
          }
        });

        console.log(highestPathIndex);
        const getAccountByIndex = (
          accounts: Omit<EnkryptAccount, 'address' | 'publicKey'>[],
          basePath: string,
          signerType: SignerType,
          idx: number,
        ): EnkryptAccount | null => {
          for (const acc of accounts) {
            if (
              acc.basePath === basePath &&
              acc.pathIndex === idx &&
              acc.signerType === signerType
            ) {
              return acc as EnkryptAccount;
            }
          }
          return null;
        };

        for (const key of Object.keys(highestPathIndex)) {
          const [basePath, signerType] = key.split('###');
          for (let i = 0; i <= highestPathIndex[key]; i++) {
            const newAccount = getAccountByIndex(
              decryptedBackup.accounts,
              basePath,
              signerType as SignerType,
              i,
            );
            const existingAccount = getAccountByIndex(
              existingAccounts,
              basePath,
              signerType as SignerType,
              i,
            );
            if (existingAccount && newAccount) {
              console.log('Account already exists, just renaming');
              await kr.renameAccount(existingAccount.address, newAccount.name);
              continue;
            } else if (newAccount) {
              console.log('creating new account', newAccount);
              await kr.saveNewAccount({
                basePath: newAccount.basePath,
                name: newAccount.name,
                signerType: newAccount.signerType,
                walletType: newAccount.walletType,
              });
            } else if (!newAccount) {
              console.log('edge case shouldnt happen', newAccount);
              await kr.saveNewAccount({
                basePath: basePath,
                name: `New Account from backup ${i}`,
                signerType: signerType as SignerType,
                walletType: WalletType.mnemonic,
              });
            }
          }
        }
        await this.setUserId(decryptedBackup.uuid);
      }
    });
  }

  async backup(firstTime: boolean): Promise<boolean> {
    const state = await this.getState();
    if (firstTime && state.lastBackupTime !== 0) {
      return true;
    }
    if (!state.enabled) {
      return true;
    }
    const pkr = new PublicKeyRing();
    const allAccounts = await pkr.getAccounts();
    const mainWallet = await this.getMainWallet();
    const backupData: BackupData = {
      accounts: allAccounts
        .filter(
          acc => !acc.isTestWallet && acc.walletType !== WalletType.privkey,
        )
        .map(acc => {
          return {
            basePath: acc.basePath,
            pathIndex: acc.pathIndex,
            name: acc.name,
            signerType: acc.signerType,
            walletType: acc.walletType,
            isHardware: acc.isHardware,
            HWOptions: acc.HWOptions,
          };
        }),
      uuid: state.userId,
    };
    const encryptPubKey = await sendUsingInternalMessengers({
      method: InternalMethods.getEthereumEncryptionPublicKey,
      params: [mainWallet],
    }).then(res => {
      if (res.error) {
        console.error(res);
        return null;
      } else {
        return JSON.parse(res.result as string);
      }
    });
    if (!encryptPubKey) {
      console.error('No encrypt public key found');
      return false;
    }
    const encryptedStr = naclEncrypt({
      publicKey: encryptPubKey,
      data: JSON.stringify(backupData),
      version: NACL_VERSION,
    });
    const msgHash = bufferToHex(hashPersonalMessage(hexToBuffer(encryptedStr)));
    return sendUsingInternalMessengers({
      method: InternalMethods.sign,
      params: [msgHash, mainWallet],
    }).then(async res => {
      if (res.error) {
        console.error(res);
        return false;
      } else {
        const rawResponse = await fetch(
          `${BACKUP_URL}backups/${mainWallet.publicKey}/users/${state.userId}?signature=${JSON.parse(res.result as string)}`,
          {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
              payload: encryptedStr,
            }),
          },
        );
        const content = await rawResponse.json();
        if (content.message === 'Ok') {
          await this.setState({
            lastBackupTime: new Date().getTime(),
            userId: state.userId,
            enabled: state.enabled,
          });
          return true;
        }
        console.error(content);
        return false;
      }
    });
  }

  async setState(state: IState): Promise<void> {
    return this.storage.set(StorageKeys.backupInfo, state);
  }

  async getState(): Promise<IState> {
    const state = await this.storage.get(StorageKeys.backupInfo);
    if (!state) {
      const newState: IState = {
        lastBackupTime: 0,
        userId: uuidv4(),
        enabled: true,
      };
      await this.setState(newState);
      return newState;
    }
    return state;
  }

  async getLastUpdatedTime(): Promise<Date> {
    const state: IState = await this.getState();
    return new Date(state.lastBackupTime);
  }

  async getUserId(): Promise<string> {
    const state: IState = await this.getState();
    return state.userId;
  }

  async setUserId(userId: string): Promise<void> {
    const state: IState = await this.getState();
    await this.setState({ ...state, userId });
  }

  async disableBackups(): Promise<void> {
    const state: IState = await this.getState();
    await this.setState({ ...state, enabled: false });
  }
  async enableBackups(): Promise<void> {
    const state: IState = await this.getState();
    await this.setState({ ...state, enabled: true });
  }
  async isBackupEnabled(): Promise<boolean> {
    const state: IState = await this.getState();
    return state.enabled;
  }
}

export default BackupState;
