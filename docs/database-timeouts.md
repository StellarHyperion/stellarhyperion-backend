# Database timeout policy

The shared database pool applies bounded PostgreSQL timeouts to every
connection. Public statements default to a 30-second `statement_timeout` and a
5-second `lock_timeout`, preventing diagnostics and read APIs from holding
connections or waiting indefinitely on a conflicting writer.

Indexer and maintenance transactions use a separate 60-second statement
window while retaining the 5-second lock-wait bound. This allows a page of
events to commit atomically without making lock contention unbounded. The
values can be overridden through `Database.open` options for a deployment that
has measured different limits.

PostgreSQL timeout codes are normalized to credential-free errors before they
leave the database layer as `DatabaseTimeoutError` with a `statement` or `lock` kind.
Transaction timeout setup uses `SET LOCAL`, allowing callers to establish a repeatable-read snapshot before querying data. Callers can report a timeout outcome without logging
connection strings, SQL parameters, or provider responses.

Pool admission reserves capacity for foreground reads, bounds the waiting queue,
and applies one acquisition deadline across both admission and PostgreSQL connect.
Queued cancellations are removed immediately. If a connect finishes after its caller
times out, its permit remains reserved until that connection is released; this prevents
late connections from growing PostgreSQL's internal queue. Saturated acquisition
returns a retryable HTTP 503 with Retry-After.
