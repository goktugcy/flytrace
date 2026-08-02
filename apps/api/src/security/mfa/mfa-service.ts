import { AppError, type Clock } from '@flytrace/shared';
import {
  type CodeHasher,
  generateBackupCodes,
  scryptCodeHasher,
  verifyCode,
} from './backup-codes.ts';
import { generateSecret, otpauthUri, verifyTotp } from './totp.ts';

/**
 * MFA (TOTP) enrolment + verification service (docs/15 §7a). Pure of HTTP and
 * persistence: all storage goes through the injected {@link MfaRepo} (an
 * in-memory fake drives the tests; the drizzle impl is described in the
 * manifest). Time is injected via {@link Clock} so token windows are testable.
 */

/** Persisted MFA state for one user. */
export interface UserMfaRecord {
  userId: string;
  secret: string;
  enabled: boolean;
  confirmedAt: Date | null;
}

/** A stored (hashed) backup code that has not yet been consumed. */
export interface BackupCodeRecord {
  id: string;
  codeHash: string;
}

/** Persistence port for MFA. The drizzle impl lives in packages/db (manifest). */
export interface MfaRepo {
  getUserMfa(userId: string): Promise<UserMfaRecord | null>;
  /** Create or replace the (unconfirmed) secret for a user; resets enabled=false. */
  upsertSecret(userId: string, secret: string): Promise<void>;
  /** Flip the user's MFA to enabled, stamping confirmedAt. */
  setEnabled(userId: string, confirmedAt: Date): Promise<void>;
  /** Remove all MFA state (secret + backup codes) for a user. */
  deleteMfa(userId: string): Promise<void>;
  /** Replace all backup codes for a user with a fresh batch. */
  replaceBackupCodes(userId: string, codeHashes: string[]): Promise<void>;
  /** List unused backup codes for a user. */
  listActiveBackupCodes(userId: string): Promise<BackupCodeRecord[]>;
  /** Mark a backup code consumed (one-time use). False means it was already consumed. */
  markBackupCodeUsed(id: string, usedAt: Date): Promise<boolean>;
}

export interface MfaServiceDeps {
  repo: MfaRepo;
  clock: Clock;
  hasher?: CodeHasher | undefined;
  issuer?: string | undefined;
  backupCodeCount?: number | undefined;
  totpStep?: number | undefined;
  totpDigits?: number | undefined;
  totpWindow?: number | undefined;
}

export interface EnrollmentStart {
  secret: string;
  otpauthUri: string;
}

export interface EnrollmentConfirmed {
  backupCodes: string[];
}

export type VerifyMethod = 'totp' | 'backup_code';

const DEFAULT_ISSUER = 'FlyTrace';

export class MfaService {
  private readonly hasher: CodeHasher;
  private readonly issuer: string;
  private readonly backupCodeCount: number;
  private readonly step: number;
  private readonly digits: number;
  private readonly window: number;

  constructor(private readonly deps: MfaServiceDeps) {
    this.hasher = deps.hasher ?? scryptCodeHasher;
    this.issuer = deps.issuer ?? DEFAULT_ISSUER;
    this.backupCodeCount = deps.backupCodeCount ?? 10;
    this.step = deps.totpStep ?? 30;
    this.digits = deps.totpDigits ?? 6;
    this.window = deps.totpWindow ?? 1;
  }

  private nowSeconds(): number {
    return Math.floor(this.deps.clock.now() / 1000);
  }

  /**
   * Whether the user has completed MFA enrolment. Read by the sign-in flow to
   * decide between "issue a session" and "issue a challenge"; a storage error
   * must NOT be swallowed here — the caller fails the sign-in closed rather
   * than skipping the second factor.
   */
  async isEnabled(userId: string): Promise<boolean> {
    const record = await this.deps.repo.getUserMfa(userId);
    return record?.enabled === true;
  }

  /** Step 1: mint a secret and return it + the otpauth URI for QR display. */
  async beginEnrollment(userId: string, account?: string): Promise<EnrollmentStart> {
    const secret = generateSecret();
    await this.deps.repo.upsertSecret(userId, secret);
    return {
      secret,
      otpauthUri: otpauthUri(secret, {
        issuer: this.issuer,
        account: account ?? userId,
        digits: this.digits,
        step: this.step,
      }),
    };
  }

  /** Step 2: confirm a token, enable MFA, and issue one-time backup codes. */
  async confirmEnrollment(userId: string, token: string): Promise<EnrollmentConfirmed> {
    const record = await this.deps.repo.getUserMfa(userId);
    if (!record) throw new AppError('BAD_REQUEST', 'no MFA enrolment in progress');
    const ok = verifyTotp(record.secret, token, {
      window: this.window,
      step: this.step,
      digits: this.digits,
      t: this.nowSeconds(),
    });
    if (!ok) throw new AppError('UNAUTHENTICATED', 'invalid TOTP code');

    await this.deps.repo.setEnabled(userId, new Date(this.deps.clock.now()));
    const codes = generateBackupCodes(this.backupCodeCount);
    const hashes = await Promise.all(codes.map((c) => this.hasher.hash(c)));
    await this.deps.repo.replaceBackupCodes(userId, hashes);
    return { backupCodes: codes };
  }

  async regenerateBackupCodes(userId: string): Promise<EnrollmentConfirmed> {
    const record = await this.deps.repo.getUserMfa(userId);
    if (!record || !record.enabled) {
      throw new AppError('BAD_REQUEST', 'MFA is not enabled for this user');
    }
    const codes = generateBackupCodes(this.backupCodeCount);
    const hashes = await Promise.all(codes.map((c) => this.hasher.hash(c)));
    await this.deps.repo.replaceBackupCodes(userId, hashes);
    return { backupCodes: codes };
  }

  /**
   * Verify a login-time challenge with either a TOTP token or a backup code.
   * Backup codes are consumed (one-time). Returns which method succeeded.
   */
  async verify(userId: string, tokenOrBackupCode: string): Promise<VerifyMethod> {
    const record = await this.deps.repo.getUserMfa(userId);
    if (!record || !record.enabled) {
      throw new AppError('BAD_REQUEST', 'MFA is not enabled for this user');
    }

    const candidate = tokenOrBackupCode.trim();
    const totpOk = verifyTotp(record.secret, candidate, {
      window: this.window,
      step: this.step,
      digits: this.digits,
      t: this.nowSeconds(),
    });
    if (totpOk) return 'totp';

    const active = await this.deps.repo.listActiveBackupCodes(userId);
    for (const entry of active) {
      if (await verifyCode(candidate, entry.codeHash, this.hasher)) {
        const consumed = await this.deps.repo.markBackupCodeUsed(
          entry.id,
          new Date(this.deps.clock.now()),
        );
        if (consumed) return 'backup_code';
      }
    }
    throw new AppError('UNAUTHENTICATED', 'invalid MFA code');
  }

  /** Disable MFA entirely: drop the secret and all backup codes. */
  async disable(userId: string): Promise<void> {
    await this.deps.repo.deleteMfa(userId);
  }
}
