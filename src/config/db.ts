import { Prisma, PrismaClient } from '@prisma/client';
import { env } from './env';

function applyConnectionLimit(databaseUrl: string, poolSize?: number): string {
  if (!poolSize) return databaseUrl;

  try {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.set('connection_limit', String(poolSize));
    return parsed.toString();
  } catch {
    // env.ts validates that production has a DATABASE_URL; retain the original
    // value if a test adapter uses a non-URL format.
    return databaseUrl;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const databaseUrl = applyConnectionLimit(env.DATABASE_URL, env.DATABASE_POOL_SIZE);
const prismaOptions: Prisma.PrismaClientOptions = {
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  ...(env.DATABASE_POOL_SIZE && databaseUrl
    ? { datasources: { db: { url: databaseUrl } } }
    : {}),
};

const rawPrisma = global.prisma || new PrismaClient(prismaOptions);

const originalTx = rawPrisma.$transaction.bind(rawPrisma);
rawPrisma.$transaction = function (arg: any, options?: any) {
  if (typeof arg === 'function') {
    const defaultOptions = { maxWait: 10_000, timeout: 30_000 };
    return originalTx(arg, { ...defaultOptions, ...options });
  }
  return originalTx(arg, options);
} as any;

export const prisma = rawPrisma;

if (env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
