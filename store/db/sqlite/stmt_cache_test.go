package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func openStmtCacheTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "stmt.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec("CREATE TABLE t (v INTEGER)")
	require.NoError(t, err)
	_, err = db.Exec("INSERT INTO t VALUES (1), (2), (3)")
	require.NoError(t, err)
	return db
}

func queryCount(t *testing.T, cache *stmtCache, query string, args ...any) int {
	t.Helper()
	rows, err := cache.query(context.Background(), query, args...)
	require.NoError(t, err)
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	require.NoError(t, rows.Err())
	return count
}

func TestStmtCacheReusesAndEvictsStatements(t *testing.T) {
	cache := newStmtCache(openStmtCacheTestDB(t))
	defer cache.close()

	require.Equal(t, 2, queryCount(t, cache, "SELECT v FROM t WHERE v > ?", 1))
	first := cache.entries["SELECT v FROM t WHERE v > ?"]
	require.Equal(t, 1, queryCount(t, cache, "SELECT v FROM t WHERE v > ?", 2))
	require.Same(t, first, cache.entries["SELECT v FROM t WHERE v > ?"])

	for i := range stmtCacheSize {
		queryCount(t, cache, fmt.Sprintf("SELECT v FROM t WHERE v > %d", i))
	}
	require.Len(t, cache.entries, stmtCacheSize)
	require.NotContains(t, cache.entries, "SELECT v FROM t WHERE v > ?")
	require.True(t, first.evicted)
	require.Equal(t, 0, first.users)
}

func TestStmtCacheRowsOutliveEviction(t *testing.T) {
	cache := newStmtCache(openStmtCacheTestDB(t))
	defer cache.close()

	rows, err := cache.query(context.Background(), "SELECT v FROM t ORDER BY v")
	require.NoError(t, err)
	defer rows.Close()
	for i := range stmtCacheSize {
		queryCount(t, cache, fmt.Sprintf("SELECT v FROM t WHERE v <> %d", i))
	}

	var values []int
	for rows.Next() {
		var v int
		require.NoError(t, rows.Scan(&v))
		values = append(values, v)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []int{1, 2, 3}, values)
}

func TestStmtCacheConcurrentQueries(t *testing.T) {
	cache := newStmtCache(openStmtCacheTestDB(t))
	defer cache.close()

	var wg sync.WaitGroup
	for worker := range 8 {
		wg.Go(func() {
			for i := range 200 {
				// More distinct queries than the cache holds, so entries are
				// evicted while other workers use them.
				query := fmt.Sprintf("SELECT v FROM t WHERE v >= ? AND %d = %d", (worker+i)%(stmtCacheSize*2), (worker+i)%(stmtCacheSize*2))
				count, err := countRows(cache, query, 1)
				if err != nil {
					t.Error(err)
					return
				}
				if count != 3 {
					t.Errorf("got %d rows, want 3", count)
					return
				}
			}
		})
	}
	wg.Wait()
}

func countRows(cache *stmtCache, query string, args ...any) (int, error) {
	rows, err := cache.query(context.Background(), query, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	return count, rows.Err()
}
