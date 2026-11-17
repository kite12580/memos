package api

import (
	"hash/maphash"
	"slices"

	"google.golang.org/protobuf/proto"

	"github.com/usememos/memos/internal/recent"
	"github.com/usememos/memos/markdown"
)

const extractionCacheSize = 64

// extractionCachingService remembers ExtractAll results by content: saving a
// memo extracts the same content for its payload, its managed images and its
// mentions. Callers get their own copy of each result.
type extractionCachingService struct {
	markdown.Service
	seed      maphash.Seed
	extracted *recent.Cache[snippetCacheKey, *markdown.ExtractedData]
}

func newExtractionCachingService(service markdown.Service) *extractionCachingService {
	return &extractionCachingService{
		Service:   service,
		seed:      maphash.MakeSeed(),
		extracted: recent.New[snippetCacheKey, *markdown.ExtractedData](extractionCacheSize),
	}
}

func (s *extractionCachingService) ExtractAll(content []byte) (*markdown.ExtractedData, error) {
	key := snippetCacheKey{hash: maphash.Bytes(s.seed, content), length: len(content)}
	if data, ok := s.extracted.Get(key); ok {
		return cloneExtractedData(data), nil
	}
	data, err := s.Service.ExtractAll(content)
	if err != nil {
		return nil, err
	}
	s.extracted.Put(key, cloneExtractedData(data))
	return data, nil
}

func cloneExtractedData(data *markdown.ExtractedData) *markdown.ExtractedData {
	clone := &markdown.ExtractedData{
		Tags:                               slices.Clone(data.Tags),
		Mentions:                           slices.Clone(data.Mentions),
		ImageDestinations:                  slices.Clone(data.ImageDestinations),
		ManagedAttachmentReferences:        slices.Clone(data.ManagedAttachmentReferences),
		InvalidManagedAttachmentReferences: slices.Clone(data.InvalidManagedAttachmentReferences),
	}
	if data.Property != nil {
		clone.Property = proto.CloneOf(data.Property)
	}
	return clone
}
