export class EncryptedOpsNotSupportedError extends Error {
  constructor(readonly encryptedOpCount: number) {
    super('Encrypted operations cannot be replayed');
  }
}
