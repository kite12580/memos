package api

import (
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/usememos/memos/markdown"
)

type countingMarkdownService struct {
	markdown.Service
	extractions int
}

func (s *countingMarkdownService) ExtractAll(content []byte) (*markdown.ExtractedData, error) {
	s.extractions++
	return s.Service.ExtractAll(content)
}

func TestExtractionCachingServiceReturnsIndependentCopies(t *testing.T) {
	counting := &countingMarkdownService{Service: markdown.NewService(markdown.WithTagExtension(), markdown.WithMentionExtension())}
	service := newExtractionCachingService(counting)
	content := []byte("#work @alice\n\n- [ ] task\n\n![](/file/attachments/abc)")

	first, err := service.ExtractAll(content)
	require.NoError(t, err)
	want, err := counting.Service.ExtractAll(content)
	require.NoError(t, err)
	requireSameExtraction(t, want, first)

	first.Tags[0] = "changed"
	first.Property.HasTaskList = false
	second, err := service.ExtractAll(content)
	require.NoError(t, err)
	requireSameExtraction(t, want, second)
	require.Equal(t, 1, counting.extractions)

	_, err = service.ExtractAll([]byte("other"))
	require.NoError(t, err)
	require.Equal(t, 2, counting.extractions)
}

func requireSameExtraction(t *testing.T, want, got *markdown.ExtractedData) {
	t.Helper()
	require.True(t, proto.Equal(want.Property, got.Property))
	wantRest, gotRest := *want, *got
	wantRest.Property, gotRest.Property = nil, nil
	require.Equal(t, wantRest, gotRest)
}
