package api

import (
	"hash/maphash"
	"sync"
)

// snippetCacheGeneration bounds each generation of snippetCache; the cache
// holds at most twice as many snippets.
const snippetCacheGeneration = 2048

// snippetCache remembers the snippets of recently converted memo contents,
// keyed by a hash of the content. A snippet read from the previous generation
// moves to the current one, and a full current generation replaces the
// previous one, so contents that keep being listed stay cached.
type snippetCache struct {
	mu       sync.Mutex
	seed     maphash.Seed
	current  map[snippetCacheKey]string
	previous map[snippetCacheKey]string
}

type snippetCacheKey struct {
	hash   uint64
	length int
}

// lookup returns the cached snippet of content, and the key to store it under
// when there is none.
func (c *snippetCache) lookup(content string) (snippetCacheKey, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current == nil {
		c.seed = maphash.MakeSeed()
		c.current = make(map[snippetCacheKey]string, snippetCacheGeneration)
	}
	key := snippetCacheKey{hash: maphash.String(c.seed, content), length: len(content)}
	if snippet, ok := c.current[key]; ok {
		return key, snippet, true
	}
	snippet, ok := c.previous[key]
	if ok {
		c.putLocked(key, snippet)
	}
	return key, snippet, ok
}

func (c *snippetCache) put(key snippetCacheKey, snippet string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putLocked(key, snippet)
}

func (c *snippetCache) putLocked(key snippetCacheKey, snippet string) {
	if len(c.current) >= snippetCacheGeneration {
		c.previous = c.current
		c.current = make(map[snippetCacheKey]string, snippetCacheGeneration)
	}
	c.current[key] = snippet
}
