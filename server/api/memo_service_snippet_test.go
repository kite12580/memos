package api

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/markdown"
)

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
