CREATE UNIQUE INDEX cycle_leases_one_running_owner
ON cycle_leases(owner_id)
WHERE status = 'RUNNING';
