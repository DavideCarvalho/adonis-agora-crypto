import type {
  CreateKeyInput,
  CryptoAuditRecord,
  CryptoKeyView,
  CryptoOverview,
  DataKeyInput,
  DataKeyResult,
  DecryptInput,
  DecryptResult,
  EncryptInput,
  EncryptResult,
  ExportKeyResult,
  HmacInput,
  HmacResult,
  KeyPolicyInput,
  OffsetPage,
  PublicKeyResult,
  RewrapInput,
  RewrapResult,
  SignInput,
  SignResult,
  VerifyInput,
  VerifyResult,
  Whoami,
} from '@adonis-agora/crypto-core';
import type {
  AuditListQuery,
  CryptoPrincipal,
  CryptoService,
  ListKeysQuery,
} from './crypto/service.js';

/** The list query both sides accept: paging, free text and the `-field` sort wire format. */
export interface OperationListQuery {
  page?: number;
  size?: number;
  search?: string;
  /** `name`, `-name`, `createdAt`, `-createdAt`, … */
  sort?: string;
}

/**
 * The operations of a crypto server, with no transport in the signature. In-process (standalone and
 * control plane) it calls the service; on a tenant it calls the server over HTTP. Same calls either
 * way, so an app moves from local to central by changing `config/config.ts` only.
 */
export interface CryptoOperations {
  encrypt(input: EncryptInput): Promise<EncryptResult>;
  decrypt(input: DecryptInput): Promise<DecryptResult>;
  rewrap(input: RewrapInput): Promise<RewrapResult>;
  generateDataKey(input: DataKeyInput): Promise<DataKeyResult>;
  sign(input: SignInput): Promise<SignResult>;
  verify(input: VerifyInput): Promise<VerifyResult>;
  hmac(input: HmacInput): Promise<HmacResult>;
  encryptBatch(inputs: readonly EncryptInput[]): Promise<{ results: EncryptResult[] }>;
  decryptBatch(inputs: readonly DecryptInput[]): Promise<{ results: DecryptResult[] }>;
  signBatch(inputs: readonly SignInput[]): Promise<{ results: SignResult[] }>;
  verifyBatch(inputs: readonly VerifyInput[]): Promise<{ results: VerifyResult[] }>;
  listKeys(query?: OperationListQuery): Promise<OffsetPage<CryptoKeyView>>;
  getKey(name: string): Promise<CryptoKeyView>;
  createKey(input: CreateKeyInput): Promise<CryptoKeyView>;
  rotateKey(name: string): Promise<CryptoKeyView>;
  updateKeyPolicy(name: string, input: KeyPolicyInput): Promise<CryptoKeyView>;
  deleteKey(name: string): Promise<{ key: string; deleted: boolean }>;
  exportKey(name: string, version?: number): Promise<ExportKeyResult>;
  publicKey(name: string): Promise<PublicKeyResult>;
  audit(query?: Partial<AuditListQuery>): Promise<OffsetPage<CryptoAuditRecord>>;
  overview(): Promise<CryptoOverview>;
  whoami(): Promise<Whoami> | Whoami;
}

/** The in-process operations: the service, with the principal this process acts as. */
export function localOperations(
  service: CryptoService,
  principal: CryptoPrincipal,
): CryptoOperations {
  const query = (input?: OperationListQuery): ListKeysQuery => {
    const sort = input?.sort === undefined ? undefined : parseSort(input.sort);
    return {
      page: input?.page ?? 1,
      size: input?.size ?? 50,
      ...(input?.search !== undefined ? { search: input.search } : {}),
      ...(sort !== undefined ? { sort } : {}),
    };
  };
  return {
    encrypt: (input) => service.encrypt(principal, input),
    decrypt: (input) => service.decrypt(principal, input),
    rewrap: (input) => service.rewrap(principal, input),
    generateDataKey: (input) => service.generateDataKey(principal, input),
    sign: (input) => service.sign(principal, input),
    verify: (input) => service.verify(principal, input),
    hmac: (input) => service.hmac(principal, input),
    encryptBatch: (items) => service.encryptBatch(principal, items),
    decryptBatch: (items) => service.decryptBatch(principal, items),
    signBatch: (items) => service.signBatch(principal, items),
    verifyBatch: (items) => service.verifyBatch(principal, items),
    listKeys: (input) => service.listKeys(principal, query(input)),
    getKey: (name) => service.getKey(principal, name),
    createKey: (input) => service.createKey(principal, input),
    rotateKey: (name) => service.rotateKey(principal, name),
    updateKeyPolicy: (name, input) => service.updateKeyPolicy(principal, name, input),
    deleteKey: (name) => service.deleteKey(principal, name),
    exportKey: (name, version) => service.exportKey(principal, name, version),
    publicKey: (name) => service.publicKey(principal, name),
    audit: (input) =>
      service.audit(principal, {
        page: input?.page ?? 1,
        size: input?.size ?? 50,
        ...(input?.sort !== undefined ? { sort: input.sort } : {}),
        ...(input?.filters !== undefined ? { filters: input.filters } : {}),
      }),
    overview: () => service.overview(principal),
    whoami: () => service.whoami(principal),
  };
}

/** The remote operations: a typed const of the client, widened to the transport-free interface. */
export function remoteOperations(client: {
  encrypt: CryptoOperations['encrypt'];
  decrypt: CryptoOperations['decrypt'];
  rewrap: CryptoOperations['rewrap'];
  generateDataKey: CryptoOperations['generateDataKey'];
  sign: CryptoOperations['sign'];
  verify: CryptoOperations['verify'];
  hmac: CryptoOperations['hmac'];
  encryptBatch: CryptoOperations['encryptBatch'];
  decryptBatch: CryptoOperations['decryptBatch'];
  signBatch: CryptoOperations['signBatch'];
  verifyBatch: CryptoOperations['verifyBatch'];
  listKeys: CryptoOperations['listKeys'];
  getKey: CryptoOperations['getKey'];
  createKey: CryptoOperations['createKey'];
  rotateKey: CryptoOperations['rotateKey'];
  updateKeyPolicy: CryptoOperations['updateKeyPolicy'];
  deleteKey: CryptoOperations['deleteKey'];
  exportKey: CryptoOperations['exportKey'];
  publicKey: CryptoOperations['publicKey'];
  audit: CryptoOperations['audit'];
  whoami(): Promise<Whoami>;
  overview?: never;
}): CryptoOperations {
  const unsupported = async (): Promise<never> => {
    throw new Error(
      'crypto: `overview` is a console-only read; it is served by the server, not by the client',
    );
  };
  return {
    encrypt: (input) => client.encrypt(input),
    decrypt: (input) => client.decrypt(input),
    rewrap: (input) => client.rewrap(input),
    generateDataKey: (input) => client.generateDataKey(input),
    sign: (input) => client.sign(input),
    verify: (input) => client.verify(input),
    hmac: (input) => client.hmac(input),
    encryptBatch: (inputs) => client.encryptBatch(inputs),
    decryptBatch: (inputs) => client.decryptBatch(inputs),
    signBatch: (inputs) => client.signBatch(inputs),
    verifyBatch: (inputs) => client.verifyBatch(inputs),
    listKeys: (input) =>
      client.listKeys({
        ...(input?.page !== undefined ? { page: input.page } : {}),
        ...(input?.size !== undefined ? { size: input.size } : {}),
        ...(input?.search !== undefined ? { search: input.search } : {}),
        ...(input?.sort !== undefined ? { sort: input.sort } : {}),
      }),
    getKey: (name) => client.getKey(name),
    createKey: (input) => client.createKey(input),
    rotateKey: (name) => client.rotateKey(name),
    updateKeyPolicy: (name, input) => client.updateKeyPolicy(name, input),
    deleteKey: (name) => client.deleteKey(name),
    exportKey: (name, version) => client.exportKey(name, version),
    publicKey: (name) => client.publicKey(name),
    audit: (input) =>
      client.audit({
        ...(input?.page !== undefined ? { page: input.page } : {}),
        ...(input?.size !== undefined ? { size: input.size } : {}),
        ...(input?.sort !== undefined ? { sort: input.sort } : {}),
        ...(input?.filters?.key !== undefined ? { key: input.filters.key } : {}),
        ...(input?.filters?.operation !== undefined ? { operation: input.filters.operation } : {}),
        ...(input?.filters?.result !== undefined ? { result: input.filters.result } : {}),
        ...(input?.filters?.actor !== undefined ? { actor: input.filters.actor } : {}),
      }),
    overview: unsupported,
    whoami: () => client.whoami(),
  };
}

/** `-createdAt` → `{ field: 'createdAt', direction: 'desc' }`, with the console's allow-list. */
function parseSort(sort: string): {
  field: 'name' | 'createdAt' | 'updatedAt';
  direction: 'asc' | 'desc';
} {
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const field = (sort.startsWith('-') ? sort.slice(1) : sort) as 'name' | 'createdAt' | 'updatedAt';
  if (field !== 'name' && field !== 'createdAt' && field !== 'updatedAt') {
    return { field: 'name', direction };
  }
  return { field, direction };
}
