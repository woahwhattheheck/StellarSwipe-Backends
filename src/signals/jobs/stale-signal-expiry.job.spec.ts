import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  Signal,
  SignalOutcome,
  SignalStatus,
} from '../entities/signal.entity';
import {
  DEFAULT_SIGNAL_EXPIRY_TTL_MS,
  StaleSignalExpiryJob,
  isSignalStaleForExpiry,
} from './stale-signal-expiry.job';

describe('stale signal expiry', () => {
  const now = new Date('2026-10-05T21:00:00.000Z');
  const ttlMs = 60_000;

  const signalAt = (
    ageMs: number,
    overrides: Partial<Pick<Signal, 'expiresAt' | 'status'>> = {},
  ): Pick<Signal, 'createdAt' | 'expiresAt' | 'status'> => ({
    createdAt: new Date(now.getTime() - ageMs),
    expiresAt: new Date(now.getTime() + 60_000),
    status: SignalStatus.ACTIVE,
    ...overrides,
  });

  it('keeps a signal just under the TTL boundary', () => {
    expect(isSignalStaleForExpiry(signalAt(ttlMs - 1), now, ttlMs)).toBe(
      false,
    );
  });

  it('expires a signal exactly at the TTL boundary', () => {
    expect(isSignalStaleForExpiry(signalAt(ttlMs), now, ttlMs)).toBe(true);
  });

  it('expires a signal past the TTL boundary', () => {
    expect(isSignalStaleForExpiry(signalAt(ttlMs + 1), now, ttlMs)).toBe(true);
  });

  it('expires an ACTIVE signal whose explicit expiresAt has elapsed', () => {
    const signal = signalAt(1, {
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(isSignalStaleForExpiry(signal, now, ttlMs)).toBe(true);
  });

  it('does not re-expire a non-ACTIVE signal', () => {
    const signal = signalAt(ttlMs + 1, { status: SignalStatus.EXPIRED });
    expect(isSignalStaleForExpiry(signal, now, ttlMs)).toBe(false);
  });
});

describe('StaleSignalExpiryJob', () => {
  const now = new Date('2026-10-05T21:00:00.000Z');
  const execute = jest.fn();
  const queryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute,
  };
  const repository = {
    createQueryBuilder: jest.fn(() => queryBuilder),
  } as unknown as Repository<Signal>;

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue({ affected: 3 });
  });

  it('atomically transitions only ACTIVE stale rows and reports the count', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'SIGNAL_EXPIRY_TTL_MS' ? '60000' : undefined,
      ),
    } as unknown as ConfigService;
    const job = new StaleSignalExpiryJob(repository, config);

    const result = await job.expireStaleSignals(now);
    const cutoff = new Date(now.getTime() - 60_000);

    expect(queryBuilder.set).toHaveBeenCalledWith({
      status: SignalStatus.EXPIRED,
      outcome: SignalOutcome.EXPIRED,
      closedAt: now,
    });
    expect(queryBuilder.where).toHaveBeenCalledWith('status = :active', {
      active: SignalStatus.ACTIVE,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '(created_at <= :cutoff OR expires_at <= :now)',
      { cutoff, now },
    );
    expect(result).toEqual({ expired: 3, cutoff });
  });

  it('uses the sane default TTL when configuration is invalid', async () => {
    const config = {
      get: jest.fn(() => 'not-a-number'),
    } as unknown as ConfigService;
    const job = new StaleSignalExpiryJob(repository, config);

    const result = await job.expireStaleSignals(now);

    expect(result.cutoff).toEqual(
      new Date(now.getTime() - DEFAULT_SIGNAL_EXPIRY_TTL_MS),
    );
  });

  it('is safe for a second replica to observe zero affected rows', async () => {
    execute.mockResolvedValueOnce({ affected: 2 }).mockResolvedValueOnce({
      affected: 0,
    });
    const config = {
      get: jest.fn(() => '60000'),
    } as unknown as ConfigService;
    const job = new StaleSignalExpiryJob(repository, config);

    await expect(job.expireStaleSignals(now)).resolves.toMatchObject({
      expired: 2,
    });
    await expect(job.expireStaleSignals(now)).resolves.toMatchObject({
      expired: 0,
    });
  });
});
