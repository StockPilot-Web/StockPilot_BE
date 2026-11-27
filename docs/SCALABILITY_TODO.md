# Scalability TODO

- [x] Apply `DATABASE_POOL_SIZE` to Prisma.
- [ ] Audit and paginate heavy product/inventory/order/alert endpoints.
- [ ] Add load-test baseline and thresholds.
- [ ] Migrate shared frontend reads to TanStack Query.
- [ ] Choose and approve Redis/queue provider.
- [ ] Move process-local background work to durable workers.
- [ ] Add indexes only after `EXPLAIN` and migration review.
- [ ] Deploy stateless API replicas behind a load balancer.
- [ ] Run 1,000-store ramp-up, spike and soak tests.
