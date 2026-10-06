import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Signal,
  SignalOutcome,
  SignalStatus,
} from '../entities/signal.entity';

export const DEFAULT_SIGNAL_EXPIRY_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_SIGNAL_EXPIRY_CRON = '0 */5 * * * *';

type SignalExpiryView = Pick<Signal, 'createdAt' | 'expiresAt' | 'status'>;

/**
 * Business-rule helper kept beside the SQL predicate so the TTL boundary is
 * explicit and testable: exactly-at-TTL is stale; just-under-TTL is not.
 *
 * A swipe is persisted as trade/position state, not as a global flag on the
 * Signal. Expiring the ACTIVE signal only prevents future swipes; it does not
 * mutate trades that were already created from the signal.
 */
export function isSignalStaleForExpiry(
  signal: SignalExpiryView,
  now: Date,
  ttlMs: number,
): boolean {
  if (signal.status !== SignalStatus.ACTIVE) return false;

  const cutoffMs = now.getTime() - ttlMs;
  return (
    signal.createdAt.getTime() <= cutoffMs ||
    signal.expiresAt.getTime() <= now.getTime()
  );
}

@Injectable()
export class StaleSignalExpiryJob {
  private readonly logger = new Logger(StaleSignalExpiryJob.name);

  constructor(
    @InjectRepository(Signal)
    private readonly signalRepository: Repository<Signal>,
    private readonly configService: ConfigService,
  ) {}

  @Cron(process.env.SIGNAL_EXPIRY_CRON || DEFAULT_SIGNAL_EXPIRY_CRON, {
    name: 'stale-signal-expiry',
    timeZone: 'UTC',
  })
  async expireStaleSignals(
    now: Date = new Date(),
  ): Promise<{ expired: number; cutoff: Date }> {
    const ttlMs = this.getTtlMs();
    const cutoff = new Date(now.getTime() - ttlMs);

    // One conditional UPDATE is idempotent and replica-safe: if two replicas
    // race, only the one that still observes status=ACTIVE can transition a row.
    const result = await this.signalRepository
      .createQueryBuilder()
      .update(Signal)
      .set({
        status: SignalStatus.EXPIRED,
        outcome: SignalOutcome.EXPIRED,
        closedAt: now,
      })
      .where('status = :active', { active: SignalStatus.ACTIVE })
      // Issue #992 expires stale cards that have not been swiped. Successful
      // swipe execution persists a trade keyed by signal_id, so preserve any
      // signal already consumed by the trade path even if it remains ACTIVE.
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM trades trade WHERE trade.signal_id = signals.id)',
      )
      .andWhere('(created_at <= :cutoff OR expires_at <= :now)', {
        cutoff,
        now,
      })
      .execute();

    const expired = result.affected ?? 0;
    this.logger.log(
      `Stale-signal expiry completed: expired=${expired} ttlMs=${ttlMs} cutoff=${cutoff.toISOString()}`,
    );

    return { expired, cutoff };
  }

  private getTtlMs(): number {
    const configured = this.configService.get<string | number>(
      'SIGNAL_EXPIRY_TTL_MS',
    );
    const parsed = Number(configured);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_SIGNAL_EXPIRY_TTL_MS;
    }

    return Math.floor(parsed);
  }
}
