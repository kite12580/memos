package api

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/markdown"
)

func TestSnippetCacheKeepsRecentlyReadSnippets(t *testing.T) {
	var cache snippetCache

	key, _, ok := cache.lookup("first")
	require.False(t, ok)
	cache.put(key, "first snippet")

	for i := range snippetCacheGeneration - 1 {
		key, _, ok := cache.lookup(fmt.Sprint("filler ", i))
		require.False(t, ok)
		cache.put(key, "filler")
	}
	// The next store starts a new generation; "first" is read from the old one
	// and moves into the new one.
	key, _, _ = cache.lookup("rollover")
	cache.put(key, "rollover")
	_, snippet, ok := cache.lookup("first")
	require.True(t, ok)
	require.Equal(t, "first snippet", snippet)

	for i := range snippetCacheGeneration {
		key, _, _ := cache.lookup(fmt.Sprint("second filler ", i))
		cache.put(key, "filler")
	}
	_, _, ok = cache.lookup("filler 0")
	require.False(t, ok)
	_, snippet, ok = cache.lookup("first")
	require.True(t, ok)
	require.Equal(t, "first snippet", snippet)
}

func TestGetMemoContentSnippetMatchesMarkdownService(t *testing.T) {
	service := &APIService{MarkdownService: markdown.NewService()}
	for _, content := range []string{"# Title\n\nBody text", "Body text", ""} {
		want, err := service.MarkdownService.GenerateSnippet([]byte(content), 64)
		require.NoError(t, err)
		for range 2 {
			got, err := service.getMemoContentSnippet(content)
			require.NoError(t, err)
			require.Equal(t, want, got)
		}
	}
}
