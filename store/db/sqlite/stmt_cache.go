package sqlite

import (
	"context"
	"database/sql"
	"sync"
)

// stmtCacheSize bounds the prepared statements kept by a stmtCache. Each one is
// prepared again on every connection that runs it.
const stmtCacheSize = 32

// stmtCache keeps the most recently used prepared statements by query text, so
// a query that repeats is parsed once per connection instead of on every call.
type stmtCache struct {
	db *sql.DB

	mu      sync.Mutex
	entries map[string]*cachedStmt
	clock   uint64
}

type cachedStmt struct {
	query    string
	stmt     *sql.Stmt
	lastUsed uint64
	// users counts the callers between acquire and release; an evicted
	// statement is closed once it has none.
	users   int
	evicted bool
}

func newStmtCache(db *sql.DB) *stmtCache {
	return &stmtCache{db: db, entries: map[string]*cachedStmt{}}
}

// query runs query as a cached prepared statement. The caller closes the rows,
// which keep the statement open until then, even if it is evicted meanwhile.
func (c *stmtCache) query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	entry, err := c.acquire(ctx, query)
	if err != nil {
		return nil, err
	}
	defer c.release(entry)
	return entry.stmt.QueryContext(ctx, args...) //nolint:sqlclosecheck // The caller closes the rows.
}

func (c *stmtCache) acquire(ctx context.Context, query string) (*cachedStmt, error) {
	if entry := c.use(query); entry != nil {
		return entry, nil
	}

	stmt, err := c.db.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if entry := c.useLocked(query); entry != nil {
		// Another caller prepared it first.
		_ = stmt.Close() //nolint:sqlclosecheck // The duplicate is discarded here.
		return entry, nil
	}
	c.clock++
	entry := &cachedStmt{query: query, stmt: stmt, lastUsed: c.clock, users: 1}
	c.entries[query] = entry
	if len(c.entries) > stmtCacheSize {
		c.evictOldestLocked()
	}
	return entry, nil
}

func (c *stmtCache) use(query string) *cachedStmt {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.useLocked(query)
}

func (c *stmtCache) useLocked(query string) *cachedStmt {
	entry, ok := c.entries[query]
	if !ok {
		return nil
	}
	c.clock++
	entry.lastUsed = c.clock
	entry.users++
	return entry
}

func (c *stmtCache) evictOldestLocked() {
	var oldest *cachedStmt
	for _, entry := range c.entries {
		if oldest == nil || entry.lastUsed < oldest.lastUsed {
			oldest = entry
		}
	}
	delete(c.entries, oldest.query)
	oldest.evicted = true
	if oldest.users == 0 {
		_ = oldest.stmt.Close()
	}
}

func (c *stmtCache) release(entry *cachedStmt) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry.users--
	if entry.evicted && entry.users == 0 {
		_ = entry.stmt.Close()
	}
}

// close closes every cached statement; the cache must not be used afterwards.
func (c *stmtCache) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, entry := range c.entries {
		_ = entry.stmt.Close()
	}
	c.entries = map[string]*cachedStmt{}
}
