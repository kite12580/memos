// Package recent provides a bounded in-memory cache that keeps the entries
// read or written most recently.
//
// Entries live in two generations of at most size entries each. A write goes
// to the current generation; when it is full, it becomes the previous
// generation and the oldest one is dropped. A read from the previous
// generation copies the entry into the current one, so entries that keep
// being read survive any number of generations.
package recent

import "sync"

// Cache is safe for concurrent use.
type Cache[K comparable, V any] struct {
	mu       sync.Mutex
	size     int
	current  map[K]V
	previous map[K]V
}

// New returns a cache holding between size and 2*size entries once full.
func New[K comparable, V any](size int) *Cache[K, V] {
	return &Cache[K, V]{size: max(size, 1), current: make(map[K]V, size)}
}

// Get returns the value stored under key.
func (c *Cache[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if value, ok := c.current[key]; ok {
		return value, true
	}
	value, ok := c.previous[key]
	if ok {
		c.putLocked(key, value)
	}
	return value, ok
}

// Put stores value under key.
func (c *Cache[K, V]) Put(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putLocked(key, value)
}

func (c *Cache[K, V]) putLocked(key K, value V) {
	if _, ok := c.current[key]; !ok && len(c.current) >= c.size {
		c.previous = c.current
		c.current = make(map[K]V, c.size)
	}
	c.current[key] = value
}
