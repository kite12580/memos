package api

import (
	"hash/maphash"
	"sync"

	"github.com/usememos/memos/internal/recent"
)

const snippetCacheSize = 2048

// snippetCache holds the snippets of recently converted memo contents, keyed
// by a hash of the content.
type snippetCache struct {
	once    sync.Once
	seed    maphash.Seed
	entries *recent.Cache[snippetCacheKey, string]
}

type snippetCacheKey struct {
	hash   uint64
	length int
}

func (c *snippetCache) key(content string) snippetCacheKey {
	c.once.Do(func() {
		c.seed = maphash.MakeSeed()
		c.entries = recent.New[snippetCacheKey, string](snippetCacheSize)
	})
	return snippetCacheKey{hash: maphash.String(c.seed, content), length: len(content)}
}
