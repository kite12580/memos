package jpegmeta

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"slices"
	"testing"

	"github.com/disintegration/imaging"
	"github.com/stretchr/testify/require"
)

// Both fixtures carry EXIF (orientation 6, a camera make and GPS), XMP, an ICC
// profile, a comment, and trailing data. One is progressive, the other is
// baseline with restart markers.
func TestStripRemovesMetadataAndKeepsImageData(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"progressive_metadata.jpg", "restart_metadata.jpg"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			testStripFixture(t, "testdata/"+name)
		})
	}
}

func testStripFixture(t *testing.T, path string) {
	t.Helper()
	original, err := os.ReadFile(path)
	require.NoError(t, err)
	for _, marker := range []string{"MEMOS-CAMERA-MAKER", "MEMOS-XMP-GPS", "ICC_PROFILE", "MEMOS-COMMENT", "MEMOS-TRAILER-PREVIEW"} {
		require.Contains(t, string(original), marker)
	}

	var stripped bytes.Buffer
	require.NoError(t, Strip(bytes.NewReader(original), &stripped))
	for _, marker := range []string{"MEMOS-CAMERA-MAKER", "MEMOS-XMP-GPS", "ICC_PROFILE", "MEMOS-COMMENT", "MEMOS-TRAILER-PREVIEW"} {
		require.NotContains(t, stripped.String(), marker)
	}

	want, err := jpeg.Decode(bytes.NewReader(original))
	require.NoError(t, err)
	got, err := jpeg.Decode(bytes.NewReader(stripped.Bytes()))
	require.NoError(t, err)
	require.Equal(t, want, got)

	require.Equal(t, 6, Orientation(bytes.NewReader(original)))
	require.Equal(t, 6, Orientation(bytes.NewReader(stripped.Bytes())))
	oriented, err := imaging.Decode(bytes.NewReader(stripped.Bytes()), imaging.AutoOrientation(true))
	require.NoError(t, err)
	require.Equal(t, image.Rect(0, 0, 48, 64), oriented.Bounds())
}

func TestStripDropsDefaultOrientation(t *testing.T) {
	t.Parallel()
	original := encodeTestJPEG(t, segment(0xE1, []byte("Exif\x00\x00II\x2A\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00")))

	var stripped bytes.Buffer
	require.NoError(t, Strip(bytes.NewReader(original), &stripped))
	require.NotContains(t, stripped.String(), "Exif")
	require.Equal(t, 1, Orientation(bytes.NewReader(original)))
	require.Equal(t, 0, Orientation(bytes.NewReader(stripped.Bytes())))
	_, err := jpeg.Decode(bytes.NewReader(stripped.Bytes()))
	require.NoError(t, err)
}

func TestRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	require.ErrorIs(t, Strip(bytes.NewReader([]byte("not an image")), &bytes.Buffer{}), ErrNotJPEG)
	require.Equal(t, 0, Orientation(bytes.NewReader([]byte("not an image"))))

	original, err := os.ReadFile("testdata/progressive_metadata.jpg")
	require.NoError(t, err)
	end := bytes.LastIndex(original, []byte{0xFF, 0xD9})
	for size := range end + 1 {
		require.Error(t, Strip(bytes.NewReader(original[:size]), &bytes.Buffer{}), "truncated to %d bytes", size)
		Orientation(bytes.NewReader(original[:size]))
	}
	require.Error(t, Strip(bytes.NewReader([]byte{0xFF, 0xD8, 0xFF, 0xD9}), &bytes.Buffer{}))
}

// encodeTestJPEG encodes a small JPEG with extra inserted after SOI.
func encodeTestJPEG(t *testing.T, extra []byte) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 8))
	for y := range 8 {
		for x := range 16 {
			img.Set(x, y, color.RGBA{R: uint8(x * 16), G: uint8(y * 32), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}))
	encoded := buf.Bytes()
	return slices.Concat(encoded[:2], extra, encoded[2:])
}

func segment(marker byte, payload []byte) []byte {
	length := len(payload) + 2
	return append([]byte{0xFF, marker, byte(length >> 8), byte(length)}, payload...)
}
