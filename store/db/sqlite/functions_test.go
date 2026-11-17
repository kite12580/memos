package sqlite

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func TestRegexpFunctionMatches(t *testing.T) {
	require.NoError(t, ensureRegexpRegistered())

	re, err := compileRegexp(`^v\d+$`)
	require.NoError(t, err)
	require.True(t, re.MatchString("v12"))
	require.False(t, re.MatchString("version"))

	// Caching returns the same compiled instance.
	re2, err := compileRegexp(`^v\d+$`)
	require.NoError(t, err)
	require.Same(t, re, re2)

	_, err = compileRegexp(`(`)
	require.Error(t, err)
}

func TestRegexpCacheStaysBounded(t *testing.T) {
	regexpCache.Clear()
	regexpCacheSize.Store(0)
	for i := range maxRegexpCacheEntries * 3 {
		_, err := compileRegexp(fmt.Sprintf(`^pattern-%d$`, i))
		require.NoError(t, err)
		require.LessOrEqual(t, regexpCacheSize.Load(), int64(maxRegexpCacheEntries))
	}
	count := 0
	regexpCache.Range(func(_, _ any) bool { count++; return true })
	require.LessOrEqual(t, count, maxRegexpCacheEntries)
}

func TestFoldCaseMatchesUnicodeFolding(t *testing.T) {
	t.Parallel()
	var ascii strings.Builder
	for b := range utf8.RuneSelf {
		ascii.WriteByte(byte(b))
	}
	for _, value := range []string{ascii.String(), "Hello World #Tag", "already lower", "Straße KELVIN K", "ÀÉÎ mixed ASCII"} {
		require.Equal(t, unicodeFold.String(value), foldCase(value), value)
	}
}
