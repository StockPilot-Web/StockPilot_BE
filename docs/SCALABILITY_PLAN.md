# StockPilot scalability plan — 1,000 stores

## Target

Support 1,000 active stores with tenant isolation, p95 read latency under 500 ms, p95 write latency under 800 ms, HTTP 5xx below 1%, no exhausted database pool, and background queue lag below 30 seconds in steady state.

## Current baseline findings

- Frontend has TanStack Query, but several pages still use independent Zustand fetches and polling.
- Notifications poll every 12 seconds; alerts poll every 8 seconds; Sidebar attention polls every 30 seconds.
- Product and inventory clients default to 500 rows, which is too large for every page refresh at scale.
- `DATABASE_POOL_SIZE` existed in configuration but was not applied to Prisma before Phase 0.
- Decision Engine recompute work is still process-local; it cannot be the durable queue when API replicas are added.

## Phases

1. **Baseline and tenant safety:** apply pool limits, audit heavy queries, cursor pagination, indexes from `EXPLAIN`, request latency metrics, and cross-tenant tests.
2. **Shared frontend data layer:** migrate dashboard/products/inventory/alerts/orders/pricing to TanStack Query; use tenant-scoped query keys and targeted invalidation; remove duplicate polling.
3. **Cache and durable jobs:** choose managed Redis and BullMQ/Redis or SQS; move imports, exports, Decision Engine and notifications to durable workers with retry, backoff, idempotency and dead-letter handling.
4. **Database and infrastructure:** MySQL primary plus read replicas where safe, managed backups/PITR, stateless API replicas behind a load balancer, graceful shutdown and autoscaling.
5. **Observability and load proof:** OpenTelemetry/metrics, dashboards for API/DB/cache/queue, and k6 ramp-up, steady-state, spike and two-hour soak scenarios.

## Immediate Phase 0 change

`backend/src/config/db.ts` now applies `DATABASE_POOL_SIZE` to the Prisma MySQL URL as `connection_limit`. The total pool across all API replicas must remain below the MySQL connection budget.

## Gates before Redis/queue/infrastructure work

- Confirm deployment provider and staging environment.
- Confirm Redis managed service and queue choice.
- Approve new dependencies (`[DEP]`) and any schema/index migrations.
- Define production SLOs, traffic shape and load-test budget.

## Definition of done

The system is not declared ready for 1,000 stores until staging load tests provide p50/p95/p99, 5xx, DB pool saturation, replica lag, cache hit ratio, queue lag, and cross-tenant isolation evidence.
