import {
  type Keyring,
  open,
  reseal,
  type SealedStatus,
  seal,
  sealedStatus,
} from '../crypto-kit/index.js';
import type { CryptoStore } from '../store/store.js';
import { keyMaterialAad } from './keyring.js';

export interface MaterialResealReport {
  dryRun: boolean;
  /** Rewrite every version, even one already sealed with the active root key. */
  all: boolean;
  /** Key versions inspected. */
  scanned: number;
  /** Versions re-sealed (in a dry run: versions that would be). */
  resealed: number;
  failed: number;
  /** Status of every version BEFORE the operation. */
  statuses: Record<SealedStatus, number>;
}

const emptyStatuses = (): Record<SealedStatus, number> => ({
  active: 0,
  retired: 0,
  legacy: 0,
  unreadable: 0,
});

/**
 * Re-seals every key version with the keyring's active root key. The keys themselves do not change
 * (names, versions, public halves, ciphertexts all stay); only the envelope around the private
 * material moves to the new root, which is what a `crypto.keys` rotation or a switch to a KMS
 * requires. A dry run only counts.
 */
export async function resealKeyMaterial(
  store: CryptoStore,
  keyring: Keyring,
  options: { dryRun?: boolean; all?: boolean } = {},
): Promise<MaterialResealReport> {
  const report: MaterialResealReport = {
    dryRun: options.dryRun === true,
    all: options.all === true,
    scanned: 0,
    resealed: 0,
    failed: 0,
    statuses: emptyStatuses(),
  };
  for (const partition of await store.partitions()) {
    for (const key of await store.listKeys(partition)) {
      if (key.deletedAt !== undefined) continue;
      for (const version of await store.versions(partition, key.name)) {
        report.scanned += 1;
        const aad = keyMaterialAad(partition, key.name, version.version);
        let status: SealedStatus;
        try {
          status = await sealedStatus(keyring, version.sealed, { aad });
        } catch {
          status = 'unreadable';
        }
        report.statuses[status] += 1;
        if (status === 'unreadable') {
          report.failed += 1;
          continue;
        }
        if (status === 'active' && report.all !== true) continue;
        if (report.dryRun) {
          report.resealed += 1;
          continue;
        }
        try {
          const opened = await open(keyring, version.sealed, { aad });
          const sealed = await seal(keyring, opened, { aad });
          await store.replaceMaterial(partition, key.name, version.version, sealed, version.kid);
          report.resealed += 1;
        } catch {
          report.failed += 1;
        }
      }
    }
  }
  return report;
}

/** How many key versions a root key change would rewrite, without rewriting them. */
export async function materialStatus(
  store: CryptoStore,
  keyring: Keyring,
): Promise<Record<SealedStatus, number>> {
  const report = await resealKeyMaterial(store, keyring, { dryRun: true });
  return report.statuses;
}

export { reseal as resealSealedValue };
