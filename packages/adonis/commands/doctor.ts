import AgoraDoctor from './agora_doctor.js';

/**
 * `node ace crypto:doctor` — the shared `agora:doctor` runner, pre-filtered to this lib. Same
 * checks, same flags (`--deep`, `--json`, `--no-boot`), same exit codes.
 */
export default class CryptoDoctor extends AgoraDoctor {
  static override commandName = 'crypto:doctor';
  static override description = 'Check the crypto configuration (agora:doctor --lib crypto)';
  protected override presetLib: string | undefined = 'crypto';
}
