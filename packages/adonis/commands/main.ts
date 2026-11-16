import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import CryptoDoctor from './doctor.js';
import {
  CryptoKeysCreate,
  CryptoKeysDelete,
  CryptoKeysExport,
  CryptoKeysList,
  CryptoKeysPolicy,
  CryptoKeysPublicKey,
  CryptoKeysReseal,
  CryptoKeysRotate,
  CryptoKeysShow,
} from './keys.js';
import CryptoEncrypt, { CryptoAuditCommand, CryptoDecrypt } from './ops.js';
import {
  CryptoSubjectsBackfill,
  CryptoSubjectsForget,
  CryptoSubjectsRewrapKeys,
} from './subjects.js';

/**
 * The commands of `@adonis-agora/crypto`, registered by `configure` with
 * `rcFile.addCommand('@adonis-agora/crypto/commands')`. They never boot a worker: they use the same
 * service the console and the API use, with `cli:<os user>` as the audit actor.
 */
const loader = new ListLoader([
  CryptoKeysList,
  CryptoKeysShow,
  CryptoKeysCreate,
  CryptoKeysRotate,
  CryptoKeysPolicy,
  CryptoKeysPublicKey,
  CryptoKeysDelete,
  CryptoKeysExport,
  CryptoKeysReseal,
  CryptoEncrypt,
  CryptoDecrypt,
  CryptoAuditCommand,
  CryptoSubjectsBackfill,
  CryptoSubjectsRewrapKeys,
  CryptoSubjectsForget,
  AgoraDoctor,
  CryptoDoctor,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
