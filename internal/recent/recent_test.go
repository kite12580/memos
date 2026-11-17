package recent

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCacheKeepsEntriesThatAreRead(t *testing.T) {
	cache := New[int, string](2)
	cache.Put(1, "one")
	cache.Put(2, "two")

	// A third entry starts a new generation; 1 and 2 move to the previous one.
	cache.Put(3, "three")
	value, ok := cache.Get(1)
	require.True(t, ok)
	require.Equal(t, "one", value)

	// The current generation {3, 1} is full, so 4 drops the generation holding 2.
	cache.Put(4, "four")
	_, ok = cache.Get(2)
	require.False(t, ok)
	for key, want := range map[int]string{1: "one", 3: "three", 4: "four"} {
		value, ok := cache.Get(key)
		require.True(t, ok)
		require.Equal(t, want, value)
	}
}

func TestCacheOverwriteDoesNotRotate(t *testing.T) {
	cache := New[int, string](2)
	cache.Put(1, "one")
	cache.Put(2, "two")
	cache.Put(2, "second two")
	for key := 3; key <= 5; key++ {
		cache.Put(key, "later")
	}

	// Generations were {1, 2}, {3, 4} and {5}: the overwrite did not start one.
	_, ok := cache.Get(2)
	require.False(t, ok)
	_, ok = cache.Get(3)
	require.True(t, ok)
}
